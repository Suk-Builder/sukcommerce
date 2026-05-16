/**
 * 用户服务 — 用户/认证/角色/权限
 * PostgreSQL + Redis Session + bcrypt + JWT
 */
require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const Redis = require('ioredis');

const { createLogger, requestIdMiddleware } = require('../../shared/lib/logger');
const { Errors, errorHandler } = require('../../shared/lib/errors');
const { EventBus, EventTypes } = require('../../shared/lib/events');

const logger = createLogger();
const app = express();
app.use(express.json());
app.use(requestIdMiddleware);

// ─── 数据库 ───
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
});

// ─── Redis ───
const redis = new Redis(process.env.REDIS_URL);

// ─── 事件总线 ───
const eventBus = new EventBus();
eventBus.connect();

// ─── 数据库初始化 ───
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user','seller','admin')),
      status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
      avatar TEXT,
      phone VARCHAR(20),
      email_verified BOOLEAN DEFAULT FALSE,
      phone_verified BOOLEAN DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

    CREATE TABLE IF NOT EXISTS addresses (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      province VARCHAR(50) NOT NULL,
      city VARCHAR(50) NOT NULL,
      district VARCHAR(50) NOT NULL,
      detail TEXT NOT NULL,
      is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  logger.info('UserService DB initialized');
}

// ─── JWT 工具 ───
const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';

function generateTokens(user) {
  const access = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: ACCESS_TTL });
  const refresh = jwt.sign({ userId: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TTL });
  return { access, refresh };
}

// ─── 路由 ───

// 注册
app.post('/register', async (req, res, next) => {
  try {
    const { username, email, password, phone } = req.body;
    if (!username || !email || !password) throw Errors.VALIDATION_ERROR();
    if (password.length < 6) throw new Error('密码至少6位');

    const exists = await pool.query('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email]);
    if (exists.rows.length > 0) throw Errors.USER_EXISTS('用户名或邮箱');

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, phone) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, created_at',
      [username, email, hash, phone]
    );

    const user = result.rows[0];
    const tokens = generateTokens(user);

    // 缓存用户
    await redis.setex(`user:${user.id}`, 3600, JSON.stringify(user));

    // 发布事件
    await eventBus.publish(EventTypes.USER_REGISTERED, { user_id: user.id, username, email });

    res.status(201).json({ user, tokens });
  } catch (err) { next(err); }
});

// 登录
app.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query(
      'SELECT id, username, email, password_hash, role, status, avatar FROM users WHERE username = $1 OR email = $1',
      [username]
    );

    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw Errors.INVALID_CREDENTIALS();
    }
    if (user.status === 'suspended') throw Errors.USER_SUSPENDED();

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    delete user.password_hash;
    const tokens = generateTokens(user);

    await redis.setex(`user:${user.id}`, 3600, JSON.stringify(user));
    await eventBus.publish(EventTypes.USER_LOGIN, { user_id: user.id, username: user.username });

    res.json({ user, tokens });
  } catch (err) { next(err); }
});

// Token 刷新
app.post('/refresh', async (req, res, next) => {
  try {
    const { refresh } = req.body;
    const decoded = jwt.verify(refresh, JWT_SECRET);
    if (decoded.type !== 'refresh') throw Errors.UNAUTHORIZED();

    const result = await pool.query('SELECT id, username, email, role, status FROM users WHERE id = $1', [decoded.userId]);
    const user = result.rows[0];
    if (!user || user.status !== 'active') throw Errors.UNAUTHORIZED();

    const tokens = generateTokens(user);
    res.json({ tokens });
  } catch (err) { next(Errors.TOKEN_EXPIRED()); }
});

// 获取当前用户
app.get('/me', async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw Errors.UNAUTHORIZED();

    const decoded = jwt.verify(token, JWT_SECRET);

    // 先查缓存
    const cached = await redis.get(`user:${decoded.userId}`);
    if (cached) return res.json({ user: JSON.parse(cached) });

    const result = await pool.query(
      'SELECT id, username, email, role, status, avatar, phone, created_at FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (!result.rows[0]) throw Errors.USER_NOT_FOUND();

    await redis.setex(`user:${decoded.userId}`, 3600, JSON.stringify(result.rows[0]));
    res.json({ user: result.rows[0] });
  } catch (err) { next(err); }
});

// 地址管理
app.get('/addresses', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'];
    const result = await pool.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC', [userId]);
    res.json({ addresses: result.rows });
  } catch (err) { next(err); }
});

app.post('/addresses', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'];
    const { name, phone, province, city, district, detail, is_default } = req.body;
    if (is_default) {
      await pool.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [userId]);
    }
    const result = await pool.query(
      'INSERT INTO addresses (user_id, name, phone, province, city, district, detail, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [userId, name, phone, province, city, district, detail, is_default]
    );
    res.status(201).json({ address: result.rows[0] });
  } catch (err) { next(err); }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ service: 'user-service', status: 'healthy', uptime: process.uptime() });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3001;
initDb().then(() => {
  app.listen(PORT, () => logger.info(`UserService on ${PORT}`));
});

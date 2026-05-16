require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');

const { createLogger, requestIdMiddleware } = require('../../shared/lib/logger');
const { Errors, errorHandler } = require('../../shared/lib/errors');
const { EventBus, EventTypes } = require('../../shared/lib/events');
const { getPool, query, transaction } = require('../../shared/lib/db');
const { validateEmail, validatePhone, validateRequired } = require('../../shared/lib/validate');

const logger = createLogger(process.env.SERVICE_NAME || 'user-service');
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');
const eventBus = new EventBus(process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672');

const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY = '7d';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

const app = express();
app.use(express.json());
app.use(requestIdMiddleware);

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new Errors.UnauthorizedError('Missing or invalid authorization header'));
  }
  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return next(new Errors.UnauthorizedError('Invalid or expired token'));
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new Errors.ForbiddenError('Insufficient permissions'));
    }
    next();
  };
}

// ─── Token Helpers ────────────────────────────────────────────────────────────

function generateTokens(user) {
  const payload = { userId: user.id, username: user.username, role: user.role };
  const access = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
  const refresh = jwt.sign({ userId: user.id, type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
  return { access, refresh };
}

async function storeRefreshToken(userId, token) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);
  await query(
    'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token) DO UPDATE SET expires_at = $3',
    [userId, token, expiresAt]
  );
}

async function removeRefreshToken(token) {
  await query('DELETE FROM refresh_tokens WHERE token = $1', [token]);
}

// ─── Validation Helpers ───────────────────────────────────────────────────────

function validateUsername(username) {
  return typeof username === 'string' && username.length >= 3 && username.length <= 20 && /^[a-zA-Z0-9_]+$/.test(username);
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 50;
}

// ─── Database Init ────────────────────────────────────────────────────────────

async function initDb() {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user','seller','admin')),
      status VARCHAR(20) DEFAULT 'active',
      avatar TEXT,
      phone VARCHAR(20),
      email_verified BOOLEAN DEFAULT FALSE,
      phone_verified BOOLEAN DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
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
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  logger.info('Database initialized: users, addresses, refresh_tokens tables ready');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Register
app.post('/register', async (req, res, next) => {
  try {
    const { username, email, password, phone } = req.body;

    validateRequired({ username, email, password }, ['username', 'email', 'password']);

    if (!validateUsername(username)) {
      throw new Errors.ValidationError('Username must be 3-20 characters, alphanumeric and underscore only');
    }
    if (!validateEmail(email)) {
      throw new Errors.ValidationError('Invalid email format');
    }
    if (!validatePassword(password)) {
      throw new Errors.ValidationError('Password must be 6-50 characters');
    }
    if (phone && !validatePhone(phone)) {
      throw new Errors.ValidationError('Invalid phone format');
    }

    const existing = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2 LIMIT 1',
      [username, email]
    );
    if (existing.rows.length > 0) {
      throw new Errors.ConflictError('Username or email already exists');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await query(
      `INSERT INTO users (username, email, password_hash, phone, email_verified, phone_verified, created_at)
       VALUES ($1, $2, $3, $4, FALSE, FALSE, NOW())
       RETURNING id, username, email, role, status, avatar, phone, email_verified, phone_verified, last_login_at, created_at`,
      [username, email, passwordHash, phone || null]
    );

    const user = result.rows[0];
    const tokens = generateTokens(user);
    await storeRefreshToken(user.id, tokens.refresh);
    await redis.setex(`user:${user.id}`, 3600, JSON.stringify(user));

    await eventBus.publish(EventTypes.USER_REGISTERED, {
      userId: user.id,
      username: user.username,
      email: user.email,
      createdAt: user.created_at
    });

    logger.info(`User registered: ${user.username} (id=${user.id})`);
    res.status(201).json({ user, tokens });
  } catch (err) {
    next(err);
  }
});

// Login
app.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    validateRequired({ username, password }, ['username', 'password']);

    const result = await query(
      `SELECT id, username, email, password_hash, role, status, avatar, phone,
              email_verified, phone_verified, last_login_at, created_at
       FROM users WHERE username = $1 OR email = $1 LIMIT 1`,
      [username]
    );
    if (result.rows.length === 0) {
      throw new Errors.UnauthorizedError('Invalid username or password');
    }

    const user = result.rows[0];

    if (user.status !== 'active') {
      throw new Errors.ForbiddenError('Account is not active');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      throw new Errors.UnauthorizedError('Invalid username or password');
    }

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    user.last_login_at = new Date();

    delete user.password_hash;
    const tokens = generateTokens(user);
    await storeRefreshToken(user.id, tokens.refresh);
    await redis.setex(`user:${user.id}`, 3600, JSON.stringify(user));

    await eventBus.publish(EventTypes.USER_LOGIN, {
      userId: user.id,
      username: user.username,
      loginAt: user.last_login_at
    });

    logger.info(`User logged in: ${user.username} (id=${user.id})`);
    res.json({ user, tokens });
  } catch (err) {
    next(err);
  }
});

// Refresh Token
app.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw new Errors.ValidationError('Refresh token is required');
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, JWT_SECRET);
    } catch {
      throw new Errors.UnauthorizedError('Invalid refresh token');
    }

    if (decoded.type !== 'refresh') {
      throw new Errors.UnauthorizedError('Invalid refresh token');
    }

    const stored = await query(
      'SELECT id FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
      [refreshToken]
    );
    if (stored.rows.length === 0) {
      throw new Errors.UnauthorizedError('Refresh token revoked or expired');
    }

    const result = await query(
      'SELECT id, username, email, role, status, avatar, phone, email_verified, phone_verified, last_login_at, created_at FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (result.rows.length === 0) {
      throw new Errors.UnauthorizedError('User not found');
    }

    const user = result.rows[0];
    if (user.status !== 'active') {
      throw new Errors.ForbiddenError('Account is not active');
    }

    await removeRefreshToken(refreshToken);
    const tokens = generateTokens(user);
    await storeRefreshToken(user.id, tokens.refresh);

    res.json({ tokens });
  } catch (err) {
    next(err);
  }
});

// Get current user
app.get('/me', authenticate, async (req, res, next) => {
  try {
    const { userId } = req.user;

    const cached = await redis.get(`user:${userId}`);
    if (cached) {
      return res.json({ user: JSON.parse(cached) });
    }

    const result = await query(
      `SELECT id, username, email, role, status, avatar, phone,
              email_verified, phone_verified, last_login_at, created_at
       FROM users WHERE id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      throw new Errors.NotFoundError('User not found');
    }

    const user = result.rows[0];
    await redis.setex(`user:${userId}`, 3600, JSON.stringify(user));
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// Get user by ID
app.get('/users/:id', authenticate, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (isNaN(targetId)) {
      throw new Errors.ValidationError('Invalid user ID');
    }

    if (req.user.userId !== targetId && req.user.role !== 'admin') {
      throw new Errors.ForbiddenError('Can only view your own profile or require admin role');
    }

    const result = await query(
      `SELECT id, username, email, role, status, avatar, phone,
              email_verified, phone_verified, last_login_at, created_at
       FROM users WHERE id = $1`,
      [targetId]
    );
    if (result.rows.length === 0) {
      throw new Errors.NotFoundError('User not found');
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Update user
app.put('/users/:id', authenticate, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (isNaN(targetId)) {
      throw new Errors.ValidationError('Invalid user ID');
    }

    if (req.user.userId !== targetId && req.user.role !== 'admin') {
      throw new Errors.ForbiddenError('Can only update your own profile or require admin role');
    }

    const { username, email, phone, avatar } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (username !== undefined) {
      if (!validateUsername(username)) {
        throw new Errors.ValidationError('Username must be 3-20 characters, alphanumeric and underscore only');
      }
      updates.push(`username = $${idx++}`);
      values.push(username);
    }
    if (email !== undefined) {
      if (!validateEmail(email)) {
        throw new Errors.ValidationError('Invalid email format');
      }
      updates.push(`email = $${idx++}`);
      values.push(email);
    }
    if (phone !== undefined) {
      if (phone && !validatePhone(phone)) {
        throw new Errors.ValidationError('Invalid phone format');
      }
      updates.push(`phone = $${idx++}`);
      values.push(phone);
    }
    if (avatar !== undefined) {
      updates.push(`avatar = $${idx++}`);
      values.push(avatar);
    }

    if (updates.length === 0) {
      throw new Errors.ValidationError('No fields to update');
    }

    values.push(targetId);
    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, username, email, role, status, avatar, phone, email_verified, phone_verified, last_login_at, created_at`,
      values
    );
    if (result.rows.length === 0) {
      throw new Errors.NotFoundError('User not found');
    }

    const user = result.rows[0];
    await redis.setex(`user:${user.id}`, 3600, JSON.stringify(user));
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// Change password
app.put('/users/:id/password', authenticate, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (isNaN(targetId)) {
      throw new Errors.ValidationError('Invalid user ID');
    }

    if (req.user.userId !== targetId) {
      throw new Errors.ForbiddenError('Can only change your own password');
    }

    const { oldPassword, newPassword } = req.body;
    validateRequired({ oldPassword, newPassword }, ['oldPassword', 'newPassword']);

    if (!validatePassword(newPassword)) {
      throw new Errors.ValidationError('New password must be 6-50 characters');
    }

    const userResult = await query('SELECT password_hash FROM users WHERE id = $1', [targetId]);
    if (userResult.rows.length === 0) {
      throw new Errors.NotFoundError('User not found');
    }

    const valid = await bcrypt.compare(oldPassword, userResult.rows[0].password_hash);
    if (!valid) {
      throw new Errors.UnauthorizedError('Incorrect old password');
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, targetId]);

    // Revoke all refresh tokens for this user
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [targetId]);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── Address Routes ───────────────────────────────────────────────────────────

// Get addresses
app.get('/addresses', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, user_id, name, phone, province, city, district, detail, is_default, created_at
       FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
      [req.user.userId]
    );
    res.json({ addresses: result.rows });
  } catch (err) {
    next(err);
  }
});

// Add address
app.post('/addresses', authenticate, async (req, res, next) => {
  try {
    const { name, phone, province, city, district, detail, isDefault } = req.body;

    validateRequired({ name, phone, province, city, district, detail }, ['name', 'phone', 'province', 'city', 'district', 'detail']);

    const userId = req.user.userId;

    const result = await transaction(async (client) => {
      if (isDefault) {
        await client.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [userId]);
      }
      const insertResult = await client.query(
        `INSERT INTO addresses (user_id, name, phone, province, city, district, detail, is_default, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         RETURNING id, user_id, name, phone, province, city, district, detail, is_default, created_at`,
        [userId, name, phone, province, city, district, detail, isDefault === true]
      );
      return insertResult;
    });

    res.status(201).json({ address: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Update address
app.put('/addresses/:id', authenticate, async (req, res, next) => {
  try {
    const addressId = parseInt(req.params.id, 10);
    if (isNaN(addressId)) {
      throw new Errors.ValidationError('Invalid address ID');
    }

    const { name, phone, province, city, district, detail, isDefault } = req.body;
    const userId = req.user.userId;

    const existing = await query('SELECT id FROM addresses WHERE id = $1 AND user_id = $2', [addressId, userId]);
    if (existing.rows.length === 0) {
      throw new Errors.NotFoundError('Address not found');
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (phone !== undefined) { updates.push(`phone = $${idx++}`); values.push(phone); }
    if (province !== undefined) { updates.push(`province = $${idx++}`); values.push(province); }
    if (city !== undefined) { updates.push(`city = $${idx++}`); values.push(city); }
    if (district !== undefined) { updates.push(`district = $${idx++}`); values.push(district); }
    if (detail !== undefined) { updates.push(`detail = $${idx++}`); values.push(detail); }
    if (isDefault !== undefined) { updates.push(`is_default = $${idx++}`); values.push(isDefault === true); }

    if (updates.length === 0) {
      throw new Errors.ValidationError('No fields to update');
    }

    values.push(addressId);

    const result = await transaction(async (client) => {
      if (isDefault === true) {
        await client.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1', [userId]);
      }
      const r = await client.query(
        `UPDATE addresses SET ${updates.join(', ')} WHERE id = $${idx}
         RETURNING id, user_id, name, phone, province, city, district, detail, is_default, created_at`,
        values
      );
      return r;
    });

    res.json({ address: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// Delete address
app.delete('/addresses/:id', authenticate, async (req, res, next) => {
  try {
    const addressId = parseInt(req.params.id, 10);
    if (isNaN(addressId)) {
      throw new Errors.ValidationError('Invalid address ID');
    }

    const result = await query(
      'DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING id',
      [addressId, req.user.userId]
    );
    if (result.rows.length === 0) {
      throw new Errors.NotFoundError('Address not found');
    }

    res.json({ message: 'Address deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', async (req, res, next) => {
  try {
    await query('SELECT 1');
    const redisPing = await redis.ping();
    res.json({
      status: 'ok',
      service: process.env.SERVICE_NAME || 'user-service',
      database: 'connected',
      redis: redisPing === 'PONG' ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    next(err);
  }
});

// ─── Error Handler ────────────────────────────────────────────────────────────

app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3001;

async function start() {
  await initDb();
  await eventBus.connect();
  logger.info('EventBus connected');

  app.listen(PORT, () => {
    logger.info(`User service running on port ${PORT}`);
  });
}

start().catch(err => {
  logger.error('Failed to start user-service:', err);
  process.exit(1);
});

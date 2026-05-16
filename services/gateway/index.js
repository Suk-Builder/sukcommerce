/**
 * API Gateway — 统一入口
 * 路由 / 限流 / 熔断 / JWT验证 / 请求转发 / 日志
 */
require('dotenv').config();
const express = require('express');
const httpProxy = require('http-proxy-middleware');
const Redis = require('ioredis');

const { createLogger, requestIdMiddleware } = require('../../shared/lib/logger');
const { Errors, errorHandler } = require('../../shared/lib/errors');
const jwt = require('jsonwebtoken');

const logger = createLogger();
const app = express();

// ─── 中间件 ───
app.use(express.json({ limit: '1mb' }));
app.use(requestIdMiddleware);

// ─── Redis 限流 ───
const redis = new Redis(process.env.REDIS_URL);

async function rateLimit(req, res, next) {
  const key = `ratelimit:${req.ip}:${req.path}`;
  const window = parseInt(process.env.RATE_LIMIT_WINDOW) || 60000;
  const max = parseInt(process.env.RATE_LIMIT_MAX) || 100;

  const current = await redis.incr(key);
  if (current === 1) await redis.pexpire(key, window);

  res.setHeader('X-RateLimit-Limit', max);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, max - current));

  if (current > max) {
    return next(Errors.RATE_LIMITED());
  }
  next();
}
app.use(rateLimit);

// ─── JWT 验证 ───
function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return next(Errors.UNAUTHORIZED());

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(Errors.TOKEN_EXPIRED());
    next(Errors.UNAUTHORIZED());
  }
}

// ─── 熔断器 ───
class CircuitBreaker {
  constructor(name, threshold = 5, timeout = 30000) {
    this.name = name;
    this.failures = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED'; // CLOSED OPEN HALF_OPEN
    this.lastFailure = null;
  }

  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.timeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw Errors.CIRCUIT_OPEN();
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
      logger.warn(`Circuit OPEN: ${this.name}`);
    }
  }
}

const breakers = {};
function getBreaker(name) {
  if (!breakers[name]) breakers[name] = new CircuitBreaker(name);
  return breakers[name];
}

// ─── 服务代理配置 ───
const services = {
  '/api/v1/users': { target: process.env.USER_SERVICE_URL, name: 'user' },
  '/api/v1/auth': { target: process.env.USER_SERVICE_URL, name: 'user' },
  '/api/v1/products': { target: process.env.PRODUCT_SERVICE_URL, name: 'product' },
  '/api/v1/categories': { target: process.env.PRODUCT_SERVICE_URL, name: 'product' },
  '/api/v1/search': { target: process.env.PRODUCT_SERVICE_URL, name: 'product' },
  '/api/v1/orders': { target: process.env.ORDER_SERVICE_URL, name: 'order' },
  '/api/v1/cart': { target: process.env.ORDER_SERVICE_URL, name: 'order' },
  '/api/v1/payments': { target: process.env.PAYMENT_SERVICE_URL, name: 'payment' },
  '/api/v1/webhooks': { target: process.env.PAYMENT_SERVICE_URL, name: 'payment' },
  '/api/v1/notifications': { target: process.env.NOTIFICATION_SERVICE_URL, name: 'notification' },
};

// ─── 路由注册 ───
Object.entries(services).forEach(([path, config]) => {
  const proxy = httpProxy.createProxyMiddleware({
    target: config.target,
    changeOrigin: true,
    pathRewrite: (path) => path,
    onError: (err, req, res) => {
      logger.error(`Proxy error [${config.name}]:`, err.message);
      res.status(503).json({ error: { code: 'E1001', message: '服务暂时不可用' } });
    },
    onProxyReq: (proxyReq, req) => {
      // 透传用户信息
      if (req.user) {
        proxyReq.setHeader('X-User-Id', req.user.userId);
        proxyReq.setHeader('X-User-Role', req.user.role || 'user');
      }
      proxyReq.setHeader('X-Request-ID', req.request_id);
    }
  });

  // WebSocket 路径不验证
  if (path.includes('ws')) {
    app.use(path, proxy);
  } else {
    app.use(path, authenticate, proxy);
  }
});

// ─── 健康检查 ───
app.get('/health', async (req, res) => {
  const checks = {};
  for (const [name, config] of Object.entries(services)) {
    try {
      const fetch = (await import('node-fetch')).default;
      await fetch(`${config.target}/health`, { timeout: 3000 });
      checks[name] = 'healthy';
    } catch {
      checks[name] = 'unhealthy';
    }
  }
  const allHealthy = Object.values(checks).every(v => v === 'healthy');
  res.status(allHealthy ? 200 : 503).json({
    service: 'gateway',
    status: allHealthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString()
  });
});

app.get('/metrics', (req, res) => {
  res.json({ service: 'gateway', uptime: process.uptime() });
});

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Gateway running on port ${PORT}`);
  logger.info(`Services: ${Object.keys(services).join(', ')}`);
});

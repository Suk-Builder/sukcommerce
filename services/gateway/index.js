const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const Redis = require('ioredis');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { createLogger, requestIdMiddleware } = require('../../shared/lib/logger');
const { errorHandler } = require('../../shared/lib/errors');

const logger = createLogger('gateway');
const app = express();

// ─── Config ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

const SERVICE_URLS = {
  user: process.env.USER_SERVICE_URL || 'http://user-service:3001',
  product: process.env.PRODUCT_SERVICE_URL || 'http://product-service:3002',
  order: process.env.ORDER_SERVICE_URL || 'http://order-service:3003',
  payment: process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3004',
  notification: process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3005',
};

// ─── Redis ────────────────────────────────────────────────────────────
const redis = new Redis(REDIS_URL);
redis.on('error', (err) => logger.error('Redis error: %s', err.message));
redis.on('connect', () => logger.info('Redis connected'));

// ─── Metrics Store ────────────────────────────────────────────────────
const metrics = {
  requestsTotal: 0,
  requestsByRoute: {},
  errorsTotal: 0,
  activeConnections: 0,
  circuitBreakerStates: {},
  startTime: Date.now(),
};

// ─── Circuit Breaker ──────────────────────────────────────────────────
class CircuitBreaker {
  constructor(name) {
    this.name = name;
    this.state = 'CLOSED';
    this.failures = 0;
    this.failureThreshold = 5;
    this.resetTimeoutMs = 30000;
    this.nextAttempt = 0;
    metrics.circuitBreakerStates[name] = 'CLOSED';
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        const remaining = Math.ceil((this.nextAttempt - Date.now()) / 1000);
        throw new Error(`Circuit breaker OPEN for ${this.name}, retry after ${remaining}s`);
      }
      this.state = 'HALF_OPEN';
      metrics.circuitBreakerStates[this.name] = 'HALF_OPEN';
      logger.info(`Circuit breaker HALF_OPEN for ${this.name}`);
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
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      metrics.circuitBreakerStates[this.name] = 'CLOSED';
      logger.info(`Circuit breaker CLOSED for ${this.name}`);
    }
  }

  onFailure() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeoutMs;
      metrics.circuitBreakerStates[this.name] = 'OPEN';
      logger.warn('Circuit breaker OPEN for %s', this.name);
    }
  }
}

const circuitBreakers = {};
function getCircuitBreaker(name) {
  if (!circuitBreakers[name]) {
    circuitBreakers[name] = new CircuitBreaker(name);
  }
  return circuitBreakers[name];
}

// ─── JWT Middleware ───────────────────────────────────────────────────
function jwtMiddleware(req, res, next) {
  if (req.path === '/health' || req.path === '/metrics') return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.substring(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Rate Limit Middleware ────────────────────────────────────────────
async function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const key = `ratelimit:${ip}`;
  const limit = 100;
  const windowSeconds = 60;

  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSeconds);
    }

    const remaining = Math.max(0, limit - current);
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Window', `${windowSeconds}s`);

    if (current > limit) {
      return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
    }
    next();
  } catch (err) {
    logger.error('Rate limit check failed: %s', err.message);
    next(); // fail-open: allow request on Redis error
  }
}

// ─── Metrics Collection Middleware ────────────────────────────────────
function metricsMiddleware(req, res, next) {
  metrics.requestsTotal += 1;
  metrics.activeConnections += 1;
  const route = req.route ? req.route.path : req.path;
  metrics.requestsByRoute[route] = (metrics.requestsByRoute[route] || 0) + 1;

  res.on('finish', () => {
    metrics.activeConnections = Math.max(0, metrics.activeConnections - 1);
    if (res.statusCode >= 400) {
      metrics.errorsTotal += 1;
    }
  });
  next();
}

// ─── Proxy Factory ────────────────────────────────────────────────────
function createServiceProxy(target) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    timeout: 30000,
    proxyTimeout: 30000,
    onProxyReq: (proxyReq, req) => {
      proxyReq.setHeader('X-Request-ID', req.requestId || `req-${Date.now()}`);
      if (req.user) {
        proxyReq.setHeader('X-User-Id', req.user.id || req.user.sub || '');
        proxyReq.setHeader('X-User-Role', req.user.role || '');
      }
    },
    onError: (err, req, res) => {
      logger.error('Proxy error [%s%s]: %s', target, req.path, err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Bad Gateway', message: 'Service temporarily unavailable' });
      }
    },
    onProxyRes: (proxyRes, req) => {
      logger.info('[%d] %s %s → %s', proxyRes.statusCode, req.method, req.path, target);
    },
  });
}

// ─── Circuit Breaker Wrapper ──────────────────────────────────────────
function circuitBreakerProxy(target, serviceName) {
  const proxy = createServiceProxy(target);
  const cb = getCircuitBreaker(serviceName);

  return (req, res, next) => {
    cb.execute(() =>
      new Promise((resolve, reject) => {
        proxy(req, res, (err) => {
          if (err) reject(err);
          else resolve();
        });
      })
    ).catch((err) => {
      if (err.message.includes('Circuit breaker OPEN')) {
        return res.status(503).json({ error: 'Service temporarily unavailable', detail: err.message });
      }
      if (!res.headersSent) {
        res.status(502).json({ error: 'Bad Gateway', message: err.message });
      }
    });
  };
}

// ─── Middleware Stack ─────────────────────────────────────────────────
app.use(requestIdMiddleware);
app.use(express.json());
app.use(metricsMiddleware);
app.use(rateLimitMiddleware);
app.use(jwtMiddleware);

// ─── Service Routes ───────────────────────────────────────────────────
const serviceRoutes = [
  { path: '/api/v1/auth', target: SERVICE_URLS.user, name: 'user-service' },
  { path: '/api/v1/users', target: SERVICE_URLS.user, name: 'user-service' },
  { path: '/api/v1/products', target: SERVICE_URLS.product, name: 'product-service' },
  { path: '/api/v1/categories', target: SERVICE_URLS.product, name: 'product-service' },
  { path: '/api/v1/search', target: SERVICE_URLS.product, name: 'product-service' },
  { path: '/api/v1/cart', target: SERVICE_URLS.order, name: 'order-service' },
  { path: '/api/v1/orders', target: SERVICE_URLS.order, name: 'order-service' },
  { path: '/api/v1/payments', target: SERVICE_URLS.payment, name: 'payment-service' },
  { path: '/api/v1/webhooks', target: SERVICE_URLS.payment, name: 'payment-service', skipAuth: true },
  { path: '/api/v1/notifications', target: SERVICE_URLS.notification, name: 'notification-service' },
];

for (const route of serviceRoutes) {
  const handler = circuitBreakerProxy(route.target, route.name);
  app.use(route.path, handler);
}

// ─── Health Check ─────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const services = [
    { name: 'user-service', url: `${SERVICE_URLS.user}/health` },
    { name: 'product-service', url: `${SERVICE_URLS.product}/health` },
    { name: 'order-service', url: `${SERVICE_URLS.order}/health` },
    { name: 'payment-service', url: `${SERVICE_URLS.payment}/health` },
    { name: 'notification-service', url: `${SERVICE_URLS.notification}/health` },
  ];

  const results = await Promise.all(
    services.map(async (svc) => {
      try {
        const resp = await fetch(svc.url, { timeout: 5000 });
        return { name: svc.name, status: resp.ok ? 'UP' : 'DOWN', statusCode: resp.status };
      } catch (err) {
        return { name: svc.name, status: 'DOWN', error: err.message };
      }
    })
  );

  const allUp = results.every((r) => r.status === 'UP');
  const redisHealth = redis.status === 'ready' || redis.status === 'connect';

  res.status(allUp && redisHealth ? 200 : 503).json({
    status: allUp && redisHealth ? 'HEALTHY' : 'UNHEALTHY',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    redis: redisHealth ? 'UP' : 'DOWN',
    services: results,
  });
});

// ─── Metrics Endpoint ─────────────────────────────────────────────────
app.get('/metrics', (req, res) => {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
  res.json({
    requests_total: metrics.requestsTotal,
    errors_total: metrics.errorsTotal,
    active_connections: metrics.activeConnections,
    uptime_seconds: uptime,
    requests_by_route: metrics.requestsByRoute,
    circuit_breaker_states: metrics.circuitBreakerStates,
    memory_usage: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Error Handling ───────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info('API Gateway running on port %d', PORT);
  logger.info('Services: %j', SERVICE_URLS);
});

module.exports = app;

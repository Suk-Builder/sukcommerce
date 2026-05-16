/**
 * gateway test setup
 * Mocks shared modules and external dependencies
 */

// ─── Environment ──────────────────────────────────────────────
process.env.NODE_ENV = 'test';
process.env.SERVICE_NAME = 'gateway';
process.env.PORT = '3000';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.REDIS_URL = 'redis://test-redis:6379';
process.env.USER_SERVICE_URL = 'http://user-service:3001';
process.env.PRODUCT_SERVICE_URL = 'http://product-service:3002';
process.env.ORDER_SERVICE_URL = 'http://order-service:3003';
process.env.PAYMENT_SERVICE_URL = 'http://payment-service:3004';
process.env.NOTIFICATION_SERVICE_URL = 'http://notification-service:3005';

// ─── Mock winston (logger) ────────────────────────────────────
jest.mock('../../shared/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  requestIdMiddleware: (req, res, next) => {
    req.requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    res.setHeader('X-Request-ID', req.requestId);
    next();
  },
}));

// ─── Mock ioredis ─────────────────────────────────────────────
const redisStore = new Map();
const mockRedisMethods = {
  incr: jest.fn(async (key) => {
    const current = (redisStore.get(key) || 0) + 1;
    redisStore.set(key, current);
    return current;
  }),
  expire: jest.fn(async () => true),
  get: jest.fn(async (key) => redisStore.get(key) || null),
  set: jest.fn(async (key, value) => { redisStore.set(key, value); return 'OK'; }),
  del: jest.fn(async (key) => { redisStore.delete(key); return 1; }),
  flushall: jest.fn(async () => { redisStore.clear(); return 'OK'; }),
  on: jest.fn(),
  status: 'ready',
};

const Redis = jest.fn(() => mockRedisMethods);
jest.mock('ioredis', () => Redis);

// ─── Mock jsonwebtoken ────────────────────────────────────────
const mockJwtVerify = jest.fn();
jest.mock('jsonwebtoken', () => ({
  verify: mockJwtVerify,
}));

// ─── Mock http-proxy-middleware ───────────────────────────────
const mockProxyMiddleware = jest.fn();
jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(() => mockProxyMiddleware),
}));

// ─── Mock node-fetch ──────────────────────────────────────────
const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

// ─── Reset between tests ──────────────────────────────────────
redisStore.clear();

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  mockJwtVerify.mockReset();
  mockFetch.mockReset();
});

// ─── Global teardown ──────────────────────────────────────────
afterAll(async () => {
  jest.clearAllMocks();
  redisStore.clear();
});

// Export mocks for test use
module.exports = {
  mockRedisMethods,
  mockJwtVerify,
  mockFetch,
  mockProxyMiddleware,
  redisStore,
  Redis,
};

/**
 * payment-service test setup
 * Mocks shared modules and external dependencies
 */

// ─── Environment ──────────────────────────────────────────────
process.env.NODE_ENV = 'test';
process.env.SERVICE_NAME = 'payment-service';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5432';
process.env.DB_NAME = 'test_payment';
process.env.DB_USER = 'postgres';
process.env.DB_PASSWORD = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_xxx';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_xxx';
process.env.ALIPAY_APP_ID = 'test_alipay_app_id';
process.env.ALIPAY_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIICXAIBAAKBgQC0L0...test...key\n-----END RSA PRIVATE KEY-----';
process.env.ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do';
process.env.PUBLIC_URL = 'http://localhost:3000';
process.env.RABBITMQ_URL = 'amqp://test-rabbitmq';

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

// ─── Mock pg ──────────────────────────────────────────────────
const mockPool = {
  query: jest.fn(),
  connect: jest.fn(),
  on: jest.fn(),
};

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

jest.mock('pg', () => ({
  Pool: jest.fn(() => mockPool),
}));

jest.mock('../../shared/lib/db', () => ({
  getPool: jest.fn(() => mockPool),
  query: jest.fn(),
  transaction: jest.fn(async (fn) => {
    const client = {
      query: jest.fn(),
    };
    return await fn(client);
  }),
  close: jest.fn(),
}));

// ─── Mock stripe ──────────────────────────────────────────────
const mockStripeCheckoutSessions = {
  create: jest.fn(),
  retrieve: jest.fn(),
};

const mockStripeRefunds = {
  create: jest.fn(),
};

const mockStripeWebhooks = {
  constructEvent: jest.fn(),
};

const mockStripeInstance = {
  checkout: {
    sessions: mockStripeCheckoutSessions,
  },
  refunds: mockStripeRefunds,
  webhooks: mockStripeWebhooks,
};

jest.mock('stripe', () => {
  return jest.fn(() => mockStripeInstance);
});

// ─── Mock events ──────────────────────────────────────────────
jest.mock('../../shared/lib/events', () => ({
  EventBus: jest.fn().mockImplementation(function () {
    this.connect = jest.fn().mockResolvedValue(undefined);
    this.publish = jest.fn().mockResolvedValue(undefined);
    return this;
  }),
  EventTypes: {
    PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
    PAYMENT_FAILED: 'PAYMENT_FAILED',
    REFUND_SUCCEEDED: 'REFUND_SUCCEEDED',
    ORDER_CREATED: 'ORDER_CREATED',
    ORDER_PAID: 'ORDER_PAID',
    ORDER_CANCELLED: 'ORDER_CANCELLED',
    ORDER_FULFILLED: 'ORDER_FULFILLED',
    INVENTORY_RESERVED: 'INVENTORY_RESERVED',
    INVENTORY_RELEASED: 'INVENTORY_RELEASED',
    SHIPMENT_CREATED: 'SHIPMENT_CREATED',
    USER_REGISTERED: 'USER_REGISTERED',
    PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  },
}));

// ─── Global teardown ──────────────────────────────────────────
afterAll(async () => {
  jest.clearAllMocks();
});

// Export mocks for test use
module.exports = {
  mockPool,
  mockClient,
  mockStripeInstance,
  mockStripeCheckoutSessions,
  mockStripeRefunds,
  mockStripeWebhooks,
};

/**
 * Test Environment Setup — Unified Mock Utilities
 * All external dependencies are mocked here for consistent test behavior.
 */

'use strict';

// ─── 1. Mock pg (PostgreSQL) ─────────────────────────────────────────────────

const mockQueryResults = [];
let mockQueryIndex = 0;

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn(() =>
  Promise.resolve({
    query: mockClientQuery,
    release: mockClientRelease,
  })
);

jest.mock('pg', () => {
  const Pool = jest.fn(() => ({
    query: mockPoolQuery,
    connect: mockPoolConnect,
    on: jest.fn(),
    end: jest.fn(() => Promise.resolve()),
  }));
  return { Pool };
});

// ─── 2. Mock ioredis ─────────────────────────────────────────────────────────

const redisStore = new Map();
const mockRedisSetex = jest.fn((key, seconds, value) => {
  redisStore.set(key, value);
  return Promise.resolve('OK');
});
const mockRedisGet = jest.fn((key) => Promise.resolve(redisStore.get(key) || null));
const mockRedisDel = jest.fn((key) => {
  redisStore.delete(key);
  return Promise.resolve(1);
});
const mockRedisPing = jest.fn(() => Promise.resolve('PONG'));
const mockRedisFlushdb = jest.fn(() => {
  redisStore.clear();
  return Promise.resolve('OK');
});

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    setex: mockRedisSetex,
    get: mockRedisGet,
    del: mockRedisDel,
    ping: mockRedisPing,
    flushdb: mockRedisFlushdb,
    on: jest.fn(),
    disconnect: jest.fn(),
  }));
});

// ─── 3. Mock amqplib (RabbitMQ) ──────────────────────────────────────────────

const mockChannelPublish = jest.fn(() => true);
const mockChannelAssertQueue = jest.fn(() => Promise.resolve({ queue: 'test-queue' }));
const mockChannelAssertExchange = jest.fn(() => Promise.resolve());
const mockChannelBindQueue = jest.fn(() => Promise.resolve());
const mockChannelConsume = jest.fn(() => Promise.resolve());
const mockChannelAck = jest.fn();
const mockChannelNack = jest.fn();
const mockChannelClose = jest.fn(() => Promise.resolve());
const mockConnectionClose = jest.fn(() => Promise.resolve());
const mockConnectionOn = jest.fn();
const mockCreateChannel = jest.fn(() =>
  Promise.resolve({
    publish: mockChannelPublish,
    assertQueue: mockChannelAssertQueue,
    assertExchange: mockChannelAssertExchange,
    bindQueue: mockChannelBindQueue,
    consume: mockChannelConsume,
    ack: mockChannelAck,
    nack: mockChannelNack,
    close: mockChannelClose,
  })
);

jest.mock('amqplib', () => ({
  connect: jest.fn(() =>
    Promise.resolve({
      createChannel: mockCreateChannel,
      close: mockConnectionClose,
      on: mockConnectionOn,
    })
  ),
}));

// ─── 4. Mock bcryptjs ────────────────────────────────────────────────────────

jest.mock('bcryptjs', () => ({
  hash: jest.fn((password, salt) => Promise.resolve(`hashed_${password}`)),
  compare: jest.fn((plain, hash) => Promise.resolve(hash === `hashed_${plain}`)),
}));

// ─── 5. Mock jsonwebtoken ────────────────────────────────────────────────────

const jwtMockPayloads = {};
const jwtMockTokens = {};

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn((payload, secret, options) => {
    const key = `${payload.userId || payload.sub}_${(options && options.expiresIn) || 'default'}`;
    const token = `mock_jwt_${key}_${Date.now()}`;
    jwtMockPayloads[token] = payload;
    jwtMockTokens[token] = token;
    return token;
  }),
  verify: jest.fn((token, secret) => {
    if (!token || token.startsWith('invalid_')) {
      throw new Error('Invalid token');
    }
    if (token.startsWith('expired_')) {
      throw new Error('Token expired');
    }
    // Return the stored payload or a default one
    return jwtMockPayloads[token] || { userId: 1, username: 'testuser', role: 'user' };
  }),
}));

// ─── 6. Mock dotenv ──────────────────────────────────────────────────────────

jest.mock('dotenv', () => ({
  config: jest.fn(),
}));

// ─── 7. Mock winston (logger) ────────────────────────────────────────────────

jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })),
  format: {
    combine: jest.fn(),
    timestamp: jest.fn(),
    json: jest.fn(),
    printf: jest.fn(),
    errors: jest.fn(() => jest.fn()),
  },
  transports: {
    Console: jest.fn(),
    File: jest.fn(),
  },
}));

// ─── 8. Environment variables ────────────────────────────────────────────────

process.env.JWT_SECRET = 'test-jwt-secret-key-123456789';
process.env.SERVICE_NAME = 'user-service';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.RABBITMQ_URL = 'amqp://localhost:5672';
process.env.DB_HOST = 'localhost';
process.env.DB_PORT = '5432';
process.env.DB_NAME = 'test_db';
process.env.DB_USER = 'postgres';
process.env.DB_PASSWORD = 'password';
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

// ─── Helper: Reset all mocks before each test ────────────────────────────────

beforeEach(() => {
  // Reset pg mocks
  mockQueryResults.length = 0;
  mockQueryIndex = 0;
  mockPoolQuery.mockReset();
  mockPoolConnect.mockClear();
  mockClientQuery.mockReset();
  mockClientRelease.mockClear();

  // Reset redis mocks
  redisStore.clear();
  mockRedisSetex.mockClear();
  mockRedisGet.mockClear();
  mockRedisDel.mockClear();
  mockRedisPing.mockClear();

  // Reset amqplib mocks
  mockChannelPublish.mockClear();
  mockChannelAssertQueue.mockClear();
  mockChannelAssertExchange.mockClear();
  mockChannelBindQueue.mockClear();
  mockChannelConsume.mockClear();
  mockCreateChannel.mockClear();

  // Reset jwt mock payloads
  Object.keys(jwtMockPayloads).forEach((key) => delete jwtMockPayloads[key]);
  Object.keys(jwtMockTokens).forEach((key) => delete jwtMockTokens[key]);
});

// ─── Exported Mock Utilities ─────────────────────────────────────────────────

/**
 * Setup mock query responses for the db.query() function.
 * Each call to db.query() will consume the next response in order.
 * Usage: mockQueryResponses({ rows: [...] }, { rows: [...] })
 */
function mockQueryResponses(...responses) {
  const { query } = require('../../shared/lib/db');
  query.mockImplementation
    ? query.mockImplementation((sql, params) => {
        const resp = responses.shift() || { rows: [] };
        return Promise.resolve(resp);
      })
    : null;
}

/**
 * Setup mock responses for a sequence of db queries.
 * Creates a mock that returns responses sequentially.
 */
function setupMockQuery(...responses) {
  let callIndex = 0;
  const { query } = require('../../shared/lib/db');
  query.mockImplementation((sql, params) => {
    const resp = responses[callIndex++] || { rows: [] };
    return Promise.resolve(resp);
  });
  return () => callIndex;
}

/**
 * Create a mock user object for testing.
 */
function createMockUser(overrides = {}) {
  return {
    id: 1,
    username: 'testuser',
    email: 'test@example.com',
    password_hash: 'hashed_password123',
    role: 'user',
    status: 'active',
    avatar: null,
    phone: '13800138000',
    email_verified: false,
    phone_verified: false,
    last_login_at: null,
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Create a mock address object for testing.
 */
function createMockAddress(overrides = {}) {
  return {
    id: 1,
    user_id: 1,
    name: 'Test User',
    phone: '13800138000',
    province: 'Guangdong',
    city: 'Shenzhen',
    district: 'Nanshan',
    detail: 'No. 123 Keyuan Rd',
    is_default: false,
    created_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Generate a valid mock JWT token for a given user.
 */
function generateMockToken(user) {
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
}

/**
 * Verify that a mock function was called with specific SQL substring.
 */
function expectSqlCalled(mockFn, sqlSubstring) {
  const calls = mockFn.mock.calls;
  const found = calls.some((call) =>
    call[0] && call[0].toLowerCase().includes(sqlSubstring.toLowerCase())
  );
  if (!found) {
    throw new Error(
      `Expected SQL containing "${sqlSubstring}" but none found. Calls: ${JSON.stringify(calls.map((c) => c[0]))}`
    );
  }
  return true;
}

module.exports = {
  // pg mocks
  mockPoolQuery,
  mockPoolConnect,
  mockClientQuery,
  mockClientRelease,
  mockQueryResults,

  // redis mocks
  mockRedisSetex,
  mockRedisGet,
  mockRedisDel,
  mockRedisPing,
  redisStore,

  // amqplib mocks
  mockChannelPublish,
  mockChannelAssertExchange,
  mockChannelAssertQueue,
  mockCreateChannel,

  // jwt mocks
  jwtMockPayloads,
  jwtMockTokens,

  // helpers
  mockQueryResponses,
  setupMockQuery,
  createMockUser,
  createMockAddress,
  generateMockToken,
  expectSqlCalled,
};

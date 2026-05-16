/**
 * product-service test setup
 * Mock external dependencies and provide test helpers
 */

const { EventTypes } = require('../../shared/lib/events');

// ===== Mock dotenv =====
jest.mock('dotenv', () => ({
  config: jest.fn()
}));

// ===== Mock Winston Logger =====
jest.mock('../../shared/lib/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  })),
  requestIdMiddleware: (req, res, next) => {
    req.request_id = req.headers['x-request-id'] || 'test-request-id';
    next();
  }
}));

// ===== Mock amqplib =====
const mockPublish = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({
  createChannel: jest.fn().mockResolvedValue({
    assertExchange: jest.fn().mockResolvedValue(),
    assertQueue: jest.fn().mockResolvedValue({ queue: 'test-queue' }),
    bindQueue: jest.fn().mockResolvedValue(),
    publish: mockPublish,
    consume: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    close: jest.fn()
  }),
  on: jest.fn(),
  close: jest.fn()
});

jest.mock('amqplib', () => ({
  connect: mockConnect
}));

// ===== Mock Redis =====
const redisStore = new Map();
const mockRedisGet = jest.fn((key) => {
  const val = redisStore.get(key);
  return Promise.resolve(val || null);
});
const mockRedisSetex = jest.fn((key, ttl, val) => {
  redisStore.set(key, val);
  return Promise.resolve('OK');
});
const mockRedisDel = jest.fn((...keys) => {
  keys.forEach(k => redisStore.delete(k));
  return Promise.resolve(1);
});
const mockRedisKeys = jest.fn((pattern) => {
  const matches = [];
  for (const key of redisStore.keys()) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    if (regex.test(key)) matches.push(key);
  }
  return Promise.resolve(matches);
});
const mockRedisPing = jest.fn().mockResolvedValue('PONG');

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: mockRedisGet,
    setex: mockRedisSetex,
    del: mockRedisDel,
    keys: mockRedisKeys,
    ping: mockRedisPing,
    on: jest.fn()
  }));
});

// ===== Mock Elasticsearch =====
const mockESIndex = jest.fn().mockResolvedValue({ result: 'created' });
const mockESDelete = jest.fn().mockResolvedValue({ result: 'deleted' });
const mockESSearch = jest.fn().mockResolvedValue({
  hits: {
    total: { value: 0 },
    hits: []
  }
});
const mockESExists = jest.fn().mockResolvedValue(true);
const mockESCreate = jest.fn().mockResolvedValue({ acknowledged: true });

jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    index: mockESIndex,
    delete: mockESDelete,
    search: mockESSearch,
    indices: {
      exists: mockESExists,
      create: mockESCreate
    }
  }))
}));

// ===== Mock DB =====
let queryMock = jest.fn();
let transactionMock = jest.fn();

jest.mock('../../shared/lib/db', () => ({
  query: (...args) => queryMock(...args),
  transaction: (fn) => transactionMock(fn),
  getPool: jest.fn().mockReturnValue({
    connect: jest.fn().mockResolvedValue({
      query: jest.fn(),
      release: jest.fn()
    })
  })
}));

// ===== Test Helpers =====
function setQueryMock(fn) {
  queryMock = fn;
}

function setTransactionMock(fn) {
  transactionMock = fn;
}

function mockQuery(rows, { times = Infinity } = {}) {
  let callCount = 0;
  const impl = jest.fn().mockImplementation((sql, params) => {
    callCount++;
    if (callCount <= times) {
      return Promise.resolve({ rows: typeof rows === 'function' ? rows(sql, params) : rows });
    }
    return Promise.resolve({ rows: [] });
  });
  queryMock = impl;
  return impl;
}

function mockQuerySequence(responses) {
  let idx = 0;
  const impl = jest.fn().mockImplementation((sql, params) => {
    const resp = responses[idx++] || { rows: [] };
    return Promise.resolve({ rows: typeof resp === 'function' ? resp(sql, params) : resp });
  });
  queryMock = impl;
  return impl;
}

function mockTransaction(fn) {
  const impl = jest.fn().mockImplementation(async (callback) => {
    const mockClient = {
      query: jest.fn().mockImplementation((sql, params) => {
        const result = fn(sql, params, mockClient);
        return Promise.resolve({ rows: result || [] });
      })
    };
    try {
      const result = await callback(mockClient);
      return result;
    } catch (err) {
      throw err;
    }
  });
  transactionMock = impl;
  return impl;
}

function mockTransactionWithResults(resultsFn) {
  const impl = jest.fn().mockImplementation(async (callback) => {
    const mockClient = {
      query: jest.fn().mockImplementation(async (sql, params) => {
        const result = await resultsFn(sql, params, mockClient);
        return { rows: result || [] };
      })
    };
    return await callback(mockClient);
  });
  transactionMock = impl;
  return impl;
}

function mockESIndexResult(result) {
  mockESIndex.mockResolvedValueOnce(result || { result: 'created' });
}

function mockESSearchResult(hits, total) {
  mockESSearch.mockResolvedValueOnce({
    hits: {
      total: { value: total || hits.length },
      hits: hits.map((h, i) => ({
        _id: String(h.id || i),
        _source: h,
        highlight: h._highlight || null
      }))
    }
  });
}

function mockRedisCache(key, data) {
  redisStore.set(key, JSON.stringify(data));
}

function clearRedisCache() {
  redisStore.clear();
}

// ===== Before each test =====
beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  queryMock = jest.fn().mockResolvedValue({ rows: [] });
  transactionMock = jest.fn().mockImplementation(async (callback) => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] })
    };
    return await callback(mockClient);
  });
});

// ===== Exports for test files =====
module.exports = {
  mockQuery,
  mockQuerySequence,
  mockTransaction,
  mockTransactionWithResults,
  mockESIndex,
  mockESIndexResult,
  mockESSearch,
  mockESSearchResult,
  mockRedisGet,
  mockRedisSetex,
  mockRedisCache,
  clearRedisCache,
  mockPublish,
  mockConnect,
  EventTypes,
  setQueryMock,
  setTransactionMock,
  redisStore,
  mockRedisPing
};

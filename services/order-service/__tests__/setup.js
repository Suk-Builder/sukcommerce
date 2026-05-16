/**
 * Test Environment Setup — order-service
 * Mocks: pg (Pool), ioredis, amqplib, axios, winston
 */

const mockQueryResults = [];
const mockQueryFn = jest.fn();
const mockClientQuery = jest.fn();
const mockPoolConnect = jest.fn();
const mockBegin = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();
const mockRelease = jest.fn();
const mockPoolEnd = jest.fn();
const mockChannelPublish = jest.fn();
const mockChannelAssertExchange = jest.fn();
const mockChannelAssertQueue = jest.fn();
const mockChannelBindQueue = jest.fn();
const mockChannelConsume = jest.fn();
const mockChannelAck = jest.fn();
const mockChannelNack = jest.fn();
const mockChannelClose = jest.fn();
const mockConnectionClose = jest.fn();
const mockAmqpConnect = jest.fn();
const mockCreateChannel = jest.fn();
const mockChannelPrefetch = jest.fn();

// ── Mock pg ──
jest.mock('pg', () => {
  const mPool = jest.fn().mockImplementation(() => ({
    connect: mockPoolConnect,
    end: mockPoolEnd,
    on: jest.fn(),
    query: mockQueryFn,
  }));
  return { Pool: mPool };
});

// ── Mock ioredis ──
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
  }));
});

// ── Mock amqplib ──
jest.mock('amqplib', () => ({
  connect: mockAmqpConnect.mockResolvedValue({
    createChannel: mockCreateChannel.mockResolvedValue({
      assertExchange: mockChannelAssertExchange.mockResolvedValue({}),
      assertQueue: mockChannelAssertQueue.mockResolvedValue({ queue: 'test-queue' }),
      bindQueue: mockChannelBindQueue.mockResolvedValue({}),
      consume: mockChannelConsume.mockResolvedValue({ consumerTag: 'tag1' }),
      ack: mockChannelAck.mockReturnValue(undefined),
      nack: mockChannelNack.mockReturnValue(undefined),
      publish: mockChannelPublish.mockReturnValue(true),
      close: mockChannelClose.mockResolvedValue(undefined),
      prefetch: mockChannelPrefetch.mockResolvedValue(undefined),
    }),
    close: mockConnectionClose.mockResolvedValue(undefined),
    on: jest.fn(),
  }),
}));

// ── Mock axios ──
jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  patch: jest.fn(),
  request: jest.fn(),
  interceptors: {
    request: { use: jest.fn(), eject: jest.fn() },
    response: { use: jest.fn(), eject: jest.fn() },
  },
  defaults: { headers: { common: {} } },
  create: jest.fn().mockReturnThis(),
}));

// ── Mock winston (logger) ──
jest.mock('winston', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
  transports: {
    Console: jest.fn(),
    File: jest.fn(),
  },
  format: {
    combine: jest.fn(),
    timestamp: jest.fn(),
    json: jest.fn(),
    printf: jest.fn(),
    errors: jest.fn(),
    colorize: jest.fn(),
  },
}));

// ── Mock dotenv ──
jest.mock('dotenv', () => ({
  config: jest.fn(),
}));

// ── Helper: build a mock client ──
function buildMockClient(queryResponses = []) {
  let callIndex = 0;
  mockClientQuery.mockImplementation((...args) => {
    const resp = queryResponses[callIndex];
    callIndex++;
    if (resp instanceof Error) return Promise.reject(resp);
    return Promise.resolve(resp || { rows: [] });
  });
  mockBegin.mockResolvedValue(undefined);
  mockCommit.mockResolvedValue(undefined);
  mockRollback.mockResolvedValue(undefined);
  mockRelease.mockResolvedValue(undefined);

  return {
    query: mockClientQuery,
    release: mockRelease,
  };
}

// ── Helper: build mock pool connect with transaction support ──
function buildMockPoolConnect(queryResponses = []) {
  let callIndex = 0;
  mockClientQuery.mockImplementation((...args) => {
    const sql = args[0];
    if (sql === 'BEGIN') return mockBegin();
    if (sql === 'COMMIT') return mockCommit();
    if (sql === 'ROLLBACK') return mockRollback();
    const resp = queryResponses[callIndex];
    callIndex++;
    if (resp instanceof Error) return Promise.reject(resp);
    return Promise.resolve(resp || { rows: [] });
  });

  mockPoolConnect.mockResolvedValue({
    query: mockClientQuery,
    release: mockRelease,
  });

  return { query: mockClientQuery, release: mockRelease };
}

// ── Reset all mocks before each test ──
beforeEach(() => {
  jest.clearAllMocks();
  mockQueryResults.length = 0;
});

// ── Silence console during tests ──
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore && console.log.mockRestore();
  console.error.mockRestore && console.error.mockRestore();
  console.warn.mockRestore && console.warn.mockRestore();
  console.info.mockRestore && console.info.mockRestore();
  console.debug.mockRestore && console.debug.mockRestore();
});

module.exports = {
  mockQueryFn,
  mockClientQuery,
  mockPoolConnect,
  mockPoolEnd,
  mockBegin,
  mockCommit,
  mockRollback,
  mockRelease,
  mockChannelPublish,
  mockChannelAssertExchange,
  mockChannelAssertQueue,
  mockChannelBindQueue,
  mockChannelConsume,
  mockChannelAck,
  mockChannelNack,
  mockChannelClose,
  mockConnectionClose,
  mockAmqpConnect,
  mockCreateChannel,
  mockChannelPrefetch,
  mockQueryResults,
  buildMockClient,
  buildMockPoolConnect,
};

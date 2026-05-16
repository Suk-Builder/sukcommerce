/**
 * Authentication Routes Tests
 * Covers: POST /register, POST /login, POST /refresh, GET /me, GET /health
 * Each route has success + multiple failure scenario tests.
 */

'use strict';

const request = require('supertest');
const { mockClientQuery, mockRedisSetex, mockRedisGet, mockRedisPing, redisStore } = require('./setup');

// Helper to create app fresh for each test
function createApp() {
  // Clear require cache to get a fresh express app each time
  jest.resetModules();
  return require('../index');
}

describe('Auth Routes', () => {
  let app;
  let queryCallIndex;
  const queryResponses = [];

  beforeEach(() => {
    queryCallIndex = 0;
    queryResponses.length = 0;
    // Setup sequential mock responses for client.query
    mockClientQuery.mockImplementation((sql, params) => {
      const resp = queryResponses[queryCallIndex++];
      if (resp instanceof Error) throw resp;
      return Promise.resolve(resp || { rows: [] });
    });
    mockRedisPing.mockImplementation(() => Promise.resolve('PONG'));
    app = createApp();
  });

  // ─────────────────────────────────────────────────────────────
  // POST /register
  // ─────────────────────────────────────────────────────────────

  describe('POST /register', () => {
    const validRegisterBody = {
      username: 'newuser',
      email: 'newuser@example.com',
      password: 'password123',
      phone: '13800138001',
    };

    it('should register a new user successfully with 201', async () => {
      queryResponses.push(
        { rows: [] },                              // Check existing user
        { rows: [{ id: 2, username: 'newuser', email: 'newuser@example.com', role: 'user', status: 'active', avatar: null, phone: '13800138001', email_verified: false, phone_verified: false, last_login_at: null, created_at: '2024-01-01T00:00:00.000Z' }] }, // INSERT RETURNING
        { rows: [] },                              // storeRefreshToken
        { rows: [] }                               // last_login_at update (not used here)
      );

      const res = await request(app)
        .post('/register')
        .send(validRegisterBody);

      expect(res.status).toBe(201);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('newuser');
      expect(res.body.user.email).toBe('newuser@example.com');
      expect(res.body.tokens).toBeDefined();
      expect(res.body.tokens.access).toBeDefined();
      expect(res.body.tokens.refresh).toBeDefined();
    });

    it('should register without phone field successfully', async () => {
      const body = { ...validRegisterBody };
      delete body.phone;

      queryResponses.push(
        { rows: [] },
        { rows: [{ id: 3, username: 'newuser', email: 'newuser@example.com', role: 'user', status: 'active', avatar: null, phone: null, email_verified: false, phone_verified: false, last_login_at: null, created_at: '2024-01-01T00:00:00.000Z' }] },
        { rows: [] },
        { rows: [] }
      );

      const res = await request(app).post('/register').send(body);
      expect(res.status).toBe(201);
      expect(res.body.user).toBeDefined();
    });

    it('should return 400 when username is missing', async () => {
      const res = await request(app)
        .post('/register')
        .send({ email: 'test@example.com', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when email is missing', async () => {
      const res = await request(app)
        .post('/register')
        .send({ username: 'newuser', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when password is missing', async () => {
      const res = await request(app)
        .post('/register')
        .send({ username: 'newuser', email: 'test@example.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 for invalid username format (too short)', async () => {
      const res = await request(app)
        .post('/register')
        .send({ username: 'ab', email: 'test@example.com', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Username/);
    });

    it('should return 400 for invalid username format (special chars)', async () => {
      const res = await request(app)
        .post('/register')
        .send({ username: 'user@name', email: 'test@example.com', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Username/);
    });

    it('should return 400 for invalid email format', async () => {
      const res = await request(app)
        .post('/register')
        .send({ username: 'newuser', email: 'not-an-email', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/email/i);
    });

    it('should return 400 for password too short', async () => {
      const res = await request(app)
        .post('/register')
        .send({ username: 'newuser', email: 'test@example.com', password: '123' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Password/);
    });

    it('should return 400 for invalid phone format', async () => {
      const res = await request(app)
        .post('/register')
        .send({ username: 'newuser', email: 'test@example.com', password: 'password123', phone: '123' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/phone/i);
    });

    it('should return 409 when username already exists', async () => {
      queryResponses.push(
        { rows: [{ id: 1 }] } // existing user found
      );

      const res = await request(app)
        .post('/register')
        .send(validRegisterBody);

      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/already exists/);
    });

    it('should return 409 when email already exists', async () => {
      queryResponses.push(
        { rows: [{ id: 2 }] } // existing email found
      );

      const res = await request(app)
        .post('/register')
        .send({ username: 'anotheruser', email: 'existing@example.com', password: 'password123' });

      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/already exists/);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /login
  // ─────────────────────────────────────────────────────────────

  describe('POST /login', () => {
    const mockUserRow = {
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
    };

    it('should login successfully with username and return 200', async () => {
      queryResponses.push(
        { rows: [mockUserRow] },  // SELECT user
        { rows: [] },             // UPDATE last_login_at
        { rows: [] },             // storeRefreshToken
        { rows: [] }
      );

      const res = await request(app)
        .post('/login')
        .send({ username: 'testuser', password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('testuser');
      expect(res.body.tokens).toBeDefined();
      expect(res.body.tokens.access).toBeDefined();
      expect(res.body.tokens.refresh).toBeDefined();
      expect(res.body.user.password_hash).toBeUndefined();
    });

    it('should login successfully with email and return 200', async () => {
      queryResponses.push(
        { rows: [{ ...mockUserRow, username: 'testuser', email: 'test@example.com' }] },
        { rows: [] },
        { rows: [] },
        { rows: [] }
      );

      const res = await request(app)
        .post('/login')
        .send({ username: 'test@example.com', password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
    });

    it('should return 400 when username is missing', async () => {
      const res = await request(app)
        .post('/login')
        .send({ password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when password is missing', async () => {
      const res = await request(app)
        .post('/login')
        .send({ username: 'testuser' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 401 when user does not exist', async () => {
      queryResponses.push(
        { rows: [] } // user not found
      );

      const res = await request(app)
        .post('/login')
        .send({ username: 'nonexistent', password: 'password123' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Invalid/);
    });

    it('should return 401 when password is incorrect', async () => {
      queryResponses.push(
        { rows: [mockUserRow] }
      );

      const bcrypt = require('bcryptjs');
      bcrypt.compare.mockImplementationOnce(() => Promise.resolve(false));

      const res = await request(app)
        .post('/login')
        .send({ username: 'testuser', password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Invalid/);
    });

    it('should return 403 when account is suspended', async () => {
      queryResponses.push(
        { rows: [{ ...mockUserRow, status: 'suspended' }] }
      );

      const res = await request(app)
        .post('/login')
        .send({ username: 'testuser', password: 'password123' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/not active/);
    });

    it('should return 403 when account is inactive', async () => {
      queryResponses.push(
        { rows: [{ ...mockUserRow, status: 'inactive' }] }
      );

      const res = await request(app)
        .post('/login')
        .send({ username: 'testuser', password: 'password123' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/not active/);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /refresh
  // ─────────────────────────────────────────────────────────────

  describe('POST /refresh', () => {
    const mockUserRow = {
      id: 1,
      username: 'testuser',
      email: 'test@example.com',
      role: 'user',
      status: 'active',
      avatar: null,
      phone: '13800138000',
      email_verified: false,
      phone_verified: false,
      last_login_at: '2024-01-01T00:00:00.000Z',
      created_at: '2024-01-01T00:00:00.000Z',
    };

    it('should refresh tokens successfully with 200', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, type: 'refresh' }));

      queryResponses.push(
        { rows: [{ id: 1 }] },      // refresh token exists and not expired
        { rows: [mockUserRow] },    // SELECT user
        { rows: [] },               // removeRefreshToken
        { rows: [] },               // storeRefreshToken
        { rows: [] }
      );

      const res = await request(app)
        .post('/refresh')
        .send({ refreshToken: 'valid_refresh_token' });

      expect(res.status).toBe(200);
      expect(res.body.tokens).toBeDefined();
      expect(res.body.tokens.access).toBeDefined();
      expect(res.body.tokens.refresh).toBeDefined();
    });

    it('should return 400 when refresh token is missing', async () => {
      const res = await request(app)
        .post('/refresh')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 401 when refresh token is invalid', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => {
        throw new Error('Invalid token');
      });

      const res = await request(app)
        .post('/refresh')
        .send({ refreshToken: 'invalid_token' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Invalid refresh token/);
    });

    it('should return 401 when refresh token is expired', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => {
        throw new Error('Token expired');
      });

      const res = await request(app)
        .post('/refresh')
        .send({ refreshToken: 'expired_token' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Invalid refresh token/);
    });

    it('should return 401 when refresh token type is not refresh', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, type: 'access' }));

      const res = await request(app)
        .post('/refresh')
        .send({ refreshToken: 'access_type_token' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Invalid refresh token/);
    });

    it('should return 401 when refresh token is revoked or expired in DB', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, type: 'refresh' }));

      queryResponses.push(
        { rows: [] } // token not found or expired in DB
      );

      const res = await request(app)
        .post('/refresh')
        .send({ refreshToken: 'revoked_token' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/revoked or expired/);
    });

    it('should return 401 when user is not found', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 999, type: 'refresh' }));

      queryResponses.push(
        { rows: [{ id: 1 }] },  // token valid in DB
        { rows: [] }            // user not found
      );

      const res = await request(app)
        .post('/refresh')
        .send({ refreshToken: 'valid_but_no_user' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/User not found/);
    });

    it('should return 403 when user account is not active', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, type: 'refresh' }));

      queryResponses.push(
        { rows: [{ id: 1 }] },
        { rows: [{ ...mockUserRow, status: 'suspended' }] }
      );

      const res = await request(app)
        .post('/refresh')
        .send({ refreshToken: 'valid_token_suspended' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/not active/);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /me
  // ─────────────────────────────────────────────────────────────

  describe('GET /me', () => {
    const mockUserRow = {
      id: 1,
      username: 'testuser',
      email: 'test@example.com',
      role: 'user',
      status: 'active',
      avatar: null,
      phone: '13800138000',
      email_verified: false,
      phone_verified: false,
      last_login_at: '2024-01-01T00:00:00.000Z',
      created_at: '2024-01-01T00:00:00.000Z',
    };

    it('should return user from Redis cache successfully', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      redisStore.set('user:1', JSON.stringify(mockUserRow));

      const res = await request(app)
        .get('/me')
        .set('Authorization', 'Bearer valid_token');

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.id).toBe(1);
      expect(res.body.user.username).toBe('testuser');
    });

    it('should return user from DB when cache miss and store to Redis', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      redisStore.clear();

      queryResponses.push(
        { rows: [mockUserRow] }, // SELECT from DB
        { rows: [] }             // redis setex not a query
      );

      const res = await request(app)
        .get('/me')
        .set('Authorization', 'Bearer valid_token_cache_miss');

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.id).toBe(1);
    });

    it('should return 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/me');

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/authorization/);
    });

    it('should return 401 when Authorization header is not Bearer format', async () => {
      const res = await request(app)
        .get('/me')
        .set('Authorization', 'Basic abc123');

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/authorization/);
    });

    it('should return 401 when token is invalid', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => {
        throw new Error('Invalid token');
      });

      const res = await request(app)
        .get('/me')
        .set('Authorization', 'Bearer invalid_token');

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/token/);
    });

    it('should return 401 when token is expired', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => {
        throw new Error('Token expired');
      });

      const res = await request(app)
        .get('/me')
        .set('Authorization', 'Bearer expired_token');

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/token/);
    });

    it('should return 404 when user not found in DB', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 999, username: 'deleteduser', role: 'user' }));

      redisStore.clear();

      queryResponses.push(
        { rows: [] } // user not found
      );

      const res = await request(app)
        .get('/me')
        .set('Authorization', 'Bearer token_for_deleted_user');

      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /health
  // ─────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('should return health status 200 when all services are connected', async () => {
      queryResponses.push({ rows: [{ '?column?': 1 }] });
      mockRedisPing.mockImplementationOnce(() => Promise.resolve('PONG'));

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('user-service');
      expect(res.body.database).toBe('connected');
      expect(res.body.redis).toBe('connected');
      expect(res.body.timestamp).toBeDefined();
    });

    it('should return health status with redis disconnected', async () => {
      queryResponses.push({ rows: [{ '?column?': 1 }] });
      mockRedisPing.mockImplementationOnce(() => Promise.resolve('not PONG'));

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.redis).toBe('disconnected');
    });

    it('should return 500 when database is down', async () => {
      mockClientQuery.mockImplementationOnce(() => {
        throw new Error('Connection refused');
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });

    it('should return 500 when redis is down', async () => {
      queryResponses.push({ rows: [{ '?column?': 1 }] });
      mockRedisPing.mockImplementationOnce(() => {
        throw new Error('Redis connection refused');
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });
  });
});

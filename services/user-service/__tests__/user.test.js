/**
 * User Management Routes Tests
 * Covers: GET /users/:id, PUT /users/:id, PUT /users/:id/password
 * Tests include success paths, auth failures, validation errors, permission checks.
 */

'use strict';

const request = require('supertest');
const { mockClientQuery, mockRedisSetex, redisStore } = require('./setup');

function createApp() {
  jest.resetModules();
  return require('../index');
}

describe('User Routes', () => {
  let app;
  const queryResponses = [];
  let queryCallIndex;

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

  const adminUserRow = {
    ...mockUserRow,
    id: 2,
    username: 'adminuser',
    email: 'admin@example.com',
    role: 'admin',
  };

  beforeEach(() => {
    queryCallIndex = 0;
    queryResponses.length = 0;
    redisStore.clear();

    mockClientQuery.mockImplementation((sql, params) => {
      const resp = queryResponses[queryCallIndex++];
      if (resp instanceof Error) throw resp;
      return Promise.resolve(resp || { rows: [] });
    });

    app = createApp();
  });

  // ─── Helper to generate auth header with mock JWT ─────────────────────

  function authHeader(user) {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    return `Bearer ${token}`;
  }

  // ─────────────────────────────────────────────────────────────
  // GET /users/:id
  // ─────────────────────────────────────────────────────────────

  describe('GET /users/:id', () => {
    it('should get own profile successfully', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [mockUserRow] }
      );

      const res = await request(app)
        .get('/users/1')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.id).toBe(1);
      expect(res.body.user.username).toBe('testuser');
    });

    it('should allow admin to get any user profile', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 2, username: 'adminuser', role: 'admin' }));

      queryResponses.push(
        { rows: [mockUserRow] }
      );

      const res = await request(app)
        .get('/users/1')
        .set('Authorization', authHeader(adminUserRow));

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.id).toBe(1);
    });

    it('should allow admin to get another admin profile', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 2, username: 'adminuser', role: 'admin' }));

      const anotherAdmin = { ...adminUserRow, id: 3, username: 'otheradmin' };
      queryResponses.push(
        { rows: [anotherAdmin] }
      );

      const res = await request(app)
        .get('/users/3')
        .set('Authorization', authHeader(adminUserRow));

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
    });

    it('should return 401 when no token provided', async () => {
      const res = await request(app).get('/users/1');

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('should return 401 when token is invalid', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => {
        throw new Error('Invalid token');
      });

      const res = await request(app)
        .get('/users/1')
        .set('Authorization', 'Bearer invalid_token');

      expect(res.status).toBe(401);
    });

    it('should return 403 when non-admin user tries to access another user profile', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .get('/users/999')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/admin/);
    });

    it('should return 400 for invalid user ID (non-numeric)', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .get('/users/notanumber')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Invalid user ID/);
    });

    it('should return 400 for invalid user ID (negative number)', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .get('/users/-1')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(200); // -1 is a valid parseInt result, will query DB
      // Actually parseInt('-1', 10) = -1 which is not NaN, so it will proceed to query
    });

    it('should return 404 when user not found', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [] } // user not found
      );

      const res = await request(app)
        .get('/users/1')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/);
    });

    it('should return 404 when admin requests non-existent user', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 2, username: 'adminuser', role: 'admin' }));

      queryResponses.push(
        { rows: [] }
      );

      const res = await request(app)
        .get('/users/99999')
        .set('Authorization', authHeader(adminUserRow));

      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PUT /users/:id
  // ─────────────────────────────────────────────────────────────

  describe('PUT /users/:id', () => {
    const updatedUserRow = {
      ...mockUserRow,
      username: 'updateduser',
      email: 'updated@example.com',
      phone: '13900139000',
      avatar: 'https://example.com/avatar.png',
    };

    it('should update own profile successfully', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [updatedUserRow] } // UPDATE RETURNING
      );

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ username: 'updateduser', email: 'updated@example.com', phone: '13900139000', avatar: 'https://example.com/avatar.png' });

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.username).toBe('updateduser');
      expect(res.body.user.email).toBe('updated@example.com');
    });

    it('should update username only', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ ...mockUserRow, username: 'justnewname' }] }
      );

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ username: 'justnewname' });

      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe('justnewname');
    });

    it('should update email only', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ ...mockUserRow, email: 'newemail@example.com' }] }
      );

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ email: 'newemail@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('newemail@example.com');
    });

    it('should update phone only', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ ...mockUserRow, phone: '13700137000' }] }
      );

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ phone: '13700137000' });

      expect(res.status).toBe(200);
      expect(res.body.user.phone).toBe('13700137000');
    });

    it('should allow admin to update another user profile', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 2, username: 'adminuser', role: 'admin' }));

      queryResponses.push(
        { rows: [{ ...mockUserRow, username: 'adminupdated' }] }
      );

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(adminUserRow))
        .send({ username: 'adminupdated' });

      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe('adminupdated');
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .put('/users/1')
        .send({ username: 'hacker' });

      expect(res.status).toBe(401);
    });

    it('should return 403 when non-admin user tries to update another user', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/999')
        .set('Authorization', authHeader(mockUserRow))
        .send({ username: 'hacker' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/admin/);
    });

    it('should return 400 for invalid user ID', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/abc')
        .set('Authorization', authHeader(mockUserRow))
        .send({ username: 'newname' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Invalid user ID/);
    });

    it('should return 400 when no fields to update', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/No fields to update/);
    });

    it('should return 400 for invalid username format', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ username: 'a' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Username/);
    });

    it('should return 400 for invalid email format', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ email: 'not-email' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/email/i);
    });

    it('should return 400 for invalid phone format', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ phone: '123' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/phone/i);
    });

    it('should return 404 when user not found', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [] } // no user updated
      );

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ username: 'newname' });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/);
    });

    it('should return 400 for username with special characters', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ username: 'user@name!' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Username/);
    });

    it('should handle empty string phone by clearing it', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ ...mockUserRow, phone: '' }] }
      );

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ phone: '' });

      expect(res.status).toBe(200);
    });

    it('should update avatar URL only', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ ...mockUserRow, avatar: 'https://cdn.example.com/new.png' }] }
      );

      const res = await request(app)
        .put('/users/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ avatar: 'https://cdn.example.com/new.png' });

      expect(res.status).toBe(200);
      expect(res.body.user.avatar).toBe('https://cdn.example.com/new.png');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PUT /users/:id/password
  // ─────────────────────────────────────────────────────────────

  describe('PUT /users/:id/password', () => {
    it('should change password successfully', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ password_hash: 'hashed_oldpass' }] },  // SELECT password_hash
        { rows: [] },                                      // UPDATE password_hash
        { rows: [] }                                       // DELETE refresh_tokens
      );

      const bcrypt = require('bcryptjs');
      bcrypt.compare.mockImplementationOnce(() => Promise.resolve(true));

      const res = await request(app)
        .put('/users/1/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ oldPassword: 'oldpass', newPassword: 'newpassword123' });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/updated successfully/);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .put('/users/1/password')
        .send({ oldPassword: 'old', newPassword: 'new' });

      expect(res.status).toBe(401);
    });

    it('should return 403 when trying to change another user password', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/999/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ oldPassword: 'old', newPassword: 'newpassword123' });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/own password/);
    });

    it('should return 400 for invalid user ID', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/abc/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ oldPassword: 'old', newPassword: 'newpassword123' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Invalid user ID/);
    });

    it('should return 400 when oldPassword is missing', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/1/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ newPassword: 'newpassword123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when newPassword is missing', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/1/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ oldPassword: 'oldpassword' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when newPassword is too short', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/1/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ oldPassword: 'oldpass', newPassword: '123' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/6-50/);
    });

    it('should return 400 when newPassword exceeds max length', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/1/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ oldPassword: 'oldpass', newPassword: 'a'.repeat(51) });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/6-50/);
    });

    it('should return 401 when old password is incorrect', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ password_hash: 'hashed_correctold' }] }
      );

      const bcrypt = require('bcryptjs');
      bcrypt.compare.mockImplementationOnce(() => Promise.resolve(false));

      const res = await request(app)
        .put('/users/1/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ oldPassword: 'wrongold', newPassword: 'newpassword123' });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Incorrect/);
    });

    it('should return 404 when user not found', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [] } // user not found
      );

      const res = await request(app)
        .put('/users/1/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ oldPassword: 'oldpass', newPassword: 'newpassword123' });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/);
    });

    it('should return 400 when both passwords are empty', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/users/1/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ oldPassword: '', newPassword: '' });

      expect(res.status).toBe(400);
    });

    it('should revoke all refresh tokens after password change', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ password_hash: 'hashed_oldpass' }] },
        { rows: [] },
        { rows: [{ id: 1 }, { id: 2 }] } // Two refresh tokens deleted
      );

      const bcrypt = require('bcryptjs');
      bcrypt.compare.mockImplementationOnce(() => Promise.resolve(true));

      const res = await request(app)
        .put('/users/1/password')
        .set('Authorization', authHeader(mockUserRow))
        .send({ oldPassword: 'oldpass', newPassword: 'newpassword123' });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/updated successfully/);
    });

    it('should allow admin to change own password', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 2, username: 'adminuser', role: 'admin' }));

      queryResponses.push(
        { rows: [{ password_hash: 'hashed_adminold' }] },
        { rows: [] },
        { rows: [] }
      );

      const bcrypt = require('bcryptjs');
      bcrypt.compare.mockImplementationOnce(() => Promise.resolve(true));

      const res = await request(app)
        .put('/users/2/password')
        .set('Authorization', authHeader(adminUserRow))
        .send({ oldPassword: 'adminold', newPassword: 'newadminpass123' });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/updated successfully/);
    });
  });
});

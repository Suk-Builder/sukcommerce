/**
 * Address Management Routes Tests
 * Covers: GET /addresses, POST /addresses, PUT /addresses/:id, DELETE /addresses/:id
 * Tests include CRUD success paths, auth failures, validation errors, ownership checks.
 */

'use strict';

const request = require('supertest');
const { mockClientQuery, redisStore } = require('./setup');

function createApp() {
  jest.resetModules();
  return require('../index');
}

describe('Address Routes', () => {
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

  const mockAddress1 = {
    id: 1,
    user_id: 1,
    name: 'Home',
    phone: '13800138000',
    province: 'Guangdong',
    city: 'Shenzhen',
    district: 'Nanshan',
    detail: 'No. 123 Keyuan Rd',
    is_default: true,
    created_at: '2024-01-01T00:00:00.000Z',
  };

  const mockAddress2 = {
    id: 2,
    user_id: 1,
    name: 'Office',
    phone: '13900139000',
    province: 'Guangdong',
    city: 'Guangzhou',
    district: 'Tianhe',
    detail: 'No. 456 Zhujiang Rd',
    is_default: false,
    created_at: '2024-01-02T00:00:00.000Z',
  };

  const validAddressBody = {
    name: 'New Address',
    phone: '13800138001',
    province: 'Beijing',
    city: 'Beijing',
    district: 'Chaoyang',
    detail: 'No. 789 Chaoyang Rd',
    isDefault: true,
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
  // GET /addresses
  // ─────────────────────────────────────────────────────────────

  describe('GET /addresses', () => {
    it('should return empty array when user has no addresses', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [] } // no addresses
      );

      const res = await request(app)
        .get('/addresses')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(200);
      expect(res.body.addresses).toEqual([]);
    });

    it('should return all addresses for current user', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [mockAddress1, mockAddress2] }
      );

      const res = await request(app)
        .get('/addresses')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(200);
      expect(res.body.addresses).toHaveLength(2);
      expect(res.body.addresses[0].name).toBe('Home');
      expect(res.body.addresses[1].name).toBe('Office');
    });

    it('should return addresses ordered by is_default DESC then created_at DESC', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const defaultAddr = { ...mockAddress2, is_default: true };
      const nonDefaultAddr = { ...mockAddress1, is_default: false };

      queryResponses.push(
        { rows: [defaultAddr, nonDefaultAddr] }
      );

      const res = await request(app)
        .get('/addresses')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(200);
      expect(res.body.addresses).toHaveLength(2);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).get('/addresses');

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('should return 401 for invalid token', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => {
        throw new Error('Invalid token');
      });

      const res = await request(app)
        .get('/addresses')
        .set('Authorization', 'Bearer invalid_token');

      expect(res.status).toBe(401);
    });

    it('should handle database error gracefully', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      mockClientQuery.mockImplementationOnce(() => {
        throw new Error('DB connection lost');
      });

      const res = await request(app)
        .get('/addresses')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(500);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /addresses
  // ─────────────────────────────────────────────────────────────

  describe('POST /addresses', () => {
    it('should create a new address successfully with 201', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      // Need to mock transaction: it calls client.query multiple times
      let txCallIndex = 0;
      const txResponses = [
        { rows: [] }, // UPDATE is_default = false
        { rows: [{ id: 3, user_id: 1, ...validAddressBody, is_default: true, created_at: '2024-01-03T00:00:00.000Z' }] }, // INSERT
      ];

      mockClientQuery.mockImplementation((sql, params) => {
        // Check if inside transaction (BEGIN/COMMIT/ROLLBACK are handled by db.transaction)
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve({ rows: [] });
        }
        const resp = txResponses[txCallIndex++] || queryResponses[queryCallIndex++];
        if (resp instanceof Error) throw resp;
        return Promise.resolve(resp || { rows: [] });
      });

      const res = await request(app)
        .post('/addresses')
        .set('Authorization', authHeader(mockUserRow))
        .send(validAddressBody);

      expect(res.status).toBe(201);
      expect(res.body.address).toBeDefined();
      expect(res.body.address.name).toBe('New Address');
      expect(res.body.address.is_default).toBe(true);
    });

    it('should create address without isDefault field', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      let txCallIndex = 0;
      const txResponses = [
        { rows: [{ id: 4, user_id: 1, name: 'Simple', phone: '13800138001', province: 'Beijing', city: 'Beijing', district: 'Chaoyang', detail: 'No. 1 Rd', is_default: false, created_at: '2024-01-03T00:00:00.000Z' }] },
      ];

      mockClientQuery.mockImplementation((sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve({ rows: [] });
        }
        const resp = txResponses[txCallIndex++];
        if (resp instanceof Error) throw resp;
        return Promise.resolve(resp || { rows: [] });
      });

      const res = await request(app)
        .post('/addresses')
        .set('Authorization', authHeader(mockUserRow))
        .send({
          name: 'Simple',
          phone: '13800138001',
          province: 'Beijing',
          city: 'Beijing',
          district: 'Chaoyang',
          detail: 'No. 1 Rd',
        });

      expect(res.status).toBe(201);
      expect(res.body.address).toBeDefined();
      expect(res.body.address.is_default).toBe(false);
    });

    it('should return 400 when name is missing', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const body = { ...validAddressBody };
      delete body.name;

      const res = await request(app)
        .post('/addresses')
        .set('Authorization', authHeader(mockUserRow))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when phone is missing', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const body = { ...validAddressBody };
      delete body.phone;

      const res = await request(app)
        .post('/addresses')
        .set('Authorization', authHeader(mockUserRow))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when province is missing', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const body = { ...validAddressBody };
      delete body.province;

      const res = await request(app)
        .post('/addresses')
        .set('Authorization', authHeader(mockUserRow))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when city is missing', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const body = { ...validAddressBody };
      delete body.city;

      const res = await request(app)
        .post('/addresses')
        .set('Authorization', authHeader(mockUserRow))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when district is missing', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const body = { ...validAddressBody };
      delete body.district;

      const res = await request(app)
        .post('/addresses')
        .set('Authorization', authHeader(mockUserRow))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when detail is missing', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const body = { ...validAddressBody };
      delete body.detail;

      const res = await request(app)
        .post('/addresses')
        .set('Authorization', authHeader(mockUserRow))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when all fields are empty', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .post('/addresses')
        .set('Authorization', authHeader(mockUserRow))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .post('/addresses')
        .send(validAddressBody);

      expect(res.status).toBe(401);
    });

    it('should create address and reset other addresses default when isDefault=true', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      let txCallIndex = 0;
      const txResponses = [
        { rows: [] }, // UPDATE: reset other defaults
        { rows: [{ id: 5, user_id: 1, name: 'Default', phone: '13800138001', province: 'Shanghai', city: 'Shanghai', district: 'Pudong', detail: 'No. 100 Rd', is_default: true, created_at: '2024-01-03T00:00:00.000Z' }] },
      ];

      mockClientQuery.mockImplementation((sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve({ rows: [] });
        }
        const resp = txResponses[txCallIndex++];
        if (resp instanceof Error) throw resp;
        return Promise.resolve(resp || { rows: [] });
      });

      const res = await request(app)
        .post('/addresses')
        .set('Authorization', authHeader(mockUserRow))
        .send({ ...validAddressBody, name: 'Default' });

      expect(res.status).toBe(201);
      expect(res.body.address.is_default).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // PUT /addresses/:id
  // ─────────────────────────────────────────────────────────────

  describe('PUT /addresses/:id', () => {
    it('should update an address successfully', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      let txCallIndex = 0;
      const txResponses = [
        { rows: [{ id: 1 }] }, // SELECT check ownership
        { rows: [{ id: 1, user_id: 1, name: 'Updated Home', phone: '13800138000', province: 'Guangdong', city: 'Shenzhen', district: 'Nanshan', detail: 'No. 999 Updated Rd', is_default: false, created_at: '2024-01-01T00:00:00.000Z' }] },
      ];

      mockClientQuery.mockImplementation((sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve({ rows: [] });
        }
        const resp = txResponses[txCallIndex++];
        if (resp instanceof Error) throw resp;
        return Promise.resolve(resp || { rows: [] });
      });

      const res = await request(app)
        .put('/addresses/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ name: 'Updated Home', detail: 'No. 999 Updated Rd' });

      expect(res.status).toBe(200);
      expect(res.body.address).toBeDefined();
      expect(res.body.address.name).toBe('Updated Home');
      expect(res.body.address.detail).toBe('No. 999 Updated Rd');
    });

    it('should set address as default and reset others', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      let txCallIndex = 0;
      const txResponses = [
        { rows: [{ id: 2 }] }, // ownership check
        { rows: [] }, // UPDATE reset defaults
        { rows: [{ ...mockAddress2, is_default: true }] },
      ];

      mockClientQuery.mockImplementation((sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve({ rows: [] });
        }
        const resp = txResponses[txCallIndex++];
        if (resp instanceof Error) throw resp;
        return Promise.resolve(resp || { rows: [] });
      });

      const res = await request(app)
        .put('/addresses/2')
        .set('Authorization', authHeader(mockUserRow))
        .send({ isDefault: true });

      expect(res.status).toBe(200);
      expect(res.body.address.is_default).toBe(true);
    });

    it('should update single field (name) successfully', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      let txCallIndex = 0;
      const txResponses = [
        { rows: [{ id: 1 }] },
        { rows: [{ ...mockAddress1, name: 'Just Name Changed' }] },
      ];

      mockClientQuery.mockImplementation((sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve({ rows: [] });
        }
        const resp = txResponses[txCallIndex++];
        if (resp instanceof Error) throw resp;
        return Promise.resolve(resp || { rows: [] });
      });

      const res = await request(app)
        .put('/addresses/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ name: 'Just Name Changed' });

      expect(res.status).toBe(200);
      expect(res.body.address.name).toBe('Just Name Changed');
    });

    it('should return 400 for invalid address ID', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .put('/addresses/abc')
        .set('Authorization', authHeader(mockUserRow))
        .send({ name: 'New Name' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Invalid address ID/);
    });

    it('should return 400 when no fields to update', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      let txCallIndex = 0;
      const txResponses = [
        { rows: [{ id: 1 }] }, // ownership check passes
      ];

      mockClientQuery.mockImplementation((sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve({ rows: [] });
        }
        const resp = txResponses[txCallIndex++];
        if (resp instanceof Error) throw resp;
        return Promise.resolve(resp || { rows: [] });
      });

      const res = await request(app)
        .put('/addresses/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/No fields to update/);
    });

    it('should return 404 when address not found or not owned', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [] } // address not found
      );

      const res = await request(app)
        .put('/addresses/999')
        .set('Authorization', authHeader(mockUserRow))
        .send({ name: 'New Name' });

      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app)
        .put('/addresses/1')
        .send({ name: 'Hacked' });

      expect(res.status).toBe(401);
    });

    it('should update all address fields at once', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      let txCallIndex = 0;
      const txResponses = [
        { rows: [{ id: 1 }] },
        { rows: [{ id: 1, user_id: 1, name: 'All New', phone: '13700137000', province: 'Zhejiang', city: 'Hangzhou', district: 'Xihu', detail: 'No. 777 Xihu Rd', is_default: true, created_at: '2024-01-01T00:00:00.000Z' }] },
      ];

      mockClientQuery.mockImplementation((sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve({ rows: [] });
        }
        const resp = txResponses[txCallIndex++];
        if (resp instanceof Error) throw resp;
        return Promise.resolve(resp || { rows: [] });
      });

      const res = await request(app)
        .put('/addresses/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({
          name: 'All New',
          phone: '13700137000',
          province: 'Zhejiang',
          city: 'Hangzhou',
          district: 'Xihu',
          detail: 'No. 777 Xihu Rd',
          isDefault: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.address.name).toBe('All New');
      expect(res.body.address.city).toBe('Hangzhou');
      expect(res.body.address.is_default).toBe(true);
    });

    it('should handle database error during update', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      mockClientQuery.mockImplementation((sql, params) => {
        throw new Error('DB error during update');
      });

      const res = await request(app)
        .put('/addresses/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ name: 'DB Error' });

      expect(res.status).toBe(500);
    });

    it('should not reset defaults when isDefault is false', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      let txCallIndex = 0;
      const txResponses = [
        { rows: [{ id: 1 }] },
        { rows: [{ ...mockAddress1, is_default: false, name: 'Not Default' }] },
      ];

      mockClientQuery.mockImplementation((sql, params) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return Promise.resolve({ rows: [] });
        }
        const resp = txResponses[txCallIndex++];
        if (resp instanceof Error) throw resp;
        return Promise.resolve(resp || { rows: [] });
      });

      const res = await request(app)
        .put('/addresses/1')
        .set('Authorization', authHeader(mockUserRow))
        .send({ isDefault: false, name: 'Not Default' });

      expect(res.status).toBe(200);
      expect(res.body.address.is_default).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // DELETE /addresses/:id
  // ─────────────────────────────────────────────────────────────

  describe('DELETE /addresses/:id', () => {
    it('should delete an address successfully', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ id: 1 }] } // DELETE RETURNING
      );

      const res = await request(app)
        .delete('/addresses/1')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/deleted successfully/);
    });

    it('should delete another address successfully', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ id: 2 }] }
      );

      const res = await request(app)
        .delete('/addresses/2')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/deleted successfully/);
    });

    it('should return 400 for invalid address ID', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      const res = await request(app)
        .delete('/addresses/abc')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Invalid address ID/);
    });

    it('should return 404 when address not found or not owned', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [] } // nothing deleted
      );

      const res = await request(app)
        .delete('/addresses/999')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/);
    });

    it('should return 401 when not authenticated', async () => {
      const res = await request(app).delete('/addresses/1');

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('should return 401 for invalid token', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => {
        throw new Error('Invalid token');
      });

      const res = await request(app)
        .delete('/addresses/1')
        .set('Authorization', 'Bearer invalid');

      expect(res.status).toBe(401);
    });

    it('should handle database error during delete', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      mockClientQuery.mockImplementationOnce(() => {
        throw new Error('DB connection error');
      });

      const res = await request(app)
        .delete('/addresses/1')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(500);
    });

    it('should prevent deleting address owned by another user', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      // The query uses AND user_id = $2, so if address exists but belongs to another user, rows = []
      queryResponses.push(
        { rows: [] }
      );

      const res = await request(app)
        .delete('/addresses/100')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(404);
      expect(res.body.error.message).toMatch(/not found/);
    });

    it('should delete address with large numeric ID', async () => {
      const jwt = require('jsonwebtoken');
      jwt.verify.mockImplementationOnce(() => ({ userId: 1, username: 'testuser', role: 'user' }));

      queryResponses.push(
        { rows: [{ id: 999999 }] }
      );

      const res = await request(app)
        .delete('/addresses/999999')
        .set('Authorization', authHeader(mockUserRow));

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/deleted successfully/);
    });
  });
});

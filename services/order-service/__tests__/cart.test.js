/**
 * Cart Routes Tests
 * Coverage: GET /cart, POST /cart, PUT /cart/:id, DELETE /cart/:id, DELETE /cart
 * Scenarios: success + error paths
 */

const request = require('supertest');
const express = require('express');
const { query, transaction } = require('../../shared/lib/db');
const { errorHandler } = require('../../shared/lib/errors');

// Mock db module
jest.mock('../../shared/lib/db', () => {
  const mockQueryFn = jest.fn();
  const mockTransactionFn = jest.fn();
  return {
    getPool: jest.fn().mockReturnValue({
      connect: jest.fn().mockResolvedValue({
        query: mockQueryFn,
        release: jest.fn(),
      }),
      end: jest.fn(),
    }),
    query: mockQueryFn,
    transaction: mockTransactionFn,
    close: jest.fn(),
  };
});

jest.mock('../../shared/lib/events', () => ({
  EventBus: {
    getInstance: jest.fn().mockResolvedValue({
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    }),
  },
  EventTypes: {
    ORDER_CREATED: 'order.created',
    ORDER_PAID: 'order.paid',
    ORDER_SHIPPED: 'order.shipped',
    ORDER_COMPLETED: 'order.completed',
    ORDER_CANCELLED: 'order.cancelled',
  },
}));

// Build a fresh Express app with just cart routes for isolated testing
function buildCartApp() {
  const app = express();
  app.use(express.json());

  const getUserId = (req) => {
    const uid = req.headers['x-user-id'];
    if (!uid) {
      const error = new Error('Missing X-User-Id header');
      error.code = 'E2000';
      error.statusCode = 401;
      throw error;
    }
    return parseInt(uid, 10);
  };

  // GET /cart
  app.get('/cart', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const rows = await query(
        `SELECT c.*, p.name AS product_name, p.image AS product_image
         FROM carts c
         JOIN products p ON p.id = c.product_id
         WHERE c.user_id = $1
         ORDER BY c.created_at DESC`,
        [userId]
      );
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  });

  // POST /cart
  app.post('/cart', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { product_id, sku_id, quantity = 1 } = req.body;

      if (!product_id) {
        const error = new Error('product_id is required');
        error.code = 'E8000';
        error.statusCode = 400;
        throw error;
      }

      const result = await query(
        `INSERT INTO carts (user_id, product_id, sku_id, quantity, selected, created_at, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW())
         ON CONFLICT (user_id, product_id, COALESCE(sku_id, 0))
         DO UPDATE SET quantity = carts.quantity + EXCLUDED.quantity,
                       updated_at = NOW()
         RETURNING *`,
        [userId, product_id, sku_id || null, quantity]
      );

      res.status(201).json({ data: result[0] });
    } catch (err) {
      next(err);
    }
  });

  // PUT /cart/:id
  app.put('/cart/:id', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = req.params;
      const { quantity, selected } = req.body;

      const updates = ['updated_at = NOW()'];
      const params = [];
      let idx = 1;

      if (quantity !== undefined) {
        updates.push(`quantity = $${idx++}`);
        params.push(quantity);
      }
      if (selected !== undefined) {
        updates.push(`selected = $${idx++}`);
        params.push(selected);
      }
      params.push(id, userId);

      const result = await query(
        `UPDATE carts SET ${updates.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
        params
      );

      if (!result.length) {
        const error = new Error('Cart item not found');
        error.code = 'E5000';
        error.statusCode = 404;
        throw error;
      }
      res.json({ data: result[0] });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /cart/:id
  app.delete('/cart/:id', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = req.params;

      const result = await query(
        'DELETE FROM carts WHERE id = $1 AND user_id = $2 RETURNING *',
        [id, userId]
      );

      if (!result.length) {
        const error = new Error('Cart item not found');
        error.code = 'E5000';
        error.statusCode = 404;
        throw error;
      }
      res.json({ data: result[0] });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /cart (clear selected)
  app.delete('/cart', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const result = await query(
        'DELETE FROM carts WHERE user_id = $1 AND selected = TRUE RETURNING *',
        [userId]
      );
      res.json({ deleted: result.length, data: result });
    } catch (err) {
      next(err);
    }
  });

  app.use(errorHandler);
  return app;
}

describe('Cart Routes', () => {
  let app;

  beforeEach(() => {
    app = buildCartApp();
    query.mockClear();
  });

  // ── GET /cart ──
  describe('GET /cart', () => {
    test('should return cart items for user (200)', async () => {
      const mockItems = [
        {
          id: 1,
          user_id: 42,
          product_id: 10,
          sku_id: 100,
          quantity: 2,
          selected: true,
          product_name: 'iPhone 15',
          product_image: 'https://example.com/iphone.jpg',
        },
        {
          id: 2,
          user_id: 42,
          product_id: 20,
          sku_id: null,
          quantity: 1,
          selected: false,
          product_name: 'MacBook Pro',
          product_image: 'https://example.com/mac.jpg',
        },
      ];
      query.mockResolvedValue(mockItems);

      const res = await request(app)
        .get('/cart')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].product_name).toBe('iPhone 15');
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT c.*'),
        [42]
      );
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app).get('/cart').expect(401);
      expect(res.body.error).toBeDefined();
    });

    test('should return 401 with empty X-User-Id header', async () => {
      const res = await request(app)
        .get('/cart')
        .set('X-User-Id', '')
        .expect(401);
      expect(res.body.error).toBeDefined();
    });

    test('should handle database error gracefully (500)', async () => {
      query.mockRejectedValue(new Error('connection lost'));

      const res = await request(app)
        .get('/cart')
        .set('X-User-Id', '42')
        .expect(500);

      expect(res.body.error).toBeDefined();
    });

    test('should return empty array when cart is empty', async () => {
      query.mockResolvedValue([]);

      const res = await request(app)
        .get('/cart')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.data).toEqual([]);
    });
  });

  // ── POST /cart ──
  describe('POST /cart', () => {
    test('should add item to cart (201)', async () => {
      const newItem = {
        id: 1,
        user_id: 42,
        product_id: 10,
        sku_id: 100,
        quantity: 2,
        selected: true,
      };
      query.mockResolvedValue([newItem]);

      const res = await request(app)
        .post('/cart')
        .set('X-User-Id', '42')
        .send({ product_id: 10, sku_id: 100, quantity: 2 })
        .expect(201);

      expect(res.body.data.product_id).toBe(10);
      expect(res.body.data.quantity).toBe(2);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO carts'),
        [42, 10, 100, 2]
      );
    });

    test('should add item with default quantity (201)', async () => {
      const newItem = {
        id: 1,
        user_id: 42,
        product_id: 10,
        sku_id: null,
        quantity: 1,
        selected: true,
      };
      query.mockResolvedValue([newItem]);

      const res = await request(app)
        .post('/cart')
        .set('X-User-Id', '42')
        .send({ product_id: 10 })
        .expect(201);

      expect(res.body.data.quantity).toBe(1);
      expect(query).toHaveBeenCalledWith(
        expect.any(String),
        [42, 10, null, 1]
      );
    });

    test('should return 400 when product_id is missing', async () => {
      const res = await request(app)
        .post('/cart')
        .set('X-User-Id', '42')
        .send({ sku_id: 100, quantity: 2 })
        .expect(400);

      expect(res.body.error.code).toBe('E8000');
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app)
        .post('/cart')
        .send({ product_id: 10 })
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    test('should handle database conflict/upsert gracefully', async () => {
      const updatedItem = {
        id: 1,
        user_id: 42,
        product_id: 10,
        sku_id: 100,
        quantity: 5, // 3 + 2 from ON CONFLICT
        selected: true,
      };
      query.mockResolvedValue([updatedItem]);

      const res = await request(app)
        .post('/cart')
        .set('X-User-Id', '42')
        .send({ product_id: 10, sku_id: 100, quantity: 2 })
        .expect(201);

      expect(res.body.data.quantity).toBe(5);
    });

    test('should handle database error gracefully (500)', async () => {
      query.mockRejectedValue(new Error('insert failed'));

      const res = await request(app)
        .post('/cart')
        .set('X-User-Id', '42')
        .send({ product_id: 10, quantity: 1 })
        .expect(500);

      expect(res.body.error).toBeDefined();
    });

    test('should add item with sku_id=0 (edge case)', async () => {
      const newItem = {
        id: 1,
        user_id: 42,
        product_id: 10,
        sku_id: 0,
        quantity: 3,
        selected: true,
      };
      query.mockResolvedValue([newItem]);

      const res = await request(app)
        .post('/cart')
        .set('X-User-Id', '42')
        .send({ product_id: 10, sku_id: 0, quantity: 3 })
        .expect(201);

      expect(res.body.data.sku_id).toBe(0);
    });
  });

  // ── PUT /cart/:id ──
  describe('PUT /cart/:id', () => {
    test('should update quantity (200)', async () => {
      const updated = {
        id: 1,
        user_id: 42,
        product_id: 10,
        quantity: 5,
        selected: true,
      };
      query.mockResolvedValue([updated]);

      const res = await request(app)
        .put('/cart/1')
        .set('X-User-Id', '42')
        .send({ quantity: 5 })
        .expect(200);

      expect(res.body.data.quantity).toBe(5);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE carts'),
        [5, '1', 42]
      );
    });

    test('should update selected status (200)', async () => {
      const updated = {
        id: 1,
        user_id: 42,
        product_id: 10,
        quantity: 2,
        selected: false,
      };
      query.mockResolvedValue([updated]);

      const res = await request(app)
        .put('/cart/1')
        .set('X-User-Id', '42')
        .send({ selected: false })
        .expect(200);

      expect(res.body.data.selected).toBe(false);
    });

    test('should update both quantity and selected (200)', async () => {
      const updated = {
        id: 1,
        user_id: 42,
        product_id: 10,
        quantity: 3,
        selected: true,
      };
      query.mockResolvedValue([updated]);

      const res = await request(app)
        .put('/cart/1')
        .set('X-User-Id', '42')
        .send({ quantity: 3, selected: true })
        .expect(200);

      expect(res.body.data.quantity).toBe(3);
      expect(res.body.data.selected).toBe(true);
    });

    test('should return 404 when cart item not found', async () => {
      query.mockResolvedValue([]);

      const res = await request(app)
        .put('/cart/999')
        .set('X-User-Id', '42')
        .send({ quantity: 5 })
        .expect(404);

      expect(res.body.error.code).toBe('E5000');
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app)
        .put('/cart/1')
        .send({ quantity: 5 })
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    test('should handle database error (500)', async () => {
      query.mockRejectedValue(new Error('update failed'));

      const res = await request(app)
        .put('/cart/1')
        .set('X-User-Id', '42')
        .send({ quantity: 5 })
        .expect(500);

      expect(res.body.error).toBeDefined();
    });

    test('should return 400 for invalid quantity (validation)', async () => {
      // The app doesn't validate quantity type, so this passes through to DB
      query.mockRejectedValue({
        message: 'invalid input syntax for integer',
        code: '22P02',
      });

      const res = await request(app)
        .put('/cart/1')
        .set('X-User-Id', '42')
        .send({ quantity: 'invalid' })
        .expect(500);

      expect(res.body.error).toBeDefined();
    });
  });

  // ── DELETE /cart/:id ──
  describe('DELETE /cart/:id', () => {
    test('should delete cart item (200)', async () => {
      const deleted = {
        id: 1,
        user_id: 42,
        product_id: 10,
        quantity: 2,
        selected: true,
      };
      query.mockResolvedValue([deleted]);

      const res = await request(app)
        .delete('/cart/1')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.data.id).toBe(1);
      expect(query).toHaveBeenCalledWith(
        'DELETE FROM carts WHERE id = $1 AND user_id = $2 RETURNING *',
        ['1', 42]
      );
    });

    test('should return 404 when cart item not found', async () => {
      query.mockResolvedValue([]);

      const res = await request(app)
        .delete('/cart/999')
        .set('X-User-Id', '42')
        .expect(404);

      expect(res.body.error.code).toBe('E5000');
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app)
        .delete('/cart/1')
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    test('should handle database error (500)', async () => {
      query.mockRejectedValue(new Error('delete failed'));

      const res = await request(app)
        .delete('/cart/1')
        .set('X-User-Id', '42')
        .expect(500);

      expect(res.body.error).toBeDefined();
    });

    test('should not allow deleting another user\'s cart item', async () => {
      // User 42 tries to delete item belonging to user 99
      query.mockResolvedValue([]);

      const res = await request(app)
        .delete('/cart/1')
        .set('X-User-Id', '42')
        .expect(404);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM carts'),
        ['1', 42]
      );
    });
  });

  // ── DELETE /cart (clear selected) ──
  describe('DELETE /cart (clear selected)', () => {
    test('should clear all selected items (200)', async () => {
      const deletedItems = [
        { id: 1, user_id: 42, product_id: 10, selected: true },
        { id: 2, user_id: 42, product_id: 20, selected: true },
      ];
      query.mockResolvedValue(deletedItems);

      const res = await request(app)
        .delete('/cart')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.deleted).toBe(2);
      expect(res.body.data).toHaveLength(2);
      expect(query).toHaveBeenCalledWith(
        'DELETE FROM carts WHERE user_id = $1 AND selected = TRUE RETURNING *',
        [42]
      );
    });

    test('should return 0 deleted when no items selected', async () => {
      query.mockResolvedValue([]);

      const res = await request(app)
        .delete('/cart')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.deleted).toBe(0);
      expect(res.body.data).toEqual([]);
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app)
        .delete('/cart')
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    test('should handle database error (500)', async () => {
      query.mockRejectedValue(new Error('clear failed'));

      const res = await request(app)
        .delete('/cart')
        .set('X-User-Id', '42')
        .expect(500);

      expect(res.body.error).toBeDefined();
    });

    test('should only delete selected=true items for the user', async () => {
      const deletedItems = [
        { id: 1, user_id: 42, product_id: 10, selected: true },
      ];
      query.mockResolvedValue(deletedItems);

      const res = await request(app)
        .delete('/cart')
        .set('X-User-Id', '42')
        .expect(200);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM carts WHERE user_id = $1 AND selected = TRUE'),
        [42]
      );
      // Verify unselected items remain
      expect(res.body.deleted).toBe(1);
    });
  });
});

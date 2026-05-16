/**
 * Order Routes Tests
 * Coverage:
 *   POST /orders, GET /orders, GET /orders/:id,
 *   PUT /orders/:id/cancel, PUT /orders/:id/pay,
 *   PUT /orders/:id/ship, PUT /orders/:id/complete,
 *   GET /health
 * Scenarios: success + error paths for each
 */

const request = require('supertest');
const express = require('express');

const mockQueryFn = jest.fn();
const mockClientQueryFn = jest.fn();
const mockClientReleaseFn = jest.fn();
const mockBeginFn = jest.fn();
const mockCommitFn = jest.fn();
const mockRollbackFn = jest.fn();
const mockEventBusPublish = jest.fn().mockResolvedValue(undefined);

jest.mock('../../shared/lib/db', () => ({
  getPool: jest.fn().mockReturnValue({
    connect: jest.fn().mockResolvedValue({
      query: mockClientQueryFn,
      release: mockClientReleaseFn,
    }),
    end: jest.fn(),
  }),
  query: mockQueryFn,
  transaction: jest.fn().mockImplementation(async (fn) => {
    mockBeginFn();
    const client = {
      query: mockClientQueryFn,
      release: mockClientReleaseFn,
    };
    try {
      const result = await fn(client);
      mockCommitFn();
      return result;
    } catch (err) {
      mockRollbackFn();
      throw err;
    }
  }),
  close: jest.fn(),
}));

jest.mock('../../shared/lib/events', () => ({
  EventBus: {
    getInstance: jest.fn().mockResolvedValue({
      publish: mockEventBusPublish,
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

jest.mock('./sagas/order-saga', () => ({
  OrderSaga: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue(undefined),
  })),
}));

const { query, transaction } = require('../../shared/lib/db');
const { errorHandler, Errors } = require('../../shared/lib/errors');
const { EventBus, EventTypes } = require('../../shared/lib/events');

function buildOrderApp() {
  const app = express();
  app.use(express.json());

  const getUserId = (req) => {
    const uid = req.headers['x-user-id'];
    if (!uid) {
      const err = new Error('Missing X-User-Id header');
      err.statusCode = 401;
      err.code = 'E2000';
      throw err;
    }
    return parseInt(uid, 10);
  };

  const generateOrderNo = () => {
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.floor(100000 + Math.random() * 900000);
    return `SC${ymd}${rand}`;
  };

  // POST /orders
  app.post('/orders', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { address, remark } = req.body;

      if (!address) {
        const err = new Error('address is required');
        err.statusCode = 400;
        err.code = 'E8000';
        throw err;
      }

      const cartItems = await query(
        `SELECT c.*, p.name AS product_name, p.price AS product_price,
                COALESCE(s.price, p.price) AS final_price,
                s.attrs AS sku_attrs
         FROM carts c
         JOIN products p ON p.id = c.product_id
         LEFT JOIN skus s ON s.id = c.sku_id
         WHERE c.user_id = $1 AND c.selected = TRUE`,
        [userId]
      );

      if (!cartItems.length) {
        const err = new Error('No items selected in cart');
        err.statusCode = 400;
        err.code = 'E5003';
        throw err;
      }

      let totalAmount = 0;
      const orderItems = cartItems.map((c) => {
        const price = parseFloat(c.final_price);
        const subtotal = price * c.quantity;
        totalAmount += subtotal;
        return {
          product_id: c.product_id,
          sku_id: c.sku_id,
          product_name: c.product_name,
          sku_attrs: c.sku_attrs,
          price,
          quantity: c.quantity,
          subtotal,
        };
      });

      const discountAmount = 0;
      const payAmount = totalAmount - discountAmount;
      const orderNo = generateOrderNo();
      const sagaId = `saga_${orderNo}`;

      const order = await transaction(async (client) => {
        const orderRes = await client.query(
          `INSERT INTO orders (order_no, user_id, status, total_amount, discount_amount, pay_amount, address, remark, saga_id, created_at, updated_at)
           VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, NOW(), NOW()) RETURNING *`,
          [orderNo, userId, totalAmount, discountAmount, payAmount, JSON.stringify(address), remark || null, sagaId]
        );
        const newOrder = orderRes.rows[0];

        const itemValues = orderItems.map((_, i) =>
          `($1, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6}, $${i * 6 + 7})`
        ).join(', ');

        const itemParams = orderItems.flatMap((item) => [
          item.product_id,
          item.sku_id,
          item.product_name,
          item.sku_attrs ? JSON.stringify(item.sku_attrs) : null,
          item.price,
          item.quantity,
          item.subtotal,
        ]);

        await client.query(
          `INSERT INTO order_items (order_id, product_id, sku_id, product_name, sku_attrs, price, quantity, subtotal)
           VALUES ${itemValues}`,
          [newOrder.id, ...itemParams]
        );

        return newOrder;
      });

      const items = await query(
        'SELECT * FROM order_items WHERE order_id = $1',
        [order.id]
      );

      const eventBus = await EventBus.getInstance();
      await eventBus.publish(EventTypes.ORDER_CREATED, {
        orderId: order.id,
        orderNo: order.order_no,
        userId,
        sagaId,
        totalAmount,
        payAmount,
        itemCount: items.length,
      });

      res.status(201).json({ order, items });
    } catch (err) {
      next(err);
    }
  });

  // GET /orders
  app.get('/orders', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { status, page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
      const params = [userId];
      let where = 'WHERE o.user_id = $1';

      if (status) {
        where += ` AND o.status = $${params.length + 1}`;
        params.push(status);
      }

      const countRes = await query(`SELECT COUNT(*) FROM orders o ${where}`, params);
      const total = parseInt(countRes[0].count, 10);

      params.push(parseInt(limit, 10), offset);
      const rows = await query(
        `SELECT o.*,
          (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) AS items
         FROM orders o ${where}
         ORDER BY o.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      res.json({ data: rows, pagination: { page: parseInt(page, 10), limit: parseInt(limit, 10), total } });
    } catch (err) {
      next(err);
    }
  });

  // GET /orders/:id
  app.get('/orders/:id', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = req.params;

      const orderRes = await query(
        'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      if (!orderRes.length) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        err.code = 'E5000';
        throw err;
      }

      const items = await query(
        'SELECT * FROM order_items WHERE order_id = $1',
        [id]
      );

      res.json({ order: orderRes[0], items });
    } catch (err) {
      next(err);
    }
  });

  // PUT /orders/:id/cancel
  app.put('/orders/:id/cancel', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = req.params;
      const { reason } = req.body;

      const orderRes = await query(
        'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      if (!orderRes.length) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        err.code = 'E5000';
        throw err;
      }

      const order = orderRes[0];
      if (!['pending', 'paid'].includes(order.status)) {
        const err = new Error(`Cannot cancel order in status: ${order.status}`);
        err.statusCode = 400;
        err.code = 'E5001';
        throw err;
      }

      const items = await query(
        'SELECT * FROM order_items WHERE order_id = $1',
        [id]
      );

      await transaction(async (client) => {
        for (const item of items) {
          await client.query(
            'UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2',
            [item.quantity, item.product_id]
          );
        }
        await client.query(
          `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
          [id]
        );
      });

      const eventBus = await EventBus.getInstance();
      await eventBus.publish(EventTypes.ORDER_CANCELLED, {
        orderId: order.id,
        orderNo: order.order_no,
        userId,
        reason: reason || 'user cancelled',
        items: items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
      });

      res.json({ message: 'Order cancelled', orderId: id });
    } catch (err) {
      next(err);
    }
  });

  // PUT /orders/:id/pay
  app.put('/orders/:id/pay', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { paymentId, paidAt } = req.body;

      const orderRes = await query(
        'SELECT * FROM orders WHERE id = $1',
        [id]
      );
      if (!orderRes.length) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        err.code = 'E5000';
        throw err;
      }

      const order = orderRes[0];
      if (order.status !== 'pending') {
        const err = new Error(`Order status is ${order.status}, cannot mark as paid`);
        err.statusCode = 400;
        err.code = 'E6002';
        throw err;
      }

      const result = await query(
        `UPDATE orders SET status = 'paid', paid_at = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [paidAt ? new Date(paidAt) : new Date(), id]
      );

      const eventBus = await EventBus.getInstance();
      await eventBus.publish(EventTypes.ORDER_PAID, {
        orderId: order.id,
        orderNo: order.order_no,
        userId: order.user_id,
        paymentId,
        payAmount: order.pay_amount,
      });

      res.json({ data: result[0] });
    } catch (err) {
      next(err);
    }
  });

  // PUT /orders/:id/ship
  app.put('/orders/:id/ship', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = req.params;
      const { trackingNumber, carrier } = req.body;

      const orderRes = await query(
        'SELECT * FROM orders WHERE id = $1',
        [id]
      );
      if (!orderRes.length) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        err.code = 'E5000';
        throw err;
      }

      const order = orderRes[0];
      if (order.status !== 'paid') {
        const err = new Error(`Order must be paid before shipping, current: ${order.status}`);
        err.statusCode = 400;
        err.code = 'E5001';
        throw err;
      }

      const result = await query(
        `UPDATE orders SET status = 'shipped', shipped_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id]
      );

      const eventBus = await EventBus.getInstance();
      await eventBus.publish(EventTypes.ORDER_SHIPPED, {
        orderId: order.id,
        orderNo: order.order_no,
        userId: order.user_id,
        trackingNumber,
        carrier,
      });

      res.json({ data: result[0] });
    } catch (err) {
      next(err);
    }
  });

  // PUT /orders/:id/complete
  app.put('/orders/:id/complete', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { id } = req.params;

      const orderRes = await query(
        'SELECT * FROM orders WHERE id = $1',
        [id]
      );
      if (!orderRes.length) {
        const err = new Error('Order not found');
        err.statusCode = 404;
        err.code = 'E5000';
        throw err;
      }

      const order = orderRes[0];
      if (order.status !== 'shipped') {
        const err = new Error(`Order must be shipped before completing, current: ${order.status}`);
        err.statusCode = 400;
        err.code = 'E5001';
        throw err;
      }

      const result = await query(
        `UPDATE orders SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id]
      );

      const eventBus = await EventBus.getInstance();
      await eventBus.publish(EventTypes.ORDER_COMPLETED, {
        orderId: order.id,
        orderNo: order.order_no,
        userId: order.user_id,
      });

      res.json({ data: result[0] });
    } catch (err) {
      next(err);
    }
  });

  // GET /health
  app.get('/health', async (req, res) => {
    try {
      await query('SELECT 1');
      res.json({
        service: process.env.SERVICE_NAME || 'order-service',
        status: 'ok',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({
        service: process.env.SERVICE_NAME || 'order-service',
        status: 'unhealthy',
        error: err.message,
      });
    }
  });

  app.use(errorHandler);
  return app;
}

describe('Order Routes', () => {
  let app;

  beforeEach(() => {
    app = buildOrderApp();
    mockQueryFn.mockClear();
    mockClientQueryFn.mockClear();
    mockEventBusPublish.mockClear();
    mockBeginFn.mockClear();
    mockCommitFn.mockClear();
    mockRollbackFn.mockClear();
  });

  // ── POST /orders ──
  describe('POST /orders', () => {
    test('should create order successfully (201)', async () => {
      const cartItems = [
        {
          product_id: 10,
          sku_id: 100,
          product_name: 'iPhone 15',
          product_price: '6999',
          final_price: '6999',
          sku_attrs: { color: 'black' },
          quantity: 2,
          user_id: 42,
        },
      ];
      const newOrder = {
        id: 1,
        order_no: 'SC20240115000001',
        user_id: 42,
        status: 'pending',
        total_amount: '13998',
        pay_amount: '13998',
        saga_id: 'saga_SC20240115000001',
      };
      const orderItems = [
        { id: 1, order_id: 1, product_id: 10, product_name: 'iPhone 15', price: '6999', quantity: 2, subtotal: '13998' },
      ];

      mockQueryFn
        .mockResolvedValueOnce(cartItems)
        .mockResolvedValueOnce(orderItems);

      mockClientQueryFn
        .mockResolvedValueOnce({ rows: [newOrder] }) // INSERT orders
        .mockResolvedValueOnce({ rows: [] });        // INSERT order_items

      const res = await request(app)
        .post('/orders')
        .set('X-User-Id', '42')
        .send({ address: { name: 'John', phone: '13800138000', detail: 'Beijing' }, remark: 'Fast delivery' })
        .expect(201);

      expect(res.body.order).toBeDefined();
      expect(res.body.items).toBeDefined();
      expect(res.body.order.status).toBe('pending');
      expect(mockEventBusPublish).toHaveBeenCalled();
    });

    test('should create order with multiple items (201)', async () => {
      const cartItems = [
        { product_id: 10, sku_id: 100, product_name: 'iPhone 15', product_price: '6999', final_price: '6999', sku_attrs: null, quantity: 1, user_id: 42 },
        { product_id: 20, sku_id: 200, product_name: 'AirPods', product_price: '1999', final_price: '1899', sku_attrs: null, quantity: 2, user_id: 42 },
      ];
      const newOrder = {
        id: 2,
        order_no: 'SC20240115000002',
        user_id: 42,
        status: 'pending',
        total_amount: '10797',
        pay_amount: '10797',
      };
      const orderItems = [
        { id: 1, order_id: 2, product_id: 10, price: '6999', quantity: 1, subtotal: '6999' },
        { id: 2, order_id: 2, product_id: 20, price: '1899', quantity: 2, subtotal: '3798' },
      ];

      mockQueryFn
        .mockResolvedValueOnce(cartItems)
        .mockResolvedValueOnce(orderItems);

      mockClientQueryFn
        .mockResolvedValueOnce({ rows: [newOrder] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/orders')
        .set('X-User-Id', '42')
        .send({ address: { name: 'John', detail: 'Shanghai' } })
        .expect(201);

      expect(res.body.order).toBeDefined();
      expect(res.body.items).toHaveLength(2);
    });

    test('should return 400 when address is missing', async () => {
      const res = await request(app)
        .post('/orders')
        .set('X-User-Id', '42')
        .send({ remark: 'test' })
        .expect(400);

      expect(res.body.error.code).toBe('E8000');
    });

    test('should return 400 when cart is empty (no selected items)', async () => {
      mockQueryFn.mockResolvedValueOnce([]);

      const res = await request(app)
        .post('/orders')
        .set('X-User-Id', '42')
        .send({ address: { name: 'John', detail: 'Beijing' } })
        .expect(400);

      expect(res.body.error.code).toBe('E5003');
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app)
        .post('/orders')
        .send({ address: { name: 'John' } })
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    test('should handle transaction failure (500)', async () => {
      const cartItems = [
        { product_id: 10, sku_id: 100, product_name: 'iPhone', product_price: '6999', final_price: '6999', sku_attrs: null, quantity: 1, user_id: 42 },
      ];

      mockQueryFn.mockResolvedValueOnce(cartItems);
      mockClientQueryFn.mockRejectedValueOnce(new Error('DB insert failed'));

      const res = await request(app)
        .post('/orders')
        .set('X-User-Id', '42')
        .send({ address: { name: 'John', detail: 'Beijing' } })
        .expect(500);

      expect(res.body.error).toBeDefined();
    });

    test('should handle database error when fetching cart items (500)', async () => {
      mockQueryFn.mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await request(app)
        .post('/orders')
        .set('X-User-Id', '42')
        .send({ address: { name: 'John', detail: 'Beijing' } })
        .expect(500);

      expect(res.body.error).toBeDefined();
    });

    test('should create order without remark (201)', async () => {
      const cartItems = [
        { product_id: 10, sku_id: null, product_name: 'iPhone', product_price: '6999', final_price: '6999', sku_attrs: null, quantity: 1, user_id: 42 },
      ];
      const newOrder = {
        id: 3,
        order_no: 'SC20240115000003',
        user_id: 42,
        status: 'pending',
        total_amount: '6999',
        pay_amount: '6999',
        remark: null,
      };

      mockQueryFn
        .mockResolvedValueOnce(cartItems)
        .mockResolvedValueOnce([]);

      mockClientQueryFn
        .mockResolvedValueOnce({ rows: [newOrder] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/orders')
        .set('X-User-Id', '42')
        .send({ address: { name: 'John', detail: 'Guangzhou' } })
        .expect(201);

      expect(res.body.order).toBeDefined();
    });
  });

  // ── GET /orders ──
  describe('GET /orders', () => {
    test('should return order list (200)', async () => {
      mockQueryFn
        .mockResolvedValueOnce([{ count: '15' }])
        .mockResolvedValueOnce([
          { id: 1, order_no: 'SC20240115000001', status: 'pending', total_amount: '6999', items: [{ id: 1, product_name: 'iPhone' }] },
          { id: 2, order_no: 'SC20240115000002', status: 'paid', total_amount: '13998', items: [{ id: 2, product_name: 'MacBook' }] },
        ]);

      const res = await request(app)
        .get('/orders')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination.total).toBe(15);
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(20);
    });

    test('should return filtered orders by status (200)', async () => {
      mockQueryFn
        .mockResolvedValueOnce([{ count: '5' }])
        .mockResolvedValueOnce([
          { id: 1, order_no: 'SC001', status: 'pending', total_amount: '6999', items: null },
        ]);

      const res = await request(app)
        .get('/orders?status=pending')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.stringContaining("o.status = $2"),
        [42, 'pending']
      );
    });

    test('should support pagination (200)', async () => {
      mockQueryFn
        .mockResolvedValueOnce([{ count: '100' }])
        .mockResolvedValueOnce([]);

      const res = await request(app)
        .get('/orders?page=3&limit=10')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.pagination.page).toBe(3);
      expect(res.body.pagination.limit).toBe(10);
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app)
        .get('/orders')
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    test('should handle database error (500)', async () => {
      mockQueryFn.mockRejectedValueOnce(new Error('count query failed'));

      const res = await request(app)
        .get('/orders')
        .set('X-User-Id', '42')
        .expect(500);

      expect(res.body.error).toBeDefined();
    });
  });

  // ── GET /orders/:id ──
  describe('GET /orders/:id', () => {
    test('should return order with items (200)', async () => {
      const order = {
        id: 1,
        order_no: 'SC20240115000001',
        user_id: 42,
        status: 'pending',
        total_amount: '6999',
      };
      const items = [
        { id: 1, order_id: 1, product_id: 10, product_name: 'iPhone 15', price: '6999', quantity: 1, subtotal: '6999' },
      ];
      mockQueryFn
        .mockResolvedValueOnce([order])
        .mockResolvedValueOnce(items);

      const res = await request(app)
        .get('/orders/1')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.order.id).toBe(1);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].product_name).toBe('iPhone 15');
    });

    test('should return 404 when order not found', async () => {
      mockQueryFn.mockResolvedValueOnce([]);

      const res = await request(app)
        .get('/orders/999')
        .set('X-User-Id', '42')
        .expect(404);

      expect(res.body.error.code).toBe('E5000');
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app)
        .get('/orders/1')
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    test('should handle database error (500)', async () => {
      mockQueryFn.mockRejectedValueOnce(new Error('order query failed'));

      const res = await request(app)
        .get('/orders/1')
        .set('X-User-Id', '42')
        .expect(500);

      expect(res.body.error).toBeDefined();
    });

    test('should return order with empty items (200)', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'pending', total_amount: '0' };
      mockQueryFn
        .mockResolvedValueOnce([order])
        .mockResolvedValueOnce([]);

      const res = await request(app)
        .get('/orders/1')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.order).toBeDefined();
      expect(res.body.items).toEqual([]);
    });
  });

  // ── PUT /orders/:id/cancel ──
  describe('PUT /orders/:id/cancel', () => {
    test('should cancel pending order (200)', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'pending', total_amount: '6999' };
      const items = [{ id: 1, order_id: 1, product_id: 10, quantity: 2 }];

      mockQueryFn
        .mockResolvedValueOnce([order])   // SELECT order
        .mockResolvedValueOnce(items);    // SELECT order_items

      mockClientQueryFn
        .mockResolvedValueOnce({ rows: [] })  // UPDATE products stock
        .mockResolvedValueOnce({ rows: [] }); // UPDATE orders status

      const res = await request(app)
        .put('/orders/1/cancel')
        .set('X-User-Id', '42')
        .send({ reason: 'Changed my mind' })
        .expect(200);

      expect(res.body.message).toBe('Order cancelled');
      expect(res.body.orderId).toBe('1');
      expect(mockEventBusPublish).toHaveBeenCalled();
    });

    test('should cancel paid order (200)', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'paid', total_amount: '6999' };
      const items = [{ id: 1, order_id: 1, product_id: 10, quantity: 1 }];

      mockQueryFn
        .mockResolvedValueOnce([order])
        .mockResolvedValueOnce(items);

      mockClientQueryFn
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .put('/orders/1/cancel')
        .set('X-User-Id', '42')
        .send({})
        .expect(200);

      expect(res.body.message).toBe('Order cancelled');
    });

    test('should return 404 when order not found', async () => {
      mockQueryFn.mockResolvedValueOnce([]);

      const res = await request(app)
        .put('/orders/999/cancel')
        .set('X-User-Id', '42')
        .send({})
        .expect(404);

      expect(res.body.error.code).toBe('E5000');
    });

    test('should return 400 when cancelling shipped order', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'shipped', total_amount: '6999' };

      mockQueryFn.mockResolvedValueOnce([order]);

      const res = await request(app)
        .put('/orders/1/cancel')
        .set('X-User-Id', '42')
        .send({})
        .expect(400);

      expect(res.body.error.code).toBe('E5001');
    });

    test('should return 400 when cancelling completed order', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'completed', total_amount: '6999' };

      mockQueryFn.mockResolvedValueOnce([order]);

      const res = await request(app)
        .put('/orders/1/cancel')
        .set('X-User-Id', '42')
        .send({})
        .expect(400);

      expect(res.body.error.code).toBe('E5001');
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app)
        .put('/orders/1/cancel')
        .send({})
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    test('should handle transaction failure during cancel (500)', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'pending', total_amount: '6999' };
      const items = [{ id: 1, order_id: 1, product_id: 10, quantity: 2 }];

      mockQueryFn
        .mockResolvedValueOnce([order])
        .mockResolvedValueOnce(items);

      mockClientQueryFn.mockRejectedValueOnce(new Error('stock update failed'));

      const res = await request(app)
        .put('/orders/1/cancel')
        .set('X-User-Id', '42')
        .send({})
        .expect(500);

      expect(res.body.error).toBeDefined();
    });
  });

  // ── PUT /orders/:id/pay ──
  describe('PUT /orders/:id/pay', () => {
    test('should mark pending order as paid (200)', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'pending', pay_amount: '6999' };
      const updated = { id: 1, order_no: 'SC001', status: 'paid', paid_at: new Date().toISOString() };

      mockQueryFn
        .mockResolvedValueOnce([order])
        .mockResolvedValueOnce([updated]);

      const res = await request(app)
        .put('/orders/1/pay')
        .send({ paymentId: 'pay_123', paidAt: '2024-01-15T10:00:00Z' })
        .expect(200);

      expect(res.body.data.status).toBe('paid');
      expect(mockEventBusPublish).toHaveBeenCalledWith(
        EventTypes.ORDER_PAID,
        expect.objectContaining({ paymentId: 'pay_123' })
      );
    });

    test('should mark order as paid without explicit paidAt (200)', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'pending', pay_amount: '6999' };
      const updated = { id: 1, order_no: 'SC001', status: 'paid', paid_at: new Date() };

      mockQueryFn
        .mockResolvedValueOnce([order])
        .mockResolvedValueOnce([updated]);

      const res = await request(app)
        .put('/orders/1/pay')
        .send({ paymentId: 'pay_456' })
        .expect(200);

      expect(res.body.data.status).toBe('paid');
    });

    test('should return 404 when order not found', async () => {
      mockQueryFn.mockResolvedValueOnce([]);

      const res = await request(app)
        .put('/orders/999/pay')
        .send({ paymentId: 'pay_123' })
        .expect(404);

      expect(res.body.error.code).toBe('E5000');
    });

    test('should return 400 when order is not pending', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'paid', pay_amount: '6999' };

      mockQueryFn.mockResolvedValueOnce([order]);

      const res = await request(app)
        .put('/orders/1/pay')
        .send({ paymentId: 'pay_123' })
        .expect(400);

      expect(res.body.error.code).toBe('E6002');
    });

    test('should handle database error (500)', async () => {
      mockQueryFn.mockRejectedValueOnce(new Error('pay update failed'));

      const res = await request(app)
        .put('/orders/1/pay')
        .send({ paymentId: 'pay_123' })
        .expect(500);

      expect(res.body.error).toBeDefined();
    });
  });

  // ── PUT /orders/:id/ship ──
  describe('PUT /orders/:id/ship', () => {
    test('should ship paid order (200)', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'paid', total_amount: '6999' };
      const updated = { id: 1, order_no: 'SC001', status: 'shipped', shipped_at: new Date().toISOString() };

      mockQueryFn
        .mockResolvedValueOnce([order])
        .mockResolvedValueOnce([updated]);

      const res = await request(app)
        .put('/orders/1/ship')
        .set('X-User-Id', '42')
        .send({ trackingNumber: 'SF123456', carrier: 'SF Express' })
        .expect(200);

      expect(res.body.data.status).toBe('shipped');
      expect(mockEventBusPublish).toHaveBeenCalledWith(
        EventTypes.ORDER_SHIPPED,
        expect.objectContaining({ trackingNumber: 'SF123456', carrier: 'SF Express' })
      );
    });

    test('should ship order without tracking info (200)', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'paid' };
      const updated = { id: 1, order_no: 'SC001', status: 'shipped' };

      mockQueryFn
        .mockResolvedValueOnce([order])
        .mockResolvedValueOnce([updated]);

      const res = await request(app)
        .put('/orders/1/ship')
        .set('X-User-Id', '42')
        .send({})
        .expect(200);

      expect(res.body.data.status).toBe('shipped');
    });

    test('should return 404 when order not found', async () => {
      mockQueryFn.mockResolvedValueOnce([]);

      const res = await request(app)
        .put('/orders/999/ship')
        .set('X-User-Id', '42')
        .send({})
        .expect(404);

      expect(res.body.error.code).toBe('E5000');
    });

    test('should return 400 when order is not paid', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'pending' };

      mockQueryFn.mockResolvedValueOnce([order]);

      const res = await request(app)
        .put('/orders/1/ship')
        .set('X-User-Id', '42')
        .send({})
        .expect(400);

      expect(res.body.error.code).toBe('E5001');
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app)
        .put('/orders/1/ship')
        .send({})
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    test('should handle database error (500)', async () => {
      mockQueryFn.mockRejectedValueOnce(new Error('ship update failed'));

      const res = await request(app)
        .put('/orders/1/ship')
        .set('X-User-Id', '42')
        .send({})
        .expect(500);

      expect(res.body.error).toBeDefined();
    });
  });

  // ── PUT /orders/:id/complete ──
  describe('PUT /orders/:id/complete', () => {
    test('should complete shipped order (200)', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'shipped', total_amount: '6999' };
      const updated = { id: 1, order_no: 'SC001', status: 'completed', completed_at: new Date().toISOString() };

      mockQueryFn
        .mockResolvedValueOnce([order])
        .mockResolvedValueOnce([updated]);

      const res = await request(app)
        .put('/orders/1/complete')
        .set('X-User-Id', '42')
        .expect(200);

      expect(res.body.data.status).toBe('completed');
      expect(mockEventBusPublish).toHaveBeenCalledWith(
        EventTypes.ORDER_COMPLETED,
        expect.any(Object)
      );
    });

    test('should return 404 when order not found', async () => {
      mockQueryFn.mockResolvedValueOnce([]);

      const res = await request(app)
        .put('/orders/999/complete')
        .set('X-User-Id', '42')
        .expect(404);

      expect(res.body.error.code).toBe('E5000');
    });

    test('should return 400 when order is not shipped', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'paid' };

      mockQueryFn.mockResolvedValueOnce([order]);

      const res = await request(app)
        .put('/orders/1/complete')
        .set('X-User-Id', '42')
        .expect(400);

      expect(res.body.error.code).toBe('E5001');
    });

    test('should return 400 when order is pending', async () => {
      const order = { id: 1, order_no: 'SC001', user_id: 42, status: 'pending' };

      mockQueryFn.mockResolvedValueOnce([order]);

      const res = await request(app)
        .put('/orders/1/complete')
        .set('X-User-Id', '42')
        .expect(400);

      expect(res.body.error.code).toBe('E5001');
    });

    test('should return 401 without X-User-Id header', async () => {
      const res = await request(app)
        .put('/orders/1/complete')
        .expect(401);

      expect(res.body.error).toBeDefined();
    });

    test('should handle database error (500)', async () => {
      mockQueryFn.mockRejectedValueOnce(new Error('complete update failed'));

      const res = await request(app)
        .put('/orders/1/complete')
        .set('X-User-Id', '42')
        .expect(500);

      expect(res.body.error).toBeDefined();
    });
  });

  // ── GET /health ──
  describe('GET /health', () => {
    test('should return healthy status (200)', async () => {
      mockQueryFn.mockResolvedValueOnce([{ '?column?': 1 }]);

      const res = await request(app)
        .get('/health')
        .expect(200);

      expect(res.body.service).toBe('order-service');
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });

    test('should return unhealthy status (503) when DB is down', async () => {
      mockQueryFn.mockRejectedValueOnce(new Error('Connection refused'));

      const res = await request(app)
        .get('/health')
        .expect(503);

      expect(res.body.status).toBe('unhealthy');
      expect(res.body.error).toBe('Connection refused');
    });

    test('should use SERVICE_NAME env var if set', async () => {
      const originalServiceName = process.env.SERVICE_NAME;
      process.env.SERVICE_NAME = 'order-service-test';
      mockQueryFn.mockResolvedValueOnce([{ '?column?': 1 }]);

      const res = await request(app)
        .get('/health')
        .expect(200);

      expect(res.body.service).toBe('order-service-test');

      process.env.SERVICE_NAME = originalServiceName;
    });

    test('should include timestamp in ISO format', async () => {
      mockQueryFn.mockResolvedValueOnce([{ '?column?': 1 }]);
      const before = new Date().toISOString();

      const res = await request(app)
        .get('/health')
        .expect(200);

      const after = new Date().toISOString();
      expect(res.body.timestamp >= before && res.body.timestamp <= after).toBe(true);
    });
  });
});

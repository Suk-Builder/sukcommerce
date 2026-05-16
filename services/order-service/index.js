require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { createLogger, requestIdMiddleware } = require('../../shared/lib/logger');
const { Errors, errorHandler } = require('../../shared/lib/errors');
const { EventBus, EventTypes } = require('../../shared/lib/events');
const { getPool, query, transaction } = require('../../shared/lib/db');
const { OrderSaga } = require('./sagas/order-saga');

const logger = createLogger('order-service');
const app = express();
const PORT = process.env.PORT || 3003;

app.use(cors());
app.use(express.json());
app.use(requestIdMiddleware);

const getUserId = (req) => {
  const uid = req.headers['x-user-id'];
  if (!uid) throw new Errors.UnauthorizedError('Missing X-User-Id header');
  return parseInt(uid, 10);
};

const generateOrderNo = () => {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `SC${ymd}${rand}`;
};

// ── Cart Routes ──

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

app.post('/cart', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { product_id, sku_id, quantity = 1 } = req.body;

    if (!product_id) throw new Errors.ValidationError('product_id is required');

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

    if (!result.length) throw new Errors.NotFoundError('Cart item not found');
    res.json({ data: result[0] });
  } catch (err) {
    next(err);
  }
});

app.delete('/cart/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    const result = await query(
      'DELETE FROM carts WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId]
    );

    if (!result.length) throw new Errors.NotFoundError('Cart item not found');
    res.json({ data: result[0] });
  } catch (err) {
    next(err);
  }
});

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

// ── Order Routes ──

app.post('/orders', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { address, remark } = req.body;

    if (!address) throw new Errors.ValidationError('address is required');

    // Get selected cart items
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
      throw new Errors.ValidationError('No items selected in cart');
    }

    // Calculate totals
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

    // Create order + items in transaction
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

    // Fetch created items
    const items = await query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [order.id]
    );

    // Publish event
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

    // Start Saga asynchronously
    const saga = new OrderSaga({ sagaId, order, items, userId });
    saga.execute().catch((err) => {
      logger.error('Saga execution error', { sagaId, error: err.message });
    });

    res.status(201).json({ order, items });
  } catch (err) {
    next(err);
  }
});

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

app.get('/orders/:id', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    const orderRes = await query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (!orderRes.length) throw new Errors.NotFoundError('Order not found');

    const items = await query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [id]
    );

    res.json({ order: orderRes[0], items });
  } catch (err) {
    next(err);
  }
});

app.put('/orders/:id/cancel', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;
    const { reason } = req.body;

    const orderRes = await query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (!orderRes.length) throw new Errors.NotFoundError('Order not found');

    const order = orderRes[0];
    if (!['pending', 'paid'].includes(order.status)) {
      throw new Errors.ValidationError(`Cannot cancel order in status: ${order.status}`);
    }

    const items = await query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [id]
    );

    await transaction(async (client) => {
      // Restore stock
      for (const item of items) {
        await client.query(
          'UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2',
          [item.quantity, item.product_id]
        );
      }

      // Update order status
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

app.put('/orders/:id/pay', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { paymentId, paidAt } = req.body;

    const orderRes = await query(
      'SELECT * FROM orders WHERE id = $1',
      [id]
    );
    if (!orderRes.length) throw new Errors.NotFoundError('Order not found');

    const order = orderRes[0];
    if (order.status !== 'pending') {
      throw new Errors.ValidationError(`Order status is ${order.status}, cannot mark as paid`);
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

app.put('/orders/:id/ship', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;
    const { trackingNumber, carrier } = req.body;

    const orderRes = await query(
      'SELECT * FROM orders WHERE id = $1',
      [id]
    );
    if (!orderRes.length) throw new Errors.NotFoundError('Order not found');

    const order = orderRes[0];
    if (order.status !== 'paid') {
      throw new Errors.ValidationError(`Order must be paid before shipping, current: ${order.status}`);
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

app.put('/orders/:id/complete', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    const orderRes = await query(
      'SELECT * FROM orders WHERE id = $1',
      [id]
    );
    if (!orderRes.length) throw new Errors.NotFoundError('Order not found');

    const order = orderRes[0];
    if (order.status !== 'shipped') {
      throw new Errors.ValidationError(`Order must be shipped before completing, current: ${order.status}`);
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

// ── Health ──

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

// ── Error Handler ──

app.use(errorHandler);

// ── Start ──

app.listen(PORT, () => {
  logger.info(`Order service running on port ${PORT}`);
});

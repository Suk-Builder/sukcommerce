/**
 * 订单服务 — 购物车/订单/Saga分布式事务
 * PostgreSQL + Redis(分布式锁) + RabbitMQ Saga协调
 */
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const axios = require('axios');

const { createLogger, requestIdMiddleware } = require('../../shared/lib/logger');
const { Errors, errorHandler } = require('../../shared/lib/errors');
const { EventBus, EventTypes } = require('../../shared/lib/events');
const { OrderSaga } = require('./sagas/order-saga');

const logger = createLogger();
const app = express();
app.use(express.json());
app.use(requestIdMiddleware);

const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, max: 20 });
const redis = new Redis(process.env.REDIS_URL);
const eventBus = new EventBus();
eventBus.connect();

// ─── DB ───
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS carts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      product_id BIGINT NOT NULL,
      sku_id BIGINT,
      quantity INT NOT NULL DEFAULT 1,
      selected BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, product_id, sku_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_no VARCHAR(32) UNIQUE NOT NULL,
      user_id BIGINT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','paid','shipped','completed','cancelled','refunding','refunded')),
      total_amount DECIMAL(12,2) NOT NULL,
      discount_amount DECIMAL(12,2) DEFAULT 0,
      pay_amount DECIMAL(12,2) NOT NULL,
      address JSONB NOT NULL,
      remark TEXT,
      paid_at TIMESTAMPTZ,
      shipped_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      saga_id VARCHAR(64),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT REFERENCES orders(id),
      product_id BIGINT NOT NULL,
      sku_id BIGINT,
      product_name VARCHAR(255) NOT NULL,
      sku_attrs JSONB,
      price DECIMAL(12,2) NOT NULL,
      quantity INT NOT NULL,
      subtotal DECIMAL(12,2) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_no ON orders(order_no);
  `);
}

// ─── 生成订单号 ───
function generateOrderNo() {
  const date = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const rand = Math.random().toString(36).slice(2,8).toUpperCase();
  return `SC${date}${rand}`;
}

// ─── 路由 ───

// 购物车
app.get('/cart', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'];
    const result = await pool.query(
      `SELECT c.*, p.name as product_name, p.images[1] as image, p.status as product_status
       FROM carts c JOIN products p ON c.product_id = p.id WHERE c.user_id = $1`,
      [userId]
    );
    res.json({ items: result.rows });
  } catch (err) { next(err); }
});

app.post('/cart', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'];
    const { product_id, sku_id, quantity = 1 } = req.body;
    await pool.query(
      `INSERT INTO carts (user_id, product_id, sku_id, quantity) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, product_id, sku_id) DO UPDATE SET quantity = carts.quantity + $4, updated_at = NOW()`,
      [userId, product_id, sku_id, quantity]
    );
    res.status(201).json({ message: '已加入购物车' });
  } catch (err) { next(err); }
});

// 创建订单 —— Saga 分布式事务入口
app.post('/orders', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'];
    const { address, remark, cart_item_ids } = req.body;

    // 1. 获取购物车商品
    const cartResult = await pool.query(
      'SELECT c.*, p.name, p.price, p.stock FROM carts c JOIN products p ON c.product_id = p.id WHERE c.user_id = $1 AND c.selected = TRUE',
      [userId]
    );
    const items = cartResult.rows;
    if (items.length === 0) throw Errors.CART_EMPTY();

    // 2. 计算金额
    const totalAmount = items.reduce((sum, i) => sum + (parseFloat(i.price) * i.quantity), 0);

    // 3. 创建订单（pending状态）
    const orderNo = generateOrderNo();
    const sagaId = `saga_${orderNo}`;
    const client = await pool.connect();

    let order;
    try {
      await client.query('BEGIN');

      const orderResult = await client.query(
        `INSERT INTO orders (order_no, user_id, status, total_amount, pay_amount, address, remark, saga_id)
         VALUES ($1,$2,'pending',$3,$4,$5,$6,$7) RETURNING *`,
        [orderNo, userId, totalAmount, totalAmount, JSON.stringify(address), remark, sagaId]
      );
      order = orderResult.rows[0];

      for (const item of items) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, sku_id, product_name, price, quantity, subtotal)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [order.id, item.product_id, item.sku_id, item.product_name, item.price, item.quantity, item.price * item.quantity]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // 4. 启动 Saga 分布式事务
    const saga = new OrderSaga({ sagaId, order, items, eventBus, pool });
    saga.execute().catch(err => logger.error(`Saga failed: ${sagaId}`, err));

    await eventBus.publish(EventTypes.ORDER_CREATED, { order_id: order.id, order_no, user_id: userId, amount: totalAmount });

    res.status(201).json({ order: { ...order, items } });
  } catch (err) { next(err); }
});

// 获取订单
app.get('/orders', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'];
    const { status, page = 1, limit = 10 } = req.query;
    let sql = 'SELECT * FROM orders WHERE user_id = $1';
    const params = [userId];
    if (status) { sql += ' AND status = $2'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, (page - 1) * limit);

    const result = await pool.query(sql, params);
    res.json({ orders: result.rows });
  } catch (err) { next(err); }
});

app.get('/orders/:id', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'];
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!orderResult.rows[0]) throw Errors.ORDER_NOT_FOUND();
    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);
    res.json({ order: { ...orderResult.rows[0], items: itemsResult.rows } });
  } catch (err) { next(err); }
});

// 取消订单
app.put('/orders/:id/cancel', async (req, res, next) => {
  try {
    const userId = req.headers['x-user-id'];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT status FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE', [req.params.id, userId]);
      if (!result.rows[0]) throw Errors.ORDER_NOT_FOUND();
      if (!['pending', 'paid'].includes(result.rows[0].status)) throw Errors.ORDER_CANNOT_CANCEL();

      await client.query("UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [req.params.id]);

      // 恢复库存
      const items = await client.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);
      for (const item of items.rows) {
        await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.quantity, item.product_id]);
      }

      await client.query('COMMIT');

      await eventBus.publish(EventTypes.ORDER_CANCELLED, { order_id: req.params.id });
      res.json({ message: '订单已取消' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

app.get('/health', (req, res) => res.json({ service: 'order-service', status: 'healthy' }));
app.use(errorHandler);

const PORT = process.env.PORT || 3003;
initDb().then(() => {
  app.listen(PORT, () => logger.info(`OrderService on ${PORT}`));
});

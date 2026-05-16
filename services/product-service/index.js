/**
 * 商品服务 — 商品/分类/库存/搜索
 * PostgreSQL + Elasticsearch + Redis 缓存
 */
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { Client } = require('@elastic/elasticsearch');
const Redis = require('ioredis');

const { createLogger, requestIdMiddleware } = require('../../shared/lib/logger');
const { Errors, errorHandler } = require('../../shared/lib/errors');
const { EventBus, EventTypes } = require('../../shared/lib/events');

const logger = createLogger();
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(requestIdMiddleware);

const pool = new Pool({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  max: 20
});

const es = new Client({ node: `http://${process.env.ES_HOST}` });
const redis = new Redis(process.env.REDIS_URL);
const eventBus = new EventBus();
eventBus.connect();

// ─── DB 初始化 ───
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      parent_id BIGINT REFERENCES categories(id),
      sort_order INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      seller_id BIGINT NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      category_id BIGINT REFERENCES categories(id),
      price DECIMAL(12,2) NOT NULL,
      original_price DECIMAL(12,2),
      stock INT NOT NULL DEFAULT 0,
      sold_count INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','inactive','deleted')),
      images TEXT[],
      attributes JSONB DEFAULT '{}',
      tags VARCHAR(50)[],
      rating DECIMAL(2,1) DEFAULT 5.0,
      review_count INT DEFAULT 0,
      weight_g INT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
    CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);

    CREATE TABLE IF NOT EXISTS skus (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT REFERENCES products(id) ON DELETE CASCADE,
      sku_code VARCHAR(100) UNIQUE NOT NULL,
      attributes JSONB NOT NULL,
      price DECIMAL(12,2) NOT NULL,
      stock INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS inventory_log (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT,
      sku_id BIGINT,
      change INT NOT NULL,
      reason VARCHAR(50),
      order_id BIGINT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  logger.info('ProductService DB initialized');
}

// ─── ES 初始化 ───
async function initES() {
  const exists = await es.indices.exists({ index: 'products' });
  if (!exists) {
    await es.indices.create({
      index: 'products',
      body: {
        mappings: {
          properties: {
            id: { type: 'long' },
            name: { type: 'text', analyzer: 'ik_max_word' },
            description: { type: 'text', analyzer: 'ik_max_word' },
            category_id: { type: 'long' },
            price: { type: 'scaled_float', scaling_factor: 100 },
            status: { type: 'keyword' },
            tags: { type: 'keyword' },
            rating: { type: 'float' },
            sold_count: { type: 'integer' },
            created_at: { type: 'date' },
            suggest: { type: 'completion' }
          }
        }
      }
    });
    logger.info('ES products index created');
  }
}

// ─── 路由 ───

// 商品列表（支持缓存）
app.get('/products', async (req, res, next) => {
  try {
    const { category, page = 1, limit = 20, sort = 'created_at', order = 'desc', min_price, max_price, q } = req.query;
    const cacheKey = `products:list:${category || 'all'}:${page}:${limit}:${sort}:${order}:${min_price || ''}:${max_price || ''}:${q || ''}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    let where = ["p.status = 'active'"];
    let params = [];
    let paramIdx = 1;

    if (category) { where.push(`p.category_id = $${paramIdx++}`); params.push(category); }
    if (min_price) { where.push(`p.price >= $${paramIdx++}`); params.push(min_price); }
    if (max_price) { where.push(`p.price <= $${paramIdx++}`); params.push(max_price); }
    if (q) { where.push(`(p.name ILIKE $${paramIdx} OR p.description ILIKE $${paramIdx})`); params.push(`%${q}%`); paramIdx++; }

    const offset = (page - 1) * limit;
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT p.*, c.name as category_name FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE ${where.join(' AND ')}
       ORDER BY p.${sort} ${order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      params
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM products p WHERE ${where.join(' AND ')}`,
      params.slice(0, -2)
    );

    const response = {
      products: result.rows,
      pagination: { page: parseInt(page), limit: parseInt(limit), total: parseInt(countResult.rows[0].count) }
    };

    await redis.setex(cacheKey, 60, JSON.stringify(response));
    res.json(response);
  } catch (err) { next(err); }
});

// 商品详情
app.get('/products/:id', async (req, res, next) => {
  try {
    const cacheKey = `product:${req.params.id}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const result = await pool.query(
      'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = $1',
      [req.params.id]
    );
    if (!result.rows[0]) throw Errors.PRODUCT_NOT_FOUND();

    // 获取 SKU
    const skus = await pool.query('SELECT * FROM skus WHERE product_id = $1 AND status = $2', [req.params.id, 'active']);
    const product = { ...result.rows[0], skus: skus.rows };

    await redis.setex(cacheKey, 300, JSON.stringify(product));
    res.json({ product });
  } catch (err) { next(err); }
});

// 创建商品（卖家/管理员）
app.post('/products', async (req, res, next) => {
  try {
    const sellerId = req.headers['x-user-id'];
    const role = req.headers['x-user-role'];
    if (!['seller', 'admin'].includes(role)) throw Errors.FORBIDDEN();

    const { name, description, category_id, price, original_price, stock, images, attributes, tags } = req.body;
    const result = await pool.query(
      `INSERT INTO products (seller_id, name, description, category_id, price, original_price, stock, images, attributes, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [sellerId, name, description, category_id, price, original_price, stock, images, JSON.stringify(attributes), tags]
    );
    const product = result.rows[0];

    // 索引到 ES
    await es.index({ index: 'products', id: product.id, body: {
      id: product.id, name: product.name, description: product.description,
      category_id: product.category_id, price: product.price,
      status: product.status, tags: product.tags,
      rating: product.rating, sold_count: product.sold_count,
      created_at: product.created_at
    }});

    await eventBus.publish(EventTypes.PRODUCT_CREATED, { product_id: product.id, seller_id: sellerId });
    await redis.del('products:list:*');

    res.status(201).json({ product });
  } catch (err) { next(err); }
});

// 库存扣减（内部接口，订单服务调用）
app.post('/products/:id/deduct-stock', async (req, res, next) => {
  try {
    const { quantity, sku_id, order_id } = req.body;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const lockResult = await client.query(
        'SELECT stock FROM products WHERE id = $1 FOR UPDATE',
        [req.params.id]
      );
      if (!lockResult.rows[0]) throw Errors.PRODUCT_NOT_FOUND();

      const currentStock = lockResult.rows[0].stock;
      if (currentStock < quantity) throw Errors.INVENTORY_SHORTAGE(req.params.id);

      await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [quantity, req.params.id]);
      await client.query(
        'INSERT INTO inventory_log (product_id, sku_id, change, reason, order_id) VALUES ($1,$2,$3,$4,$5)',
        [req.params.id, sku_id, -quantity, 'order_deduct', order_id]
      );

      await client.query('COMMIT');

      // 检查低库存告警
      if (currentStock - quantity < 10) {
        await eventBus.publish(EventTypes.PRODUCT_LOW_STOCK, { product_id: req.params.id, stock: currentStock - quantity });
      }

      res.json({ success: true, remaining_stock: currentStock - quantity });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// ES 搜索
app.get('/search', async (req, res, next) => {
  try {
    const { q, category, min_price, max_price, page = 1, limit = 20 } = req.query;
    const must = [];
    if (q) must.push({ multi_match: { query: q, fields: ['name^3', 'description', 'tags'] } });
    if (category) must.push({ term: { category_id: category } });
    if (min_price || max_price) {
      const range = {};
      if (min_price) range.gte = parseFloat(min_price);
      if (max_price) range.lte = parseFloat(max_price);
      must.push({ range: { price: range } });
    }
    must.push({ term: { status: 'active' } });

    const result = await es.search({
      index: 'products',
      body: {
        from: (page - 1) * limit,
        size: parseInt(limit),
        query: { bool: { must } },
        sort: [{ _score: 'desc' }, { sold_count: 'desc' }],
        highlight: { fields: { name: {}, description: {} } }
      }
    });

    res.json({
      total: result.hits.total.value,
      products: result.hits.hits.map(h => ({
        id: h._source.id,
        name: h.highlight?.name?.[0] || h._source.name,
        price: h._source.price,
        rating: h._source.rating,
        sold_count: h._source.sold_count
      }))
    });
  } catch (err) { next(err); }
});

// 分类树
app.get('/categories', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY sort_order, id');
    const buildTree = (parentId = null) =>
      result.rows.filter(c => c.parent_id == parentId).map(c => ({ ...c, children: buildTree(c.id) }));
    res.json({ categories: buildTree() });
  } catch (err) { next(err); }
});

app.get('/health', (req, res) => res.json({ service: 'product-service', status: 'healthy' }));
app.use(errorHandler);

const PORT = process.env.PORT || 3002;
Promise.all([initDb(), initES()]).then(() => {
  app.listen(PORT, () => logger.info(`ProductService on ${PORT}`));
});

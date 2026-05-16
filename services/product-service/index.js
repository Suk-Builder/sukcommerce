/**
 * product-service — 商品服务
 * 商品管理 / SKU / 分类 / 库存 / Elasticsearch搜索
 */
require('dotenv').config();
const express = require('express');
const { Client } = require('@elastic/elasticsearch');
const Redis = require('ioredis');

const { createLogger, requestIdMiddleware } = require('../../shared/lib/logger');
const { Errors, errorHandler } = require('../../shared/lib/errors');
const { EventBus, EventTypes } = require('../../shared/lib/events');
const { query, transaction } = require('../../shared/lib/db');

const logger = createLogger();
const app = express();
app.use(express.json());
app.use(requestIdMiddleware);

// ============ 初始化外部连接 ============
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const esClient = new Client({ node: process.env.ES_HOST || 'http://localhost:9200' });
const eventBus = new EventBus();

redis.on('error', (err) => logger.error('Redis error:', err.message));
eventBus.connect().catch(() => {});

// ============ 认证中间件 ============
function requireRole(...roles) {
  return (req, res, next) => {
    const userId = req.headers['x-user-id'];
    const userRole = req.headers['x-user-role'];
    if (!userId) return next(Errors.UNAUTHORIZED());
    if (!roles.includes(userRole)) return next(Errors.FORBIDDEN());
    req.userId = parseInt(userId);
    req.userRole = userRole;
    next();
  };
}

// ============ 缓存工具 ============
async function cacheGet(key) {
  const val = await redis.get(key);
  return val ? JSON.parse(val) : null;
}
async function cacheSet(key, data, ttlSeconds) {
  await redis.setex(key, ttlSeconds, JSON.stringify(data));
}
async function cacheDelPattern(pattern) {
  const keys = await redis.keys(pattern);
  if (keys.length) await redis.del(...keys);
}

// ============ 清空列表缓存 ============
async function invalidateListCache() {
  await cacheDelPattern('products:list:*');
}

// ============ ES 索引操作 ============
async function indexProduct(product) {
  await esClient.index({
    index: 'products',
    id: String(product.id),
    document: {
      id: product.id,
      name: product.name,
      description: product.description || '',
      category_id: product.category_id,
      price: product.price,
      status: product.status,
      tags: product.tags || [],
      rating: product.rating,
      sold_count: product.sold_count,
      created_at: product.created_at,
      suggest: product.name
    }
  });
}

async function removeProductFromES(productId) {
  await esClient.delete({ index: 'products', id: String(productId) }).catch(() => {});
}

// ============ 初始化 Elasticsearch 索引 ============
async function initES() {
  const exists = await esClient.indices.exists({ index: 'products' });
  if (!exists) {
    await esClient.indices.create({
      index: 'products',
      body: {
        settings: {
          analysis: {
            analyzer: {
              ik_max_word: { type: 'custom', tokenizer: 'ik_max_word' }
            }
          }
        },
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
    logger.info('Elasticsearch index "products" created');
  }
}

// ============ 辅助函数 ============
function buildWhere(conditions, params) {
  const clauses = [];
  conditions.forEach(({ clause, param }) => {
    if (param !== undefined && param !== null && param !== '') {
      clauses.push(clause);
      params.push(param);
    }
  });
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

// ============ GET /products — 商品列表 ============
app.get('/products', async (req, res, next) => {
  try {
    const {
      category, page = '1', limit = '20',
      sort = 'created_at', order = 'desc',
      min_price, max_price, q
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const cacheKey = `products:list:${category || ''}:${pageNum}:${limitNum}:${sort}:${order}:${min_price || ''}:${max_price || ''}:${q || ''}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const allowedSort = ['created_at', 'price', 'sold_count', 'rating'];
    const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
    const sortOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const params = [];
    const whereConditions = [];

    whereConditions.push({ clause: 'p.status = $1', param: 'active' });
    params.push('active');

    if (category) {
      whereConditions.push({ clause: `p.category_id = $${params.length + 1}`, param: parseInt(category) });
    }
    if (min_price) {
      whereConditions.push({ clause: `p.price >= $${params.length + 1}`, param: parseFloat(min_price) });
    }
    if (max_price) {
      whereConditions.push({ clause: `p.price <= $${params.length + 1}`, param: parseFloat(max_price) });
    }
    if (q) {
      whereConditions.push({ clause: `(p.name ILIKE $${params.length + 1} OR p.description ILIKE $${params.length + 1} OR p.tags @> ARRAY[$${params.length + 2}]::VARCHAR[])`, param: `%${q}%` });
      params.push(`%${q}%`, q);
    }

    const where = buildWhere(whereConditions, params);

    const countResult = await query(`SELECT COUNT(*)::int AS total FROM products p WHERE 1=1 ${where}`, [...params]);
    const total = countResult.rows[0].total;

    const dataResult = await query(
      `SELECT p.id, p.seller_id, p.name, p.description, p.category_id, c.name AS category_name,
              p.price, p.original_price, p.stock, p.sold_count, p.status, p.images, p.attributes,
              p.tags, p.rating, p.review_count, p.weight_g, p.created_at, p.updated_at
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE 1=1 ${where}
       ORDER BY p.${sortCol} ${sortOrder}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limitNum, offset]
    );

    const result = {
      data: dataResult.rows,
      meta: { total, page: pageNum, limit: limitNum, total_pages: Math.ceil(total / limitNum) }
    };

    await cacheSet(cacheKey, result, 60);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ============ GET /products/:id — 商品详情（含SKU列表） ============
app.get('/products/:id', async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);
    const cacheKey = `product:${productId}`;

    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const productRes = await query(
      `SELECT p.id, p.seller_id, p.name, p.description, p.category_id, c.name AS category_name,
              p.price, p.original_price, p.stock, p.sold_count, p.status, p.images, p.attributes,
              p.tags, p.rating, p.review_count, p.weight_g, p.created_at, p.updated_at
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = $1 AND p.status != 'deleted'`,
      [productId]
    );

    if (!productRes.rows.length) return next(Errors.PRODUCT_NOT_FOUND());

    const skusRes = await query(
      `SELECT id, sku_code, attributes, price, stock, status FROM skus WHERE product_id = $1 AND status = 'active'`,
      [productId]
    );

    const result = { ...productRes.rows[0], skus: skusRes.rows };
    await cacheSet(cacheKey, result, 300);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ============ POST /products — 创建商品 ============
app.post('/products', requireRole('seller', 'admin'), async (req, res, next) => {
  try {
    const { name, description, category_id, price, original_price, stock, images, attributes, tags } = req.body;
    if (!name || price === undefined) return next(Errors.MISSING_FIELD('name, price'));

    const result = await transaction(async (client) => {
      const r = await client.query(
        `INSERT INTO products (seller_id, name, description, category_id, price, original_price, stock, images, attributes, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [req.userId, name, description || '', category_id || null, price, original_price || null, stock || 0, images || '{}', JSON.stringify(attributes || {}), tags || []]
      );
      return r.rows[0];
    });

    await indexProduct(result);
    await eventBus.publish(EventTypes.PRODUCT_CREATED, {
      product_id: result.id,
      seller_id: result.seller_id,
      name: result.name,
      price: result.price,
      request_id: req.request_id
    });
    await invalidateListCache();

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ============ PUT /products/:id — 更新商品 ============
app.put('/products/:id', requireRole('seller', 'admin'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);
    const { name, description, category_id, price, original_price, stock, images, attributes, tags, status } = req.body;

    const check = await query(`SELECT seller_id FROM products WHERE id = $1 AND status != 'deleted'`, [productId]);
    if (!check.rows.length) return next(Errors.PRODUCT_NOT_FOUND());
    if (req.userRole !== 'admin' && check.rows[0].seller_id !== req.userId) return next(Errors.FORBIDDEN());

    const fields = [];
    const values = [];
    let idx = 1;

    const addField = (col, val) => { if (val !== undefined) { fields.push(`${col} = $${idx++}`); values.push(val); } };

    addField('name', name);
    addField('description', description);
    addField('category_id', category_id);
    addField('price', price);
    addField('original_price', original_price);
    addField('stock', stock);
    addField('images', images);
    addField('attributes', attributes ? JSON.stringify(attributes) : undefined);
    addField('tags', tags);
    addField('status', status);
    fields.push(`updated_at = NOW()`);

    values.push(productId);
    const result = await query(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    const updated = result.rows[0];
    await indexProduct(updated);
    await eventBus.publish(EventTypes.PRODUCT_UPDATED, {
      product_id: updated.id,
      name: updated.name,
      price: updated.price,
      request_id: req.request_id
    });
    await cacheDelPattern(`product:${productId}`);
    await invalidateListCache();

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ============ DELETE /products/:id — 软删除 ============
app.delete('/products/:id', requireRole('seller', 'admin'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);

    const check = await query(`SELECT seller_id FROM products WHERE id = $1 AND status != 'deleted'`, [productId]);
    if (!check.rows.length) return next(Errors.PRODUCT_NOT_FOUND());
    if (req.userRole !== 'admin' && check.rows[0].seller_id !== req.userId) return next(Errors.FORBIDDEN());

    await query(`UPDATE products SET status = 'deleted', updated_at = NOW() WHERE id = $1`, [productId]);
    await removeProductFromES(productId);
    await cacheDelPattern(`product:${productId}`);
    await invalidateListCache();

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ============ POST /products/:id/skus — 添加SKU ============
app.post('/products/:id/skus', requireRole('seller', 'admin'), async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);
    const { sku_code, attributes, price, stock } = req.body;
    if (!sku_code || !price) return next(Errors.MISSING_FIELD('sku_code, price'));

    const check = await query(`SELECT 1 FROM products WHERE id = $1 AND status = 'active'`, [productId]);
    if (!check.rows.length) return next(Errors.PRODUCT_NOT_FOUND());

    const result = await query(
      `INSERT INTO skus (product_id, sku_code, attributes, price, stock)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [productId, sku_code, JSON.stringify(attributes || {}), price, stock || 0]
    );

    await cacheDelPattern(`product:${productId}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ============ PUT /skus/:id — 更新SKU ============
app.put('/skus/:id', requireRole('seller', 'admin'), async (req, res, next) => {
  try {
    const skuId = parseInt(req.params.id);
    const { sku_code, attributes, price, stock, status } = req.body;

    const skuCheck = await query(`SELECT product_id FROM skus WHERE id = $1`, [skuId]);
    if (!skuCheck.rows.length) return next(Errors.PRODUCT_NOT_FOUND());
    const productId = skuCheck.rows[0].product_id;

    const fields = [];
    const values = [];
    let idx = 1;

    if (sku_code !== undefined) { fields.push(`sku_code = $${idx++}`); values.push(sku_code); }
    if (attributes !== undefined) { fields.push(`attributes = $${idx++}`); values.push(JSON.stringify(attributes)); }
    if (price !== undefined) { fields.push(`price = $${idx++}`); values.push(price); }
    if (stock !== undefined) { fields.push(`stock = $${idx++}`); values.push(stock); }
    if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }

    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(skuId);

    const result = await query(`UPDATE skus SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, values);
    await cacheDelPattern(`product:${productId}`);

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ============ POST /products/:id/deduct-stock — 库存扣减 ============
app.post('/products/:id/deduct-stock', async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);
    const { quantity, sku_id, order_id } = req.body;
    if (!quantity || quantity < 1) return next(Errors.VALIDATION_ERROR({ quantity: 'must be positive' }));

    const result = await transaction(async (client) => {
      // 锁定SKU行
      const skuRes = await client.query(
        `SELECT * FROM skus WHERE id = $1 AND product_id = $2 AND status = 'active' FOR UPDATE`,
        [sku_id, productId]
      );
      if (!skuRes.rows.length) throw Errors.PRODUCT_NOT_FOUND();
      const sku = skuRes.rows[0];

      if (sku.stock < quantity) throw Errors.PRODUCT_OUT_OF_STOCK();

      const newStock = sku.stock - quantity;
      await client.query(`UPDATE skus SET stock = $1 WHERE id = $2`, [newStock, sku_id]);

      // 更新商品总库存
      await client.query(
        `UPDATE products SET stock = (SELECT COALESCE(SUM(stock), 0) FROM skus WHERE product_id = $1 AND status = 'active'),
         sold_count = sold_count + $2, updated_at = NOW() WHERE id = $1`,
        [productId, quantity]
      );

      // 写入库存日志
      await client.query(
        `INSERT INTO inventory_log (product_id, sku_id, change, reason, order_id) VALUES ($1, $2, $3, $4, $5)`,
        [productId, sku_id, -quantity, 'order_deduct', order_id || null]
      );

      return { sku_id, old_stock: sku.stock, new_stock: newStock, price: sku.price };
    });

    // 检查低库存
    if (result.new_stock < 10) {
      await eventBus.publish(EventTypes.PRODUCT_LOW_STOCK, {
        product_id: productId,
        sku_id: sku_id,
        stock: result.new_stock,
        request_id: req.request_id
      });
    }

    await cacheDelPattern(`product:${productId}`);
    await invalidateListCache();

    res.json({ success: true, deducted: quantity, ...result });
  } catch (err) {
    next(err);
  }
});

// ============ POST /products/:id/restore-stock — 库存恢复（Saga补偿） ============
app.post('/products/:id/restore-stock', async (req, res, next) => {
  try {
    const productId = parseInt(req.params.id);
    const { quantity, sku_id, order_id } = req.body;
    if (!quantity || quantity < 1) return next(Errors.VALIDATION_ERROR({ quantity: 'must be positive' }));

    await transaction(async (client) => {
      await client.query(`UPDATE skus SET stock = stock + $1 WHERE id = $2 AND product_id = $3`, [quantity, sku_id, productId]);

      await client.query(
        `UPDATE products SET stock = (SELECT COALESCE(SUM(stock), 0) FROM skus WHERE product_id = $1 AND status = 'active'),
         sold_count = GREATEST(0, sold_count - $2), updated_at = NOW() WHERE id = $1`,
        [productId, quantity]
      );

      await client.query(
        `INSERT INTO inventory_log (product_id, sku_id, change, reason, order_id) VALUES ($1, $2, $3, $4, $5)`,
        [productId, sku_id, quantity, 'order_restore', order_id || null]
      );
    });

    await cacheDelPattern(`product:${productId}`);
    await invalidateListCache();

    res.json({ success: true, restored: quantity });
  } catch (err) {
    next(err);
  }
});

// ============ GET /search — Elasticsearch搜索 ============
app.get('/search', async (req, res, next) => {
  try {
    const { q, category, min_price, max_price, page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const from = (pageNum - 1) * limitNum;

    const must = [];
    const filter = [{ term: { status: 'active' } }];

    if (q) {
      must.push({
        multi_match: {
          query: q,
          fields: ['name^3', 'description', 'tags'],
          type: 'best_fields'
        }
      });
    } else {
      must.push({ match_all: {} });
    }

    if (category) filter.push({ term: { category_id: parseInt(category) } });
    if (min_price !== undefined) filter.push({ range: { price: { gte: parseFloat(min_price) } } });
    if (max_price !== undefined) filter.push({ range: { price: { lte: parseFloat(max_price) } } });

    const esRes = await esClient.search({
      index: 'products',
      from,
      size: limitNum,
      query: { bool: { must, filter } },
      highlight: {
        fields: {
          name: { pre_tags: ['<mark>'], post_tags: ['</mark>'] },
          description: { pre_tags: ['<mark>'], post_tags: ['</mark>'] }
        }
      },
      sort: q ? [{ _score: 'desc' }] : [{ created_at: 'desc' }]
    });

    const hits = esRes.hits.hits.map(h => ({
      ...h._source,
      highlight: h.highlight
    }));

    res.json({
      data: hits,
      meta: {
        total: esRes.hits.total.value,
        page: pageNum,
        limit: limitNum,
        total_pages: Math.ceil(esRes.hits.total.value / limitNum)
      }
    });
  } catch (err) {
    next(err);
  }
});

// ============ GET /categories — 分类树 ============
app.get('/categories', async (req, res, next) => {
  try {
    const result = await query(`SELECT id, name, parent_id, sort_order, created_at FROM categories ORDER BY sort_order, id`);
    const rows = result.rows;

    const map = {};
    const tree = [];
    rows.forEach(c => {
      map[c.id] = { ...c, children: [] };
    });
    rows.forEach(c => {
      if (c.parent_id && map[c.parent_id]) {
        map[c.parent_id].children.push(map[c.id]);
      } else {
        tree.push(map[c.id]);
      }
    });

    res.json(tree);
  } catch (err) {
    next(err);
  }
});

// ============ POST /categories — 创建分类 ============
app.post('/categories', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, parent_id, sort_order } = req.body;
    if (!name) return next(Errors.MISSING_FIELD('name'));

    const result = await query(
      `INSERT INTO categories (name, parent_id, sort_order) VALUES ($1, $2, $3) RETURNING *`,
      [name, parent_id || null, sort_order || 0]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ============ GET /health — 健康检查 ============
app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    await redis.ping();
    res.json({
      status: 'ok',
      service: process.env.SERVICE_NAME || 'product-service',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// ============ 全局错误处理 ============
app.use(errorHandler);

// ============ 启动服务 ============
const PORT = process.env.PORT || 3002;
initES().then(() => {
  app.listen(PORT, () => {
    logger.info(`Product Service running on port ${PORT}`);
  });
}).catch(err => {
  logger.error('Failed to initialize:', err);
  process.exit(1);
});

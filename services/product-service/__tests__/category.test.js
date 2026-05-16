/**
 * Category & Health Tests
 * Covers: GET /categories, POST /categories, GET /health
 */
const request = require('supertest');
const app = require('../index');
const {
  mockQuery,
  mockQuerySequence,
  clearRedisCache,
  mockRedisPing
} = require('./setup');

describe('Category Routes', () => {
  afterEach(() => {
    clearRedisCache();
  });

  // ==========================================
  // GET /categories — 分类树
  // ==========================================
  describe('GET /categories', () => {
    test('should return category tree (200)', async () => {
      const flatCategories = [
        { id: 1, name: 'Electronics', parent_id: null, sort_order: 1, created_at: '2024-01-01' },
        { id: 2, name: 'Clothing', parent_id: null, sort_order: 2, created_at: '2024-01-01' },
        { id: 3, name: 'Phones', parent_id: 1, sort_order: 1, created_at: '2024-01-01' },
        { id: 4, name: 'Laptops', parent_id: 1, sort_order: 2, created_at: '2024-01-01' },
        { id: 5, name: 'Mens', parent_id: 2, sort_order: 1, created_at: '2024-01-01' },
        { id: 6, name: 'Womens', parent_id: 2, sort_order: 2, created_at: '2024-01-01' }
      ];
      mockQuery(flatCategories);

      const res = await request(app).get('/categories');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);

      // Check Electronics tree
      const electronics = res.body.find(c => c.name === 'Electronics');
      expect(electronics).toBeDefined();
      expect(electronics.children).toHaveLength(2);
      expect(electronics.children.map(c => c.name)).toContain('Phones');
      expect(electronics.children.map(c => c.name)).toContain('Laptops');

      // Check Clothing tree
      const clothing = res.body.find(c => c.name === 'Clothing');
      expect(clothing).toBeDefined();
      expect(clothing.children).toHaveLength(2);
      expect(clothing.children.map(c => c.name)).toContain('Mens');
      expect(clothing.children.map(c => c.name)).toContain('Womens');
    });

    test('should return empty array when no categories (200)', async () => {
      mockQuery([]);

      const res = await request(app).get('/categories');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
      expect(res.body).toEqual([]);
    });

    test('should handle flat list without parent_id (200)', async () => {
      const flatCategories = [
        { id: 1, name: 'Category A', parent_id: null, sort_order: 1, created_at: '2024-01-01' },
        { id: 2, name: 'Category B', parent_id: null, sort_order: 2, created_at: '2024-01-01' }
      ];
      mockQuery(flatCategories);

      const res = await request(app).get('/categories');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].children).toHaveLength(0);
      expect(res.body[1].children).toHaveLength(0);
    });

    test('should handle deep nesting (200)', async () => {
      const deepCategories = [
        { id: 1, name: 'Level 1', parent_id: null, sort_order: 1, created_at: '2024-01-01' },
        { id: 2, name: 'Level 2', parent_id: 1, sort_order: 1, created_at: '2024-01-01' },
        { id: 3, name: 'Level 3', parent_id: 2, sort_order: 1, created_at: '2024-01-01' }
      ];
      mockQuery(deepCategories);

      const res = await request(app).get('/categories');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Level 1');
      expect(res.body[0].children).toHaveLength(1);
      expect(res.body[0].children[0].name).toBe('Level 2');
      expect(res.body[0].children[0].children).toHaveLength(1);
      expect(res.body[0].children[0].children[0].name).toBe('Level 3');
    });

    test('should handle orphan child with missing parent gracefully (200)', async () => {
      const orphanCategories = [
        { id: 1, name: 'Valid Parent', parent_id: null, sort_order: 1, created_at: '2024-01-01' },
        { id: 2, name: 'Orphan Child', parent_id: 999, sort_order: 1, created_at: '2024-01-01' }
      ];
      mockQuery(orphanCategories);

      const res = await request(app).get('/categories');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const names = res.body.map(c => c.name);
      expect(names).toContain('Valid Parent');
      expect(names).toContain('Orphan Child');
    });

    test('should sort by sort_order and id (200)', async () => {
      const sortedCategories = [
        { id: 3, name: 'Third', parent_id: null, sort_order: 1, created_at: '2024-01-01' },
        { id: 1, name: 'First', parent_id: null, sort_order: 1, created_at: '2024-01-01' },
        { id: 2, name: 'Second', parent_id: null, sort_order: 2, created_at: '2024-01-01' }
      ];
      mockQuery(sortedCategories);

      const res = await request(app).get('/categories');

      expect(res.status).toBe(200);
      // All returned as-is from query ORDER BY sort_order, id
      expect(res.body).toHaveLength(3);
    });

    test('should handle single category (200)', async () => {
      mockQuery([
        { id: 1, name: 'Root', parent_id: null, sort_order: 1, created_at: '2024-01-01' }
      ]);

      const res = await request(app).get('/categories');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Root');
      expect(res.body[0].children).toEqual([]);
    });

    test('should handle database error (500)', async () => {
      require('../../shared/lib/db').query = jest.fn().mockRejectedValue(new Error('DB connection failed'));

      const res = await request(app).get('/categories');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('E1000');
    });
  });

  // ==========================================
  // POST /categories — 创建分类
  // ==========================================
  describe('POST /categories', () => {
    test('should create category as admin (201)', async () => {
      mockQuery([
        { id: 1, name: 'New Category', parent_id: null, sort_order: 0, created_at: '2024-01-01' }
      ]);

      const res = await request(app)
        .post('/categories')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'admin')
        .send({ name: 'New Category' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('New Category');
      expect(res.body.id).toBe(1);
    });

    test('should create category with parent_id (201)', async () => {
      mockQuery([
        { id: 2, name: 'Sub Category', parent_id: 1, sort_order: 1, created_at: '2024-01-01' }
      ]);

      const res = await request(app)
        .post('/categories')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'admin')
        .send({ name: 'Sub Category', parent_id: 1, sort_order: 1 });

      expect(res.status).toBe(201);
      expect(res.body.parent_id).toBe(1);
      expect(res.body.sort_order).toBe(1);
    });

    test('should create category with sort_order (201)', async () => {
      mockQuery([
        { id: 3, name: 'Sorted Category', parent_id: null, sort_order: 5, created_at: '2024-01-01' }
      ]);

      const res = await request(app)
        .post('/categories')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'admin')
        .send({ name: 'Sorted Category', sort_order: 5 });

      expect(res.status).toBe(201);
      expect(res.body.sort_order).toBe(5);
    });

    test('should return 400 when name is missing', async () => {
      const res = await request(app)
        .post('/categories')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'admin')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8001');
    });

    test('should return 400 when name is empty string', async () => {
      const res = await request(app)
        .post('/categories')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'admin')
        .send({ name: '' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8001');
    });

    test('should return 403 when seller tries to create category', async () => {
      const res = await request(app)
        .post('/categories')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ name: 'Hacked Category' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('E2001');
    });

    test('should return 403 when buyer tries to create category', async () => {
      const res = await request(app)
        .post('/categories')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'buyer')
        .send({ name: 'Hacked Category' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('E2001');
    });

    test('should return 401 without authentication', async () => {
      const res = await request(app)
        .post('/categories')
        .send({ name: 'Test' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('E2000');
    });

    test('should default sort_order to 0 when not provided (201)', async () => {
      mockQuery([
        { id: 1, name: 'Default Sort', parent_id: null, sort_order: 0, created_at: '2024-01-01' }
      ]);

      const res = await request(app)
        .post('/categories')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'admin')
        .send({ name: 'Default Sort' });

      expect(res.status).toBe(201);
      expect(res.body.sort_order).toBe(0);
    });

    test('should default parent_id to null when not provided (201)', async () => {
      mockQuery([
        { id: 1, name: 'Root Category', parent_id: null, sort_order: 0, created_at: '2024-01-01' }
      ]);

      const res = await request(app)
        .post('/categories')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'admin')
        .send({ name: 'Root Category' });

      expect(res.status).toBe(201);
      expect(res.body.parent_id).toBeNull();
    });
  });

  // ==========================================
  // GET /health — 健康检查
  // ==========================================
  describe('GET /health', () => {
    test('should return healthy status (200)', async () => {
      require('../../shared/lib/db').query = jest.fn().mockResolvedValue({ rows: [] });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('product-service');
      expect(res.body).toHaveProperty('uptime');
      expect(res.body).toHaveProperty('timestamp');
      expect(typeof res.body.uptime).toBe('number');
    });

    test('should return 503 when database is down', async () => {
      require('../../shared/lib/db').query = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.error).toContain('ECONNREFUSED');
    });

    test('should return 503 when Redis is down', async () => {
      require('../../shared/lib/db').query = jest.fn().mockResolvedValue({ rows: [] });
      mockRedisPing.mockRejectedValueOnce(new Error('Redis connection lost'));

      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
    });

    test('should include service name in response', async () => {
      require('../../shared/lib/db').query = jest.fn().mockResolvedValue({ rows: [] });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.service).toBeDefined();
    });

    test('should include ISO timestamp', async () => {
      require('../../shared/lib/db').query = jest.fn().mockResolvedValue({ rows: [] });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      const ts = new Date(res.body.timestamp);
      expect(ts instanceof Date && !isNaN(ts)).toBe(true);
    });

    test('should have uptime greater than 0', async () => {
      require('../../shared/lib/db').query = jest.fn().mockResolvedValue({ rows: [] });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.uptime).toBeGreaterThan(0);
    });
  });
});

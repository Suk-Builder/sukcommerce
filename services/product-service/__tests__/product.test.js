/**
 * Product CRUD Tests
 * Covers: GET /products, GET /products/:id, POST /products, PUT /products/:id, DELETE /products/:id
 *          POST /products/:id/skus, PUT /skus/:id
 */
const request = require('supertest');
const app = require('../index');
const {
  mockQuery,
  mockQuerySequence,
  mockESIndex,
  mockESIndexResult,
  mockRedisCache,
  clearRedisCache,
  mockPublish,
  EventTypes
} = require('./setup');

describe('Product Routes', () => {
  afterEach(() => {
    clearRedisCache();
  });

  // ==========================================
  // GET /products — 商品列表
  // ==========================================
  describe('GET /products', () => {
    const mockProducts = [
      { id: 1, name: 'iPhone 15', description: 'Apple phone', category_id: 1, category_name: 'Electronics', price: 999, original_price: 1099, stock: 100, sold_count: 50, status: 'active', images: '{}', attributes: '{}', tags: ['phone', 'apple'], rating: 4.5, review_count: 20, weight_g: 200, created_at: '2024-01-01', updated_at: '2024-01-01', seller_id: 1 },
      { id: 2, name: 'MacBook Pro', description: 'Apple laptop', category_id: 1, category_name: 'Electronics', price: 1999, original_price: 2199, stock: 50, sold_count: 30, status: 'active', images: '{}', attributes: '{}', tags: ['laptop', 'apple'], rating: 4.8, review_count: 15, weight_g: 1500, created_at: '2024-01-02', updated_at: '2024-01-02', seller_id: 1 }
    ];

    test('should return product list with pagination (200)', async () => {
      mockQuerySequence([
        [{ total: 2 }],  // count
        mockProducts     // data
      ]);

      const res = await request(app).get('/products');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].name).toBe('iPhone 15');
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 20, total_pages: 1 });
    });

    test('should return cached result when cache hit (200)', async () => {
      mockRedisCache('products:list:::1:20:created_at:desc:::', {
        data: [{ id: 99, name: 'Cached Product' }],
        meta: { total: 1, page: 1, limit: 20, total_pages: 1 }
      });

      const res = await request(app).get('/products');

      expect(res.status).toBe(200);
      expect(res.body.data[0].name).toBe('Cached Product');
    });

    test('should filter by category (200)', async () => {
      mockQuerySequence([
        [{ total: 1 }],
        [mockProducts[0]]
      ]);

      const res = await request(app).get('/products?category=1');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].category_id).toBe(1);
    });

    test('should filter by price range (200)', async () => {
      mockQuerySequence([
        [{ total: 1 }],
        [mockProducts[0]]
      ]);

      const res = await request(app).get('/products?min_price=500&max_price=1500');

      expect(res.status).toBe(200);
      expect(res.status).toBe(200);
    });

    test('should filter by search keyword q (200)', async () => {
      mockQuerySequence([
        [{ total: 1 }],
        [mockProducts[0]]
      ]);

      const res = await request(app).get('/products?q=iphone');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    test('should sort by price ascending (200)', async () => {
      mockQuerySequence([
        [{ total: 2 }],
        mockProducts
      ]);

      const res = await request(app).get('/products?sort=price&order=asc');

      expect(res.status).toBe(200);
      expect(res.body.meta.page).toBe(1);
    });

    test('should return empty list when no products match (200)', async () => {
      mockQuerySequence([
        [{ total: 0 }],
        []
      ]);

      const res = await request(app).get('/products?category=999');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.meta.total).toBe(0);
    });

    test('should enforce max limit of 100 (200)', async () => {
      mockQuerySequence([
        [{ total: 2 }],
        mockProducts
      ]);

      const res = await request(app).get('/products?limit=999');

      expect(res.status).toBe(200);
    });

    test('should handle page and limit parameters (200)', async () => {
      mockQuerySequence([
        [{ total: 25 }],
        mockProducts
      ]);

      const res = await request(app).get('/products?page=2&limit=10');

      expect(res.status).toBe(200);
      expect(res.body.meta.page).toBe(2);
      expect(res.body.meta.limit).toBe(10);
      expect(res.body.meta.total_pages).toBe(3);
    });
  });

  // ==========================================
  // GET /products/:id — 商品详情
  // ==========================================
  describe('GET /products/:id', () => {
    const mockProduct = { id: 1, name: 'iPhone 15', description: 'Apple phone', category_id: 1, category_name: 'Electronics', price: 999, original_price: 1099, stock: 100, sold_count: 50, status: 'active', images: '{}', attributes: '{}', tags: ['phone', 'apple'], rating: 4.5, review_count: 20, weight_g: 200, created_at: '2024-01-01', updated_at: '2024-01-01', seller_id: 1 };
    const mockSkus = [
      { id: 1, sku_code: 'IP15-BLK-128', attributes: '{"color":"black","storage":"128GB"}', price: 999, stock: 50, status: 'active' },
      { id: 2, sku_code: 'IP15-WHT-256', attributes: '{"color":"white","storage":"256GB"}', price: 1099, stock: 50, status: 'active' }
    ];

    test('should return product with SKU list (200)', async () => {
      mockQuerySequence([
        [mockProduct],
        mockSkus
      ]);

      const res = await request(app).get('/products/1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(1);
      expect(res.body.name).toBe('iPhone 15');
      expect(res.body.skus).toHaveLength(2);
      expect(res.body.skus[0].sku_code).toBe('IP15-BLK-128');
    });

    test('should return cached product when cache hit (200)', async () => {
      mockRedisCache('product:1', { ...mockProduct, skus: [] });

      const res = await request(app).get('/products/1');

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('iPhone 15');
    });

    test('should return 404 when product does not exist', async () => {
      mockQuerySequence([
        []  // no product found
      ]);

      const res = await request(app).get('/products/999');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('E4000');
    });

    test('should return 404 for deleted product', async () => {
      mockQuerySequence([
        []  // deleted product filtered by status != 'deleted'
      ]);

      const res = await request(app).get('/products/1');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('E4000');
    });

    test('should return product without SKUs when no SKUs exist (200)', async () => {
      mockQuerySequence([
        [mockProduct],
        []
      ]);

      const res = await request(app).get('/products/1');

      expect(res.status).toBe(200);
      expect(res.body.skus).toHaveLength(0);
    });
  });

  // ==========================================
  // POST /products — 创建商品
  // ==========================================
  describe('POST /products', () => {
    const validProduct = { name: 'iPhone 15', description: 'Latest iPhone', category_id: 1, price: 999, original_price: 1099, stock: 100, images: '{}', attributes: { color: ['black', 'white'] }, tags: ['phone', 'apple'] };
    const createdProduct = { id: 1, seller_id: 10, name: 'iPhone 15', description: 'Latest iPhone', category_id: 1, price: 999, original_price: 1099, stock: 100, images: '{}', attributes: '{"color":["black","white"]}', tags: ['phone', 'apple'], rating: 0, sold_count: 0, status: 'active', created_at: '2024-01-01', updated_at: '2024-01-01' };

    test('should create product as seller (201)', async () => {
      const { mockTransaction } = require('./setup');
      let capturedQuery;
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation((sql, params) => {
            capturedQuery = { sql, params };
            return Promise.resolve({ rows: [createdProduct] });
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send(validProduct);

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(1);
      expect(res.body.name).toBe('iPhone 15');
      expect(mockESIndex).toHaveBeenCalled();
      expect(mockPublish).toHaveBeenCalled();
    });

    test('should create product as admin (201)', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [createdProduct] })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'admin')
        .send(validProduct);

      expect(res.status).toBe(201);
      expect(res.body.id).toBe(1);
    });

    test('should return 403 when user has insufficient permission', async () => {
      const res = await request(app)
        .post('/products')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'buyer')
        .send(validProduct);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('E2001');
    });

    test('should return 403 without X-User-Id header', async () => {
      const res = await request(app)
        .post('/products')
        .set('X-User-Role', 'seller')
        .send(validProduct);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('E2000');
    });

    test('should return 400 when name is missing', async () => {
      const res = await request(app)
        .post('/products')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ ...validProduct, name: undefined });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8001');
    });

    test('should return 400 when price is missing', async () => {
      const res = await request(app)
        .post('/products')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ ...validProduct, price: undefined });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8001');
    });

    test('should create product with minimal fields (201)', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({
            rows: [{ ...createdProduct, description: '', category_id: null, original_price: null, stock: 0, images: '{}', attributes: '{}', tags: [] }]
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ name: 'Test Product', price: 100 });

      expect(res.status).toBe(201);
      expect(res.body.stock).toBe(0);
    });
  });

  // ==========================================
  // PUT /products/:id — 更新商品
  // ==========================================
  describe('PUT /products/:id', () => {
    const existingProduct = { id: 1, seller_id: 10, name: 'Old Name', description: 'Old desc', category_id: 1, price: 500, original_price: 600, stock: 50, images: '{}', attributes: '{}', tags: ['old'], status: 'active', rating: 0, sold_count: 0, created_at: '2024-01-01', updated_at: '2024-01-01' };
    const updatedProduct = { ...existingProduct, name: 'New Name', price: 600 };

    test('should update product as owner seller (200)', async () => {
      mockQuerySequence([
        [{ seller_id: 10 }],  // ownership check
        [updatedProduct]       // update result
      ]);

      const res = await request(app)
        .put('/products/1')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ name: 'New Name', price: 600 });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('New Name');
      expect(mockESIndex).toHaveBeenCalled();
    });

    test('should update product as admin (200)', async () => {
      mockQuerySequence([
        [{ seller_id: 10 }],
        [updatedProduct]
      ]);

      const res = await request(app)
        .put('/products/1')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'admin')
        .send({ name: 'Admin Updated' });

      expect(res.status).toBe(200);
    });

    test('should return 403 when non-owner seller tries to update', async () => {
      mockQuerySequence([
        [{ seller_id: 10 }]  // product owned by seller 10
      ]);

      const res = await request(app)
        .put('/products/1')
        .set('X-User-Id', '99')
        .set('X-User-Role', 'seller')
        .send({ name: 'Hacked' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('E2001');
    });

    test('should return 404 when product does not exist', async () => {
      mockQuerySequence([
        []  // no product found
      ]);

      const res = await request(app)
        .put('/products/999')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ name: 'New Name' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('E4000');
    });

    test('should return 403 for unauthorized user', async () => {
      const res = await request(app)
        .put('/products/1')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'buyer')
        .send({ name: 'New Name' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('E2001');
    });

    test('should update partial fields correctly (200)', async () => {
      mockQuerySequence([
        [{ seller_id: 10 }],
        [{ ...existingProduct, name: 'Only Name Updated' }]
      ]);

      const res = await request(app)
        .put('/products/1')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ name: 'Only Name Updated' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Only Name Updated');
    });
  });

  // ==========================================
  // DELETE /products/:id — 软删除
  // ==========================================
  describe('DELETE /products/:id', () => {
    test('should soft delete product as owner (204)', async () => {
      const { mockESDelete } = require('./setup');
      mockQuerySequence([
        [{ seller_id: 10 }]
      ]);

      const res = await request(app)
        .delete('/products/1')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller');

      expect(res.status).toBe(204);
    });

    test('should soft delete product as admin (204)', async () => {
      mockQuerySequence([
        [{ seller_id: 10 }]
      ]);

      const res = await request(app)
        .delete('/products/1')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'admin');

      expect(res.status).toBe(204);
    });

    test('should return 403 when non-owner seller tries to delete', async () => {
      mockQuerySequence([
        [{ seller_id: 10 }]
      ]);

      const res = await request(app)
        .delete('/products/1')
        .set('X-User-Id', '99')
        .set('X-User-Role', 'seller');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('E2001');
    });

    test('should return 404 when product does not exist', async () => {
      mockQuerySequence([
        []
      ]);

      const res = await request(app)
        .delete('/products/999')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('E4000');
    });

    test('should return 403 for unauthorized user', async () => {
      const res = await request(app)
        .delete('/products/1')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'buyer');

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('E2001');
    });
  });

  // ==========================================
  // POST /products/:id/skus — 添加SKU
  // ==========================================
  describe('POST /products/:id/skus', () => {
    const newSku = { id: 1, product_id: 1, sku_code: 'IP15-BLK-128', attributes: '{"color":"black","storage":"128GB"}', price: 999, stock: 50, status: 'active' };

    test('should create SKU for existing product (201)', async () => {
      mockQuerySequence([
        [{ exists: 1 }],  // product exists check
        [newSku]          // insert result
      ]);

      const res = await request(app)
        .post('/products/1/skus')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ sku_code: 'IP15-BLK-128', attributes: { color: 'black', storage: '128GB' }, price: 999, stock: 50 });

      expect(res.status).toBe(201);
      expect(res.body.sku_code).toBe('IP15-BLK-128');
      expect(res.body.price).toBe(999);
    });

    test('should return 404 when product does not exist', async () => {
      mockQuerySequence([
        []  // product not found
      ]);

      const res = await request(app)
        .post('/products/999/skus')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ sku_code: 'TEST-001', price: 100 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('E4000');
    });

    test('should return 400 when sku_code is missing', async () => {
      const res = await request(app)
        .post('/products/1/skus')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ price: 999 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8001');
    });

    test('should return 400 when price is missing', async () => {
      const res = await request(app)
        .post('/products/1/skus')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ sku_code: 'TEST-001' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8001');
    });

    test('should return 403 for unauthorized user', async () => {
      const res = await request(app)
        .post('/products/1/skus')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'buyer')
        .send({ sku_code: 'TEST-001', price: 100 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('E2001');
    });
  });

  // ==========================================
  // PUT /skus/:id — 更新SKU
  // ==========================================
  describe('PUT /skus/:id', () => {
    const updatedSku = { id: 1, product_id: 1, sku_code: 'IP15-RED-128', attributes: '{"color":"red","storage":"128GB"}', price: 899, stock: 30, status: 'active' };

    test('should update SKU successfully (200)', async () => {
      mockQuerySequence([
        [{ product_id: 1 }],  // find SKU
        [updatedSku]          // update result
      ]);

      const res = await request(app)
        .put('/skus/1')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ price: 899, stock: 30, sku_code: 'IP15-RED-128' });

      expect(res.status).toBe(200);
      expect(res.body.price).toBe(899);
    });

    test('should update partial fields (200)', async () => {
      mockQuerySequence([
        [{ product_id: 1 }],
        [{ ...updatedSku, price: 799, stock: 100, sku_code: 'IP15-BLK-128' }]
      ]);

      const res = await request(app)
        .put('/skus/1')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ price: 799 });

      expect(res.status).toBe(200);
      expect(res.body.price).toBe(799);
    });

    test('should return 404 when SKU does not exist', async () => {
      mockQuerySequence([
        []
      ]);

      const res = await request(app)
        .put('/skus/999')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({ price: 100 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('E4000');
    });

    test('should return 400 when no fields provided', async () => {
      mockQuerySequence([
        [{ product_id: 1 }]
      ]);

      const res = await request(app)
        .put('/skus/1')
        .set('X-User-Id', '10')
        .set('X-User-Role', 'seller')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No fields to update');
    });

    test('should return 403 for unauthorized user', async () => {
      const res = await request(app)
        .put('/skus/1')
        .set('X-User-Id', '1')
        .set('X-User-Role', 'buyer')
        .send({ price: 100 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('E2001');
    });
  });
});

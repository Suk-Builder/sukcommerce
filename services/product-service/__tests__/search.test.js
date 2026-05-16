/**
 * Elasticsearch Search Tests
 * Covers: GET /search
 * Focus: multi_match query, highlight results, category/price filters
 */
const request = require('supertest');
const app = require('../index');
const {
  mockESSearch,
  mockESSearchResult,
  clearRedisCache
} = require('./setup');

describe('Search Routes', () => {
  afterEach(() => {
    clearRedisCache();
    mockESSearch.mockClear();
  });

  const mockESHits = [
    {
      id: 1,
      name: 'iPhone 15 Pro',
      description: 'The latest iPhone with amazing features',
      category_id: 1,
      price: 999.00,
      status: 'active',
      tags: ['phone', 'apple', 'iphone'],
      rating: 4.5,
      sold_count: 1000,
      created_at: '2024-01-01',
      suggest: 'iPhone 15 Pro',
      _highlight: {
        name: ['<mark>iPhone</mark> 15 Pro'],
        description: ['The latest <mark>iPhone</mark> with amazing features']
      }
    },
    {
      id: 2,
      name: 'iPhone 14',
      description: 'Previous generation iPhone',
      category_id: 1,
      price: 799.00,
      status: 'active',
      tags: ['phone', 'apple'],
      rating: 4.3,
      sold_count: 5000,
      created_at: '2023-09-01',
      suggest: 'iPhone 14'
    }
  ];

  // ==========================================
  // GET /search — Elasticsearch搜索
  // ==========================================
  describe('GET /search', () => {
    test('should search with query string q (200)', async () => {
      mockESSearchResult(mockESHits, 2);

      const res = await request(app).get('/search?q=iphone');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].name).toBe('iPhone 15 Pro');
      expect(res.body.meta.total).toBe(2);
    });

    test('should use multi_match with name^3, description, tags boost', async () => {
      mockESSearchResult(mockESHits, 2);

      await request(app).get('/search?q=iphone');

      const esCall = mockESSearch.mock.calls[0][0];
      expect(esCall.query.bool.must[0]).toMatchObject({
        multi_match: {
          query: 'iphone',
          fields: ['name^3', 'description', 'tags'],
          type: 'best_fields'
        }
      });
    });

    test('should return highlighted results (200)', async () => {
      mockESSearchResult(mockESHits, 2);

      const res = await request(app).get('/search?q=iphone');

      expect(res.status).toBe(200);
      expect(res.body.data[0].highlight).toBeDefined();
      expect(res.body.data[0].highlight.name[0]).toContain('<mark>');
      expect(res.body.data[0].highlight.name[0]).toContain('</mark>');
    });

    test('should filter by category (200)', async () => {
      mockESSearchResult([mockESHits[0]], 1);

      const res = await request(app).get('/search?q=iphone&category=1');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);

      const esCall = mockESSearch.mock.calls[0][0];
      const categoryFilter = esCall.query.bool.filter.find(f => f.term && f.term.category_id);
      expect(categoryFilter).toEqual({ term: { category_id: 1 } });
    });

    test('should filter by min_price (200)', async () => {
      mockESSearchResult(mockESHits, 2);

      const res = await request(app).get('/search?q=iphone&min_price=500');

      expect(res.status).toBe(200);

      const esCall = mockESSearch.mock.calls[0][0];
      const priceFilter = esCall.query.bool.filter.find(f => f.range && f.range.price && f.range.price.gte !== undefined);
      expect(priceFilter).toEqual({ range: { price: { gte: 500 } } });
    });

    test('should filter by max_price (200)', async () => {
      mockESSearchResult(mockESHits, 2);

      const res = await request(app).get('/search?q=iphone&max_price=1000');

      expect(res.status).toBe(200);

      const esCall = mockESSearch.mock.calls[0][0];
      const priceFilter = esCall.query.bool.filter.find(f => f.range && f.range.price && f.range.price.lte !== undefined);
      expect(priceFilter).toEqual({ range: { price: { lte: 1000 } } });
    });

    test('should filter by price range (200)', async () => {
      mockESSearchResult([mockESHits[0]], 1);

      const res = await request(app).get('/search?q=iphone&min_price=500&max_price=900');

      expect(res.status).toBe(200);

      const esCall = mockESSearch.mock.calls[0][0];
      const filters = esCall.query.bool.filter;
      expect(filters).toContainEqual({ range: { price: { gte: 500 } } });
      expect(filters).toContainEqual({ range: { price: { lte: 900 } } });
    });

    test('should sort by _score when q is provided', async () => {
      mockESSearchResult(mockESHits, 2);

      await request(app).get('/search?q=iphone');

      const esCall = mockESSearch.mock.calls[0][0];
      expect(esCall.sort).toEqual([{ _score: 'desc' }]);
    });

    test('should sort by created_at when no q provided', async () => {
      mockESSearchResult(mockESHits, 2);

      await request(app).get('/search');

      const esCall = mockESSearch.mock.calls[0][0];
      expect(esCall.sort).toEqual([{ created_at: 'desc' }]);
    });

    test('should use match_all when no q provided (200)', async () => {
      mockESSearchResult(mockESHits, 2);

      const res = await request(app).get('/search');

      expect(res.status).toBe(200);

      const esCall = mockESSearch.mock.calls[0][0];
      const mustClause = esCall.query.bool.must[0];
      expect(mustClause).toEqual({ match_all: {} });
    });

    test('should always include active status filter', async () => {
      mockESSearchResult(mockESHits, 2);

      await request(app).get('/search?q=iphone');

      const esCall = mockESSearch.mock.calls[0][0];
      const statusFilter = esCall.query.bool.filter.find(f => f.term && f.term.status === 'active');
      expect(statusFilter).toEqual({ term: { status: 'active' } });
    });

    test('should handle pagination with page and limit (200)', async () => {
      mockESSearchResult(mockESHits, 10);

      const res = await request(app).get('/search?q=iphone&page=2&limit=5');

      expect(res.status).toBe(200);
      expect(res.body.meta.page).toBe(2);
      expect(res.body.meta.limit).toBe(5);
      expect(res.body.meta.total_pages).toBe(2);

      const esCall = mockESSearch.mock.calls[0][0];
      expect(esCall.from).toBe(5);
      expect(esCall.size).toBe(5);
    });

    test('should enforce max limit of 50 (200)', async () => {
      mockESSearchResult(mockESHits, 2);

      const res = await request(app).get('/search?q=iphone&limit=999');

      expect(res.status).toBe(200);

      const esCall = mockESSearch.mock.calls[0][0];
      expect(esCall.size).toBe(50);
    });

    test('should enforce minimum limit of 1 (200)', async () => {
      mockESSearchResult(mockESHits, 2);

      const res = await request(app).get('/search?q=iphone&limit=0');

      expect(res.status).toBe(200);

      const esCall = mockESSearch.mock.calls[0][0];
      expect(esCall.size).toBe(1);
    });

    test('should return empty results when no matches (200)', async () => {
      mockESSearchResult([], 0);

      const res = await request(app).get('/search?q=nonexistentproduct');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
      expect(res.body.meta.total).toBe(0);
      expect(res.body.meta.total_pages).toBe(0);
    });

    test('should include highlight configuration in query', async () => {
      mockESSearchResult(mockESHits, 2);

      await request(app).get('/search?q=iphone');

      const esCall = mockESSearch.mock.calls[0][0];
      expect(esCall.highlight).toBeDefined();
      expect(esCall.highlight.fields).toHaveProperty('name');
      expect(esCall.highlight.fields).toHaveProperty('description');
      expect(esCall.highlight.fields.name).toEqual({ pre_tags: ['<mark>'], post_tags: ['</mark>'] });
    });

    test('should parse category as integer', async () => {
      mockESSearchResult(mockESHits, 2);

      await request(app).get('/search?q=iphone&category=5');

      const esCall = mockESSearch.mock.calls[0][0];
      const categoryFilter = esCall.query.bool.filter.find(f => f.term && f.term.category_id);
      expect(categoryFilter.term.category_id).toBe(5);
      expect(typeof categoryFilter.term.category_id).toBe('number');
    });

    test('should parse min_price and max_price as float', async () => {
      mockESSearchResult(mockESHits, 2);

      await request(app).get('/search?q=iphone&min_price=99.99&max_price=999.99');

      const esCall = mockESSearch.mock.calls[0][0];
      const filters = esCall.query.bool.filter;
      const minFilter = filters.find(f => f.range && f.range.price && f.range.price.gte !== undefined);
      const maxFilter = filters.find(f => f.range && f.range.price && f.range.price.lte !== undefined);
      expect(minFilter.range.price.gte).toBe(99.99);
      expect(maxFilter.range.price.lte).toBe(999.99);
    });

    test('should return results without highlight when no match for highlight', async () => {
      mockESSearchResult([
        { ...mockESHits[1], _highlight: null }
      ], 1);

      const res = await request(app).get('/search?q=iphone');

      expect(res.status).toBe(200);
      expect(res.body.data[0].highlight).toBeNull();
    });

    test('should handle search results with total as object (200)', async () => {
      mockESSearch.mockResolvedValueOnce({
        hits: {
          total: { value: 100, relation: 'eq' },
          hits: mockESHits.map(h => ({
            _id: String(h.id),
            _source: { ...h, _highlight: undefined },
            highlight: h._highlight
          }))
        }
      });

      const res = await request(app).get('/search?q=iphone');

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(100);
    });

    test('should combine all filters correctly (200)', async () => {
      mockESSearchResult([mockESHits[0]], 1);

      const res = await request(app).get('/search?q=iphone&category=1&min_price=500&max_price=1500&page=1&limit=10');

      expect(res.status).toBe(200);

      const esCall = mockESSearch.mock.calls[0][0];
      expect(esCall.index).toBe('products');
      expect(esCall.from).toBe(0);
      expect(esCall.size).toBe(10);

      // Check status filter exists
      const statusFilter = esCall.query.bool.filter.find(f => f.term && f.term.status === 'active');
      expect(statusFilter).toBeDefined();

      // Check category filter exists
      const catFilter = esCall.query.bool.filter.find(f => f.term && f.term.category_id === 1);
      expect(catFilter).toBeDefined();

      // Check price filters exist
      const minFilter = esCall.query.bool.filter.find(f => f.range && f.range.price && f.range.price.gte === 500);
      expect(minFilter).toBeDefined();
      const maxFilter = esCall.query.bool.filter.find(f => f.range && f.range.price && f.range.price.lte === 1500);
      expect(maxFilter).toBeDefined();

      // Check multi_match exists
      expect(esCall.query.bool.must[0].multi_match).toBeDefined();
      expect(esCall.query.bool.must[0].multi_match.query).toBe('iphone');
    });

    test('should handle ES error gracefully (500)', async () => {
      mockESSearch.mockRejectedValueOnce(new Error('ES cluster unavailable'));

      const res = await request(app).get('/search?q=iphone');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('E1000');
    });
  });
});

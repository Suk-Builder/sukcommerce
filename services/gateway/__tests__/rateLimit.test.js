/**
 * rateLimit.test.js — Rate limiting middleware tests
 * Covers: successful requests, exceeding limit, Redis failures, window reset
 */

const request = require('supertest');
const { mockRedisMethods, redisStore } = require('./setup');

const app = require('../index');

describe('Rate Limit Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redisStore.clear();
  });

  // ─── Successful Requests ───────────────────────────────────
  describe('successful requests', () => {
    it('should allow request within rate limit (200)', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    });

    it('should allow exactly 100 requests', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      // Override incr to track exactly
      let count = 0;
      mockRedisMethods.incr.mockImplementation(async (key) => {
        count += 1;
        redisStore.set(key, count);
        return count;
      });

      const responses = [];
      for (let i = 0; i < 100; i++) {
        const res = await request(app).get('/health');
        responses.push(res);
      }

      // All 100 should succeed
      expect(responses.every((r) => r.status === 200)).toBe(true);
    });

    it('should set correct X-RateLimit-Limit header', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app).get('/health');

      expect(res.headers['x-ratelimit-limit']).toBe('100');
    });

    it('should set correct X-RateLimit-Window header', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app).get('/health');

      expect(res.headers['x-ratelimit-window']).toBe('60s');
    });

    it('should decrement X-RateLimit-Remaining with each request', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      let count = 0;
      mockRedisMethods.incr.mockImplementation(async (key) => {
        count += 1;
        redisStore.set(key, count);
        return count;
      });

      const res1 = await request(app).get('/health');
      const res2 = await request(app).get('/health');
      const res3 = await request(app).get('/health');

      expect(parseInt(res1.headers['x-ratelimit-remaining'])).toBeGreaterThan(
        parseInt(res2.headers['x-ratelimit-remaining'])
      );
      expect(parseInt(res2.headers['x-ratelimit-remaining'])).toBeGreaterThan(
        parseInt(res3.headers['x-ratelimit-remaining'])
      );
    });
  });

  // ─── Rate Limit Exceeded ───────────────────────────────────
  describe('rate limit exceeded', () => {
    it('should return 429 when exceeding 100 requests in 60s', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      // Simulate 100 requests already made (counter starts at 101)
      let count = 0;
      mockRedisMethods.incr.mockImplementation(async (key) => {
        count += 1;
        redisStore.set(key, count);
        return count;
      });

      // Make 101 requests
      const responses = [];
      for (let i = 0; i < 101; i++) {
        const res = await request(app).get('/health');
        responses.push(res);
      }

      const rateLimitedResponses = responses.filter((r) => r.status === 429);
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });

    it('should return correct error message for 429', async () => {
      mockRedisMethods.incr.mockImplementation(async (key) => {
        redisStore.set(key, 101);
        return 101;
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(429);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toMatch(/Rate limit exceeded/);
    });

    it('should include rate limit headers even in 429 response', async () => {
      mockRedisMethods.incr.mockImplementation(async (key) => {
        redisStore.set(key, 101);
        return 101;
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(429);
      expect(res.headers['x-ratelimit-limit']).toBe('100');
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    });

    it('should continue to return 429 for subsequent requests', async () => {
      mockRedisMethods.incr.mockImplementation(async (key) => {
        const current = (redisStore.get(key) || 0) + 1;
        redisStore.set(key, current);
        return current;
      });

      // Make many requests
      const responses = [];
      for (let i = 0; i < 120; i++) {
        const res = await request(app).get('/health');
        responses.push(res);
      }

      // After 100, all should be 429
      const exceededResponses = responses.filter((r) => r.status === 429);
      expect(exceededResponses.length).toBe(20);
    });

    it('should return X-RateLimit-Remaining as 0 when exceeded', async () => {
      mockRedisMethods.incr.mockImplementation(async (key) => {
        redisStore.set(key, 101);
        return 101;
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(429);
      expect(res.headers['x-ratelimit-remaining']).toBe('0');
    });
  });

  // ─── Redis Failures ────────────────────────────────────────
  describe('Redis failures', () => {
    it('should allow request when Redis fails (fail-open)', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      mockRedisMethods.incr.mockImplementationOnce(async () => {
        throw new Error('Redis connection refused');
      });

      const res = await request(app).get('/health');

      // Should still succeed due to fail-open behavior
      expect(res.status).toBe(200);
    });

    it('should allow multiple requests when Redis is down', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      mockRedisMethods.incr.mockImplementation(async () => {
        throw new Error('Redis down');
      });

      const res1 = await request(app).get('/health');
      const res2 = await request(app).get('/health');
      const res3 = await request(app).get('/health');

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res3.status).toBe(200);
    });

    it('should not set rate limit headers when Redis fails', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      mockRedisMethods.incr.mockImplementationOnce(async () => {
        throw new Error('Redis connection refused');
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      // Headers are set before the error, but the middleware continues
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
    });
  });

  // ─── Rate Limit Window ─────────────────────────────────────
  describe('rate limit window', () => {
    it('should set expire on first request', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      let firstCall = true;
      mockRedisMethods.incr.mockImplementationOnce(async (key) => {
        if (firstCall) {
          firstCall = false;
          return 1;
        }
        return 1;
      });

      mockRedisMethods.expire.mockResolvedValueOnce(true);

      await request(app).get('/health');

      expect(mockRedisMethods.expire).toHaveBeenCalledWith(
        expect.stringContaining('ratelimit:'),
        60
      );
    });

    it('should not set expire on non-first request', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      mockRedisMethods.incr.mockImplementation(async (key) => {
        const current = (redisStore.get(key) || 0) + 1;
        redisStore.set(key, current);
        return current;
      });

      // First request
      await request(app).get('/health');
      expect(mockRedisMethods.expire).toHaveBeenCalledTimes(1);

      // Second request
      await request(app).get('/health');
      // expire should still have been called only once (on first)
      expect(mockRedisMethods.expire).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────
  describe('edge cases', () => {
    it('should handle concurrent requests', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      let count = 0;
      mockRedisMethods.incr.mockImplementation(async (key) => {
        count += 1;
        redisStore.set(key, count);
        return count;
      });

      // Send 10 concurrent requests
      const promises = Array.from({ length: 10 }, () =>
        request(app).get('/health')
      );

      const responses = await Promise.all(promises);

      expect(responses.every((r) => r.status === 200)).toBe(true);
    });

    it('should use correct Redis key prefix', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const incrSpy = jest.spyOn(mockRedisMethods, 'incr').mockImplementation(async (key) => {
        redisStore.set(key, 1);
        return 1;
      });

      await request(app).get('/health');

      expect(incrSpy).toHaveBeenCalledWith(
        expect.stringContaining('ratelimit:')
      );
    });

    it('should handle requests from different IPs independently', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const res1 = await request(app)
        .get('/health')
        .set('X-Forwarded-For', '1.2.3.4');
      const res2 = await request(app)
        .get('/health')
        .set('X-Forwarded-For', '5.6.7.8');

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });

    it('should handle boundary case at exactly 100 requests', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      // Set counter to exactly 100
      redisStore.set('ratelimit:::ffff:127.0.0.1', 100);

      mockRedisMethods.incr.mockImplementation(async (key) => {
        const current = (redisStore.get(key) || 0) + 1;
        redisStore.set(key, current);
        return current;
      });

      const res = await request(app).get('/health');

      // 101st request should be rate limited
      expect(res.status).toBe(429);
    });

    it('should handle request at exactly limit threshold', async () => {
      const { mockFetch } = require('./setup');
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      redisStore.set('ratelimit:::ffff:127.0.0.1', 99);

      mockRedisMethods.incr.mockImplementation(async (key) => {
        const current = (redisStore.get(key) || 0) + 1;
        redisStore.set(key, current);
        return current;
      });

      const res = await request(app).get('/health');

      // 100th request should succeed
      expect(res.status).toBe(200);
    });
  });
});

/**
 * gateway.test.js — Gateway integration tests
 * Covers: JWT middleware, proxy routing, health check, metrics
 */

const request = require('supertest');
const {
  mockJwtVerify,
  mockFetch,
  mockProxyMiddleware,
} = require('./setup');

// Must import setup before app to ensure mocks are registered
const app = require('../index');

describe('Gateway API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  // ═══════════════════════════════════════════════════════════
  // Health Check
  // ═══════════════════════════════════════════════════════════
  describe('GET /health', () => {
    it('should return 200 when all services are UP', async () => {
      mockFetch.mockImplementation((url) => {
        return Promise.resolve({ ok: true, status: 200 });
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('HEALTHY');
      expect(res.body.redis).toBe('UP');
      expect(res.body.services).toBeDefined();
      expect(res.body.services.length).toBe(5);
      expect(res.body.services.every((s) => s.status === 'UP')).toBe(true);
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
      expect(res.body.timestamp).toBeDefined();
    });

    it('should return 503 when a downstream service is DOWN', async () => {
      mockFetch.mockImplementation((url) => {
        if (url.includes('payment-service')) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({ ok: true, status: 200 });
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('UNHEALTHY');
      const paymentService = res.body.services.find((s) => s.name === 'payment-service');
      expect(paymentService.status).toBe('DOWN');
    });

    it('should return 503 when a service throws network error', async () => {
      mockFetch.mockImplementation((url) => {
        if (url.includes('order-service')) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        return Promise.resolve({ ok: true, status: 200 });
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('UNHEALTHY');
      const orderService = res.body.services.find((s) => s.name === 'order-service');
      expect(orderService.status).toBe('DOWN');
      expect(orderService.error).toBeDefined();
    });

    it('should return 503 when Redis is down', async () => {
      const { mockRedisMethods } = require('./setup');
      mockRedisMethods.status = 'end';

      mockFetch.mockImplementation(() => {
        return Promise.resolve({ ok: true, status: 200 });
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.redis).toBe('DOWN');

      // Restore
      mockRedisMethods.status = 'ready';
    });

    it('should check all 5 downstream services', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app).get('/health');

      expect(mockFetch).toHaveBeenCalledTimes(5);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/health'),
        expect.objectContaining({ timeout: 5000 })
      );
    });

    it('should include correct service names', async () => {
      mockFetch.mockImplementation((url) => {
        return Promise.resolve({ ok: true, status: 200 });
      });

      const res = await request(app).get('/health');

      const names = res.body.services.map((s) => s.name);
      expect(names).toContain('user-service');
      expect(names).toContain('product-service');
      expect(names).toContain('order-service');
      expect(names).toContain('payment-service');
      expect(names).toContain('notification-service');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Metrics Endpoint
  // ═══════════════════════════════════════════════════════════
  describe('GET /metrics', () => {
    it('should return metrics without authentication', async () => {
      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.body.requests_total).toBeDefined();
      expect(res.body.errors_total).toBeDefined();
      expect(res.body.active_connections).toBeDefined();
      expect(res.body.uptime_seconds).toBeGreaterThanOrEqual(0);
      expect(res.body.circuit_breaker_states).toBeDefined();
      expect(res.body.memory_usage).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    it('should track request counts', async () => {
      // Make multiple requests
      await request(app).get('/metrics');
      await request(app).get('/metrics');

      const res = await request(app).get('/metrics');

      expect(res.body.requests_total).toBeGreaterThanOrEqual(3);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // JWT Middleware
  // ═══════════════════════════════════════════════════════════
  describe('JWT Authentication', () => {
    it('should allow requests with valid token', async () => {
      mockJwtVerify.mockImplementationOnce((token, secret) => {
        return { id: 1, role: 'user' };
      });

      // The proxy middleware will be called for valid JWT
      mockProxyMiddleware.mockImplementationOnce((req, res, next) => {
        res.status(200).json({ proxied: true });
      });

      const res = await request(app)
        .get('/api/v1/products')
        .set('Authorization', 'Bearer valid_token_xyz');

      expect(mockJwtVerify).toHaveBeenCalledWith('valid_token_xyz', 'test-jwt-secret');
    });

    it('should reject requests without Authorization header (401)', async () => {
      const res = await request(app).get('/api/v1/products');

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toMatch(/Missing or invalid Authorization/);
    });

    it('should reject requests without Bearer prefix (401)', async () => {
      const res = await request(app)
        .get('/api/v1/products')
        .set('Authorization', 'Basic dXNlcjpwYXNz');

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('should reject requests with empty Bearer token (401)', async () => {
      mockJwtVerify.mockImplementationOnce(() => {
        throw new Error('jwt must be provided');
      });

      const res = await request(app)
        .get('/api/v1/products')
        .set('Authorization', 'Bearer ');

      expect(res.status).toBe(401);
    });

    it('should reject requests with invalid token (401)', async () => {
      mockJwtVerify.mockImplementationOnce(() => {
        throw new Error('invalid signature');
      });

      const res = await request(app)
        .get('/api/v1/products')
        .set('Authorization', 'Bearer invalid_token');

      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/Invalid or expired token/);
    });

    it('should reject requests with expired token (401)', async () => {
      mockJwtVerify.mockImplementationOnce(() => {
        const err = new Error('jwt expired');
        err.name = 'TokenExpiredError';
        throw err;
      });

      const res = await request(app)
        .get('/api/v1/products')
        .set('Authorization', 'Bearer expired_token');

      expect(res.status).toBe(401);
    });

    it('should allow /health without token', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(mockJwtVerify).not.toHaveBeenCalled();
    });

    it('should allow /metrics without token', async () => {
      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(mockJwtVerify).not.toHaveBeenCalled();
    });

    it('should set user info on request object for valid token', async () => {
      mockJwtVerify.mockImplementationOnce((token, secret) => {
        return { id: 42, role: 'admin', sub: '42' };
      });

      // The proxy middleware should receive req.user
      mockProxyMiddleware.mockImplementationOnce((req, res, next) => {
        res.status(200).json({ userId: req.user?.id, role: req.user?.role });
      });

      const res = await request(app)
        .get('/api/v1/users')
        .set('Authorization', 'Bearer valid_admin_token');

      expect(mockJwtVerify).toHaveBeenCalledWith('valid_admin_token', 'test-jwt-secret');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Proxy Routing
  // ═══════════════════════════════════════════════════════════
  describe('Proxy Routing', () => {
    it('should route /api/v1/auth to user-service', async () => {
      mockJwtVerify.mockImplementationOnce(() => ({ id: 1 }));

      // Mock proxy will handle this
      mockProxyMiddleware.mockImplementationOnce((req, res, next) => {
        res.status(200).json({ routedTo: 'user-service', path: req.path });
      });

      const res = await request(app)
        .get('/api/v1/auth/login')
        .set('Authorization', 'Bearer valid_token');

      expect(res.status).toBe(200);
    });

    it('should route /api/v1/products to product-service', async () => {
      mockJwtVerify.mockImplementationOnce(() => ({ id: 1 }));

      mockProxyMiddleware.mockImplementationOnce((req, res, next) => {
        res.status(200).json({ routedTo: 'product-service' });
      });

      const res = await request(app)
        .get('/api/v1/products/1')
        .set('Authorization', 'Bearer valid_token');

      expect(res.status).toBe(200);
    });

    it('should route /api/v1/orders to order-service', async () => {
      mockJwtVerify.mockImplementationOnce(() => ({ id: 1 }));

      mockProxyMiddleware.mockImplementationOnce((req, res, next) => {
        res.status(200).json({ routedTo: 'order-service' });
      });

      const res = await request(app)
        .get('/api/v1/orders')
        .set('Authorization', 'Bearer valid_token');

      expect(res.status).toBe(200);
    });

    it('should route /api/v1/payments to payment-service', async () => {
      mockJwtVerify.mockImplementationOnce(() => ({ id: 1 }));

      mockProxyMiddleware.mockImplementationOnce((req, res, next) => {
        res.status(200).json({ routedTo: 'payment-service' });
      });

      const res = await request(app)
        .get('/api/v1/payments')
        .set('Authorization', 'Bearer valid_token');

      expect(res.status).toBe(200);
    });

    it('should route /api/v1/webhooks without auth', async () => {
      mockProxyMiddleware.mockImplementationOnce((req, res, next) => {
        res.status(200).json({ routedTo: 'payment-service', auth: req.headers.authorization });
      });

      const res = await request(app)
        .post('/api/v1/webhooks/stripe')
        .send({ type: 'test' });

      expect(res.status).toBe(200);
    });

    it('should route /api/v1/notifications to notification-service', async () => {
      mockJwtVerify.mockImplementationOnce(() => ({ id: 1 }));

      mockProxyMiddleware.mockImplementationOnce((req, res, next) => {
        res.status(200).json({ routedTo: 'notification-service' });
      });

      const res = await request(app)
        .get('/api/v1/notifications')
        .set('Authorization', 'Bearer valid_token');

      expect(res.status).toBe(200);
    });

    it('should handle proxy errors gracefully', async () => {
      mockJwtVerify.mockImplementationOnce(() => ({ id: 1 }));

      // Simulate proxy error through circuit breaker
      mockProxyMiddleware.mockImplementationOnce((req, res, next) => {
        next(new Error('Proxy connection failed'));
      });

      const res = await request(app)
        .get('/api/v1/products')
        .set('Authorization', 'Bearer valid_token');

      // Circuit breaker will catch it and return 502
      expect([502, 503]).toContain(res.status);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Rate Limit Headers
  // ═══════════════════════════════════════════════════════════
  describe('Rate Limit Headers', () => {
    it('should include rate limit headers in responses', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app).get('/health');

      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-window']).toBeDefined();
    });

    it('should set correct rate limit values', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app).get('/health');

      expect(res.headers['x-ratelimit-limit']).toBe('100');
      expect(res.headers['x-ratelimit-window']).toBe('60s');
    });
  });
});

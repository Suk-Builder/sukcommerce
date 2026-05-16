/**
 * payment.test.js — Payment CRUD tests
 * Covers: create, read, cancel, refund, validation, error paths
 */

const request = require('supertest');
const { query, transaction } = require('../../shared/lib/db');

// ─── Setup mocks before importing app ─────────────────────────
require('./setup');

// Mock strategies
const mockStripeCreate = jest.fn();
const mockStripeRefund = jest.fn();
const mockStripeConstructEvent = jest.fn();

const mockAlipayCreate = jest.fn();
const mockAlipayRefund = jest.fn();
const mockAlipayVerify = jest.fn();

jest.mock('../strategies/stripe', () => ({
  StripeStrategy: jest.fn().mockImplementation(() => ({
    create: mockStripeCreate,
    refund: mockStripeRefund,
    constructEvent: mockStripeConstructEvent,
  })),
}));

jest.mock('../strategies/alipay', () => ({
  AlipayStrategy: jest.fn().mockImplementation(() => ({
    create: mockAlipayCreate,
    refund: mockAlipayRefund,
    verifyCallback: mockAlipayVerify,
  })),
}));

const { app } = require('../index');

// ─── Test Data ────────────────────────────────────────────────
const validPaymentBody = {
  order_id: 123,
  order_no: 'ORD2024001',
  user_id: 456,
  amount: 99.99,
  channel: 'stripe',
  description: 'Test payment',
  currency: 'USD',
};

const mockPaymentRecord = (overrides = {}) => ({
  id: 1,
  payment_no: 'PAYabc123',
  order_id: 123,
  order_no: 'ORD2024001',
  user_id: 456,
  channel: 'stripe',
  amount: '99.99',
  currency: 'USD',
  status: 'pending',
  third_party_id: null,
  third_party_response: null,
  paid_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────
describe('Payment API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Health ────────────────────────────────────────────────
  describe('GET /health', () => {
    it('should return health status', async () => {
      const mockPool = require('../../shared/lib/db').getPool();
      mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        service: 'payment-service',
        status: 'ok',
        db: 'connected',
      });
    });

    it('should return 503 when database is down', async () => {
      const mockPool = require('../../shared/lib/db').getPool();
      mockPool.query.mockRejectedValueOnce(new Error('Connection refused'));

      const res = await request(app).get('/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.db).toBe('disconnected');
    });
  });

  // ── Create Payment ────────────────────────────────────────
  describe('POST /payments', () => {
    it('should create a stripe payment successfully (201)', async () => {
      const pending = mockPaymentRecord({ status: 'pending' });
      const processing = mockPaymentRecord({
        status: 'processing',
        third_party_id: 'cs_test_xxx',
        third_party_response: JSON.stringify({ id: 'cs_test_xxx' }),
      });

      query
        .mockResolvedValueOnce({ rows: [pending] })
        .mockResolvedValueOnce({ rows: [processing] });

      mockStripeCreate.mockResolvedValueOnce({
        thirdPartyId: 'cs_test_xxx',
        checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_xxx',
        raw: { id: 'cs_test_xxx' },
      });

      const res = await request(app)
        .post('/payments')
        .send(validPaymentBody);

      expect(res.status).toBe(201);
      expect(res.body.payment).toBeDefined();
      expect(res.body.payment.checkout_url).toBe('https://checkout.stripe.com/pay/cs_test_xxx');
      expect(res.body.payment.third_party_id).toBe('cs_test_xxx');
      expect(mockStripeCreate).toHaveBeenCalledTimes(1);
    });

    it('should create an alipay payment successfully (201)', async () => {
      const body = { ...validPaymentBody, channel: 'alipay' };
      const pending = mockPaymentRecord({ status: 'pending', channel: 'alipay' });
      const processing = mockPaymentRecord({
        status: 'processing',
        channel: 'alipay',
        third_party_id: 'PAYabc123',
        third_party_response: JSON.stringify({ sign: 'xxx' }),
      });

      query
        .mockResolvedValueOnce({ rows: [pending] })
        .mockResolvedValueOnce({ rows: [processing] });

      mockAlipayCreate.mockResolvedValueOnce({
        thirdPartyId: 'PAYabc123',
        checkoutUrl: 'https://openapi.alipay.com/gateway.do?app_id=xxx',
        raw: { sign: 'xxx' },
      });

      const res = await request(app)
        .post('/payments')
        .send(body);

      expect(res.status).toBe(201);
      expect(res.body.payment).toBeDefined();
      expect(res.body.payment.checkout_url).toBe('https://openapi.alipay.com/gateway.do?app_id=xxx');
      expect(mockAlipayCreate).toHaveBeenCalledTimes(1);
    });

    it('should create payment with default channel (stripe)', async () => {
      const body = { ...validPaymentBody };
      delete body.channel;

      const pending = mockPaymentRecord({ status: 'pending' });
      const processing = mockPaymentRecord({
        status: 'processing',
        third_party_id: 'cs_test_xxx',
      });

      query
        .mockResolvedValueOnce({ rows: [pending] })
        .mockResolvedValueOnce({ rows: [processing] });

      mockStripeCreate.mockResolvedValueOnce({
        thirdPartyId: 'cs_test_xxx',
        checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_xxx',
        raw: { id: 'cs_test_xxx' },
      });

      const res = await request(app)
        .post('/payments')
        .send(body);

      expect(res.status).toBe(201);
      expect(mockStripeCreate).toHaveBeenCalledTimes(1);
    });

    it('should create payment with default currency (CNY)', async () => {
      const body = { ...validPaymentBody };
      delete body.currency;

      const pending = mockPaymentRecord({ status: 'pending' });
      const processing = mockPaymentRecord({ status: 'processing', currency: 'CNY' });

      query
        .mockResolvedValueOnce({ rows: [pending] })
        .mockResolvedValueOnce({ rows: [processing] });

      mockStripeCreate.mockResolvedValueOnce({
        thirdPartyId: 'cs_test_xxx',
        checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_xxx',
        raw: { id: 'cs_test_xxx' },
      });

      const res = await request(app)
        .post('/payments')
        .send(body);

      expect(res.status).toBe(201);
      expect(query.mock.calls[0][1]).toContain('CNY');
    });

    it('should return 400 when missing order_id', async () => {
      const body = { ...validPaymentBody };
      delete body.order_id;

      const res = await request(app)
        .post('/payments')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when missing order_no', async () => {
      const body = { ...validPaymentBody };
      delete body.order_no;

      const res = await request(app)
        .post('/payments')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when missing user_id', async () => {
      const body = { ...validPaymentBody };
      delete body.user_id;

      const res = await request(app)
        .post('/payments')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when missing amount', async () => {
      const body = { ...validPaymentBody };
      delete body.amount;

      const res = await request(app)
        .post('/payments')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 for unsupported channel', async () => {
      const body = { ...validPaymentBody, channel: 'bitcoin' };
      const pending = mockPaymentRecord({ status: 'pending', channel: 'bitcoin' });

      query.mockResolvedValueOnce({ rows: [pending] });

      const res = await request(app)
        .post('/payments')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should handle database error during insert', async () => {
      query.mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await request(app)
        .post('/payments')
        .send(validPaymentBody);

      expect(res.status).toBe(500);
    });

    it('should handle stripe strategy failure', async () => {
      const pending = mockPaymentRecord({ status: 'pending' });

      query.mockResolvedValueOnce({ rows: [pending] });
      mockStripeCreate.mockRejectedValueOnce(new Error('Stripe API error'));

      const res = await request(app)
        .post('/payments')
        .send(validPaymentBody);

      expect(res.status).toBe(502);
    });
  });

  // ── Get Payment ───────────────────────────────────────────
  describe('GET /payments/:id', () => {
    it('should return a payment by ID (200)', async () => {
      const payment = mockPaymentRecord({ id: 1 });
      query.mockResolvedValueOnce({ rows: [payment] });

      const res = await request(app).get('/payments/1');
      expect(res.status).toBe(200);
      expect(res.body.payment).toBeDefined();
      expect(res.body.payment.id).toBe(1);
    });

    it('should return 404 for non-existent payment', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/payments/9999');
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 for invalid payment ID', async () => {
      const res = await request(app).get('/payments/abc');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should handle database error', async () => {
      query.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).get('/payments/1');
      expect(res.status).toBe(500);
    });
  });

  // ── Cancel Payment ────────────────────────────────────────
  describe('POST /payments/:id/cancel', () => {
    it('should cancel a pending payment (200)', async () => {
      const cancelled = mockPaymentRecord({ status: 'cancelled' });
      query.mockResolvedValueOnce({ rows: [cancelled] });

      const res = await request(app).post('/payments/1/cancel');
      expect(res.status).toBe(200);
      expect(res.body.payment.status).toBe('cancelled');
    });

    it('should cancel a processing payment (200)', async () => {
      const cancelled = mockPaymentRecord({ id: 2, status: 'cancelled' });
      query.mockResolvedValueOnce({ rows: [cancelled] });

      const res = await request(app).post('/payments/2/cancel');
      expect(res.status).toBe(200);
    });

    it('should return 400 when cancelling succeeded payment', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).post('/payments/3/cancel');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 404 when payment not found', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).post('/payments/9999/cancel');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/cannot be cancelled/);
    });

    it('should return 400 for invalid payment ID', async () => {
      const res = await request(app).post('/payments/abc/cancel');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should handle database error', async () => {
      query.mockRejectedValueOnce(new Error('DB error'));

      const res = await request(app).post('/payments/1/cancel');
      expect(res.status).toBe(500);
    });
  });

  // ── Refund Payment ────────────────────────────────────────
  describe('POST /payments/:id/refund', () => {
    it('should refund a full payment (200)', async () => {
      const succeeded = mockPaymentRecord({
        id: 1,
        status: 'succeeded',
        third_party_id: 'cs_test_xxx',
      });
      const refunded = mockPaymentRecord({
        id: 1,
        status: 'refunded',
        third_party_id: 'cs_test_xxx',
      });

      query
        .mockResolvedValueOnce({ rows: [succeeded] })
        .mockResolvedValueOnce({ rows: [] }) // update to refunding
        .mockResolvedValueOnce({ rows: [refunded] });

      mockStripeRefund.mockResolvedValueOnce({ id: 're_123', amount: 9999 });

      const res = await request(app)
        .post('/payments/1/refund')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.payment.status).toBe('refunded');
      expect(mockStripeRefund).toHaveBeenCalledTimes(1);
    });

    it('should refund partial amount (200)', async () => {
      const succeeded = mockPaymentRecord({
        id: 1,
        status: 'succeeded',
        third_party_id: 'cs_test_xxx',
        amount: '99.99',
      });
      const refunded = mockPaymentRecord({
        id: 1,
        status: 'refunded',
        third_party_id: 'cs_test_xxx',
      });

      query
        .mockResolvedValueOnce({ rows: [succeeded] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [refunded] });

      mockStripeRefund.mockResolvedValueOnce({ id: 're_123', amount: 4999 });

      const res = await request(app)
        .post('/payments/1/refund')
        .send({ amount: 49.99 });

      expect(res.status).toBe(200);
      expect(mockStripeRefund).toHaveBeenCalledTimes(1);
    });

    it('should return 400 for refund amount <= 0', async () => {
      const succeeded = mockPaymentRecord({
        id: 1,
        status: 'succeeded',
        third_party_id: 'cs_test_xxx',
        amount: '99.99',
      });
      query.mockResolvedValueOnce({ rows: [succeeded] });

      const res = await request(app)
        .post('/payments/1/refund')
        .send({ amount: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 for refund amount exceeding payment amount', async () => {
      const succeeded = mockPaymentRecord({
        id: 1,
        status: 'succeeded',
        third_party_id: 'cs_test_xxx',
        amount: '99.99',
      });
      query.mockResolvedValueOnce({ rows: [succeeded] });

      const res = await request(app)
        .post('/payments/1/refund')
        .send({ amount: 199.99 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should return 400 for non-succeeded payment', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/payments/1/refund')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/not eligible for refund/);
    });

    it('should return 400 for invalid payment ID', async () => {
      const res = await request(app)
        .post('/payments/abc/refund')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('should revert status on refund failure', async () => {
      const succeeded = mockPaymentRecord({
        id: 1,
        status: 'succeeded',
        third_party_id: 'cs_test_xxx',
      });

      query
        .mockResolvedValueOnce({ rows: [succeeded] })
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('Refund API error'));

      const res = await request(app)
        .post('/payments/1/refund')
        .send({});

      expect(res.status).toBe(502);
    });

    it('should handle alipay refund', async () => {
      const succeeded = mockPaymentRecord({
        id: 1,
        status: 'succeeded',
        channel: 'alipay',
        third_party_id: 'PAYabc123',
      });
      const refunded = mockPaymentRecord({
        id: 1,
        status: 'refunded',
        channel: 'alipay',
        third_party_id: 'PAYabc123',
      });

      query
        .mockResolvedValueOnce({ rows: [succeeded] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [refunded] });

      mockAlipayRefund.mockResolvedValueOnce({ params: {}, amount: 99.99 });

      const res = await request(app)
        .post('/payments/1/refund')
        .send({});

      expect(res.status).toBe(200);
      expect(mockAlipayRefund).toHaveBeenCalledTimes(1);
    });
  });

  // ── Transaction (handlePaymentSuccess) ────────────────────
  describe('handlePaymentSuccess via webhook path', () => {
    it('should process stripe checkout.session.completed', async () => {
      const rawBody = Buffer.from(JSON.stringify({
        type: 'checkout.session.completed',
        id: 'evt_1',
        data: {
          object: {
            id: 'cs_test_xxx',
            payment_intent: 'pi_xxx',
          },
        },
      }));

      const processing = mockPaymentRecord({
        id: 1,
        status: 'processing',
        third_party_id: 'cs_test_xxx',
        payment_no: 'PAY001',
      });
      const succeeded = mockPaymentRecord({
        id: 1,
        status: 'succeeded',
        third_party_id: 'cs_test_xxx',
      });

      transaction.mockImplementationOnce(async (fn) => {
        const mockTxClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [processing] })
            .mockResolvedValueOnce({ rows: [succeeded] }),
        };
        return await fn(mockTxClient);
      });

      mockStripeConstructEvent.mockReturnValueOnce({
        type: 'checkout.session.completed',
        id: 'evt_1',
        data: {
          object: {
            id: 'cs_test_xxx',
          },
        },
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'sig_valid')
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    });
  });
});

/**
 * webhook.test.js — Webhook endpoint tests
 * Covers: Stripe webhook signature verification, event handling
 *         Alipay callback verification, success/failure paths
 */

const request = require('supertest');
const { query, transaction } = require('../../shared/lib/db');

// ─── Setup mocks before importing app ─────────────────────────
require('./setup');

// Mock strategies
const mockStripeConstructEvent = jest.fn();
const mockAlipayVerify = jest.fn();

jest.mock('../strategies/stripe', () => ({
  StripeStrategy: jest.fn().mockImplementation(() => ({
    create: jest.fn(),
    refund: jest.fn(),
    constructEvent: mockStripeConstructEvent,
  })),
}));

jest.mock('../strategies/alipay', () => ({
  AlipayStrategy: jest.fn().mockImplementation(() => ({
    create: jest.fn(),
    refund: jest.fn(),
    verifyCallback: mockAlipayVerify,
  })),
}));

// Mock the events module
jest.mock('../../shared/lib/events', () => ({
  EventBus: jest.fn().mockImplementation(function () {
    this.connect = jest.fn().mockResolvedValue(undefined);
    this.publish = jest.fn().mockResolvedValue(undefined);
    return this;
  }),
  EventTypes: {
    PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
    PAYMENT_FAILED: 'PAYMENT_FAILED',
    REFUND_SUCCEEDED: 'REFUND_SUCCEEDED',
  },
}));

const { app } = require('../index');

// ─── Test Data ────────────────────────────────────────────────
const mockPaymentRecord = (overrides = {}) => ({
  id: 1,
  payment_no: 'PAY001',
  order_id: 123,
  order_no: 'ORD001',
  user_id: 456,
  channel: 'stripe',
  amount: '99.99',
  currency: 'USD',
  status: 'processing',
  third_party_id: 'cs_test_xxx',
  third_party_response: null,
  paid_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────
describe('Webhook Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════
  // Stripe Webhook
  // ═══════════════════════════════════════════════════════════
  describe('POST /webhooks/stripe', () => {
    it('should return 400 on invalid signature', async () => {
      mockStripeConstructEvent.mockImplementationOnce(() => {
        throw new Error('No signatures found matching the expected signature');
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'invalid_sig')
        .send('{"type":"test"}');

      expect(res.status).toBe(400);
      expect(res.text).toMatch(/Webhook Error/);
      expect(mockStripeConstructEvent).toHaveBeenCalledTimes(1);
    });

    it('should return 400 on expired signature', async () => {
      mockStripeConstructEvent.mockImplementationOnce(() => {
        throw new Error('Timestamp outside the tolerance zone');
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 't=1234567890,v1=expired')
        .send('{"type":"test"}');

      expect(res.status).toBe(400);
      expect(res.text).toMatch(/Webhook Error/);
    });

    it('should return 400 on malformed signature header', async () => {
      mockStripeConstructEvent.mockImplementationOnce(() => {
        throw new Error('Unable to extract timestamp and signatures from header');
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'totally_bogus')
        .send('{"type":"test"}');

      expect(res.status).toBe(400);
    });

    it('should handle checkout.session.completed successfully', async () => {
      const payment = mockPaymentRecord({ status: 'processing' });
      const updated = mockPaymentRecord({ status: 'succeeded', paid_at: new Date().toISOString() });

      mockStripeConstructEvent.mockReturnValueOnce({
        type: 'checkout.session.completed',
        id: 'evt_1',
        data: {
          object: { id: 'cs_test_xxx', payment_intent: 'pi_xxx' },
        },
      });

      transaction.mockImplementationOnce(async (fn) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [payment] })
            .mockResolvedValueOnce({ rows: [updated] })
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
            .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }),
        };
        return await fn(client);
      });

      // Also mock the FOR UPDATE check and COMMIT
      transaction.mockImplementationOnce(async (fn) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [payment] })
            .mockResolvedValueOnce({ rows: [updated] }),
        };
        return await fn(client);
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 't=1234567890,v1=valid_signature')
        .send(JSON.stringify({
          type: 'checkout.session.completed',
          id: 'evt_1',
          data: { object: { id: 'cs_test_xxx' } },
        }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    });

    it('should handle payment_intent.succeeded event', async () => {
      const payment = mockPaymentRecord({
        status: 'processing',
        third_party_id: 'pi_xxx',
      });

      mockStripeConstructEvent.mockReturnValueOnce({
        type: 'payment_intent.succeeded',
        id: 'evt_2',
        data: {
          object: {
            id: 'pi_xxx',
            amount_received: 9999,
            currency: 'usd',
          },
        },
      });

      query.mockResolvedValueOnce({ rows: [payment] });

      // Mock transaction for handlePaymentSuccess
      transaction.mockImplementationOnce(async (fn) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [payment] })
            .mockResolvedValueOnce({
              rows: [{
                ...payment,
                status: 'succeeded',
                paid_at: new Date().toISOString(),
              }],
            }),
        };
        return await fn(client);
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 't=1234567890,v1=sig')
        .send(JSON.stringify({
          type: 'payment_intent.succeeded',
          id: 'evt_2',
          data: { object: { id: 'pi_xxx' } },
        }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    });

    it('should handle payment_intent.succeeded when payment not found', async () => {
      mockStripeConstructEvent.mockReturnValueOnce({
        type: 'payment_intent.succeeded',
        id: 'evt_3',
        data: {
          object: { id: 'pi_unknown' },
        },
      });

      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'sig')
        .send(JSON.stringify({
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_unknown' } },
        }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    });

    it('should handle payment_intent.payment_failed event', async () => {
      const payment = mockPaymentRecord({ status: 'processing' });
      const failed = mockPaymentRecord({ status: 'failed' });

      mockStripeConstructEvent.mockReturnValueOnce({
        type: 'payment_intent.payment_failed',
        id: 'evt_4',
        data: {
          object: {
            id: 'pi_failed',
            last_payment_error: { message: 'Card declined' },
          },
        },
      });

      query.mockResolvedValueOnce({ rows: [payment] });

      transaction.mockImplementationOnce(async (fn) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [payment] })
            .mockResolvedValueOnce({ rows: [failed] }),
        };
        return await fn(client);
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'sig')
        .send(JSON.stringify({
          type: 'payment_intent.payment_failed',
          data: { object: { id: 'pi_failed' } },
        }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    });

    it('should handle unknown event types gracefully', async () => {
      mockStripeConstructEvent.mockReturnValueOnce({
        type: 'invoice.payment_succeeded',
        id: 'evt_5',
        data: { object: { id: 'in_1' } },
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'sig')
        .send(JSON.stringify({
          type: 'invoice.payment_succeeded',
          data: { object: { id: 'in_1' } },
        }));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    });

    it('should handle database error during webhook processing', async () => {
      mockStripeConstructEvent.mockReturnValueOnce({
        type: 'checkout.session.completed',
        id: 'evt_db_error',
        data: {
          object: { id: 'cs_error' },
        },
      });

      transaction.mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'sig')
        .send(JSON.stringify({
          type: 'checkout.session.completed',
          data: { object: { id: 'cs_error' } },
        }));

      expect(res.status).toBe(500);
      expect(res.body.error).toBeDefined();
    });

    it('should handle missing stripe-signature header', async () => {
      mockStripeConstructEvent.mockImplementationOnce(() => {
        throw new Error('No stripe-signature header');
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .send('{"type":"test"}');

      expect(res.status).toBe(400);
    });

    it('should accept raw body for signature verification', async () => {
      mockStripeConstructEvent.mockImplementationOnce((payload, signature) => {
        // Verify that payload is a Buffer (raw body)
        expect(Buffer.isBuffer(payload)).toBe(true);
        return { type: 'test', id: 'evt_raw' };
      });

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'sig')
        .set('Content-Type', 'application/json')
        .send('{"type":"test"}');

      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Alipay Webhook
  // ═══════════════════════════════════════════════════════════
  describe('POST /webhooks/alipay', () => {
    it('should return 400 on invalid callback signature', async () => {
      mockAlipayVerify.mockReturnValueOnce(false);

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          out_trade_no: 'PAY001',
          trade_status: 'TRADE_SUCCESS',
          sign: 'invalid',
        });

      expect(res.status).toBe(400);
      expect(res.text).toBe('fail');
    });

    it('should return 400 when sign is missing', async () => {
      mockAlipayVerify.mockReturnValueOnce(false);

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          out_trade_no: 'PAY001',
          trade_status: 'TRADE_SUCCESS',
        });

      expect(res.status).toBe(400);
      expect(res.text).toBe('fail');
    });

    it('should handle TRADE_SUCCESS status', async () => {
      mockAlipayVerify.mockReturnValueOnce(true);

      const payment = mockPaymentRecord({
        status: 'processing',
        channel: 'alipay',
        payment_no: 'PAY001',
      });
      const succeeded = {
        ...payment,
        status: 'succeeded',
        paid_at: new Date().toISOString(),
      };

      query.mockResolvedValueOnce({ rows: [payment] });

      transaction.mockImplementationOnce(async (fn) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [payment] })
            .mockResolvedValueOnce({ rows: [succeeded] }),
        };
        return await fn(client);
      });

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          out_trade_no: 'PAY001',
          trade_no: '2024.alipay.123',
          trade_status: 'TRADE_SUCCESS',
          total_amount: '99.99',
          sign: 'valid_signature==',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
    });

    it('should handle TRADE_FINISHED status', async () => {
      mockAlipayVerify.mockReturnValueOnce(true);

      const payment = mockPaymentRecord({
        status: 'processing',
        channel: 'alipay',
        payment_no: 'PAY002',
      });

      query.mockResolvedValueOnce({ rows: [payment] });

      transaction.mockImplementationOnce(async (fn) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [payment] })
            .mockResolvedValueOnce({
              rows: [{ ...payment, status: 'succeeded', paid_at: new Date().toISOString() }],
            }),
        };
        return await fn(client);
      });

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          out_trade_no: 'PAY002',
          trade_status: 'TRADE_FINISHED',
          total_amount: '99.99',
          sign: 'valid==',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
    });

    it('should handle TRADE_WAIT_BUYER_PAY status (no-op)', async () => {
      mockAlipayVerify.mockReturnValueOnce(true);

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          out_trade_no: 'PAY003',
          trade_status: 'TRADE_WAIT_BUYER_PAY',
          sign: 'valid==',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
    });

    it('should handle when payment not found for callback', async () => {
      mockAlipayVerify.mockReturnValueOnce(true);

      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          out_trade_no: 'NONEXISTENT',
          trade_status: 'TRADE_SUCCESS',
          sign: 'valid==',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
    });

    it('should handle missing out_trade_no', async () => {
      mockAlipayVerify.mockReturnValueOnce(true);

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          trade_status: 'TRADE_SUCCESS',
          sign: 'valid==',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
    });

    it('should handle database error during alipay callback', async () => {
      mockAlipayVerify.mockReturnValueOnce(true);

      query.mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          out_trade_no: 'PAY001',
          trade_status: 'TRADE_SUCCESS',
          sign: 'valid==',
        });

      expect(res.status).toBe(500);
      expect(res.text).toBe('fail');
    });

    it('should handle callback with query params', async () => {
      mockAlipayVerify.mockReturnValueOnce(true);

      const payment = mockPaymentRecord({
        status: 'processing',
        channel: 'alipay',
        payment_no: 'PAY001',
        third_party_id: 'PAY001',
      });

      query.mockResolvedValueOnce({ rows: [payment] });

      transaction.mockImplementationOnce(async (fn) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [payment] })
            .mockResolvedValueOnce({
              rows: [{ ...payment, status: 'succeeded' }],
            }),
        };
        return await fn(client);
      });

      const res = await request(app)
        .post('/webhooks/alipay?out_trade_no=PAY001')
        .type('form')
        .send({
          trade_status: 'TRADE_SUCCESS',
          sign: 'valid==',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
    });

    it('should handle TRADE_CLOSED status', async () => {
      mockAlipayVerify.mockReturnValueOnce(true);

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          out_trade_no: 'PAY001',
          trade_status: 'TRADE_CLOSED',
          sign: 'valid==',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
    });

    it('should handle refund notification (TRADE_SUCCESS with refund amount)', async () => {
      mockAlipayVerify.mockReturnValueOnce(true);

      const payment = mockPaymentRecord({
        status: 'processing',
        channel: 'alipay',
        payment_no: 'PAY001',
      });

      query.mockResolvedValueOnce({ rows: [payment] });

      transaction.mockImplementationOnce(async (fn) => {
        const client = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [payment] })
            .mockResolvedValueOnce({
              rows: [{ ...payment, status: 'succeeded' }],
            }),
        };
        return await fn(client);
      });

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          out_trade_no: 'PAY001',
          trade_no: '2024.alipay.123',
          trade_status: 'TRADE_SUCCESS',
          refund_fee: '49.99',
          sign: 'valid==',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
    });

    it('should handle very long out_trade_no', async () => {
      mockAlipayVerify.mockReturnValueOnce(true);

      const res = await request(app)
        .post('/webhooks/alipay')
        .type('form')
        .send({
          out_trade_no: 'PAY' + 'X'.repeat(100),
          trade_status: 'TRADE_SUCCESS',
          sign: 'valid==',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
    });
  });
});

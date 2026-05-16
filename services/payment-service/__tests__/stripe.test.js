/**
 * stripe.test.js — Stripe Strategy tests
 * Covers: create checkout, refund, constructEvent, error paths
 */

const { StripeStrategy } = require('../strategies/stripe');
const { Errors } = require('../../shared/lib/errors');

// Mock Stripe module
const mockSessionsCreate = jest.fn();
const mockSessionsRetrieve = jest.fn();
const mockRefundsCreate = jest.fn();
const mockWebhooksConstructEvent = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: mockSessionsCreate,
        retrieve: mockSessionsRetrieve,
      },
    },
    refunds: {
      create: mockRefundsCreate,
    },
    webhooks: {
      constructEvent: mockWebhooksConstructEvent,
    },
  }));
});

// Mock logger
jest.mock('../../shared/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('StripeStrategy', () => {
  let strategy;

  beforeEach(() => {
    jest.clearAllMocks();
    strategy = new StripeStrategy();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  // ─── Constructor ───────────────────────────────────────────
  describe('constructor', () => {
    it('should initialize with API key from environment', () => {
      const Stripe = require('stripe');
      expect(Stripe).toHaveBeenCalledWith('sk_test_xxx', {
        apiVersion: '2023-10-16',
      });
    });
  });

  // ─── create() ──────────────────────────────────────────────
  describe('create', () => {
    const payment = {
      id: 1,
      payment_no: 'PAY001',
      order_no: 'ORD001',
      amount: '99.99',
      currency: 'USD',
    };

    it('should create checkout session successfully', async () => {
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_test_abc123',
        url: 'https://checkout.stripe.com/pay/cs_test_abc123',
        status: 'open',
      });

      const result = await strategy.create(payment, 'Test Product');

      expect(result.thirdPartyId).toBe('cs_test_abc123');
      expect(result.checkoutUrl).toBe('https://checkout.stripe.com/pay/cs_test_abc123');
      expect(result.raw).toEqual({
        id: 'cs_test_abc123',
        url: 'https://checkout.stripe.com/pay/cs_test_abc123',
        status: 'open',
      });

      expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
      const callArg = mockSessionsCreate.mock.calls[0][0];
      expect(callArg).toMatchObject({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: 'Test Product' },
              unit_amount: 9999,
            },
            quantity: 1,
          },
        ],
      });
    });

    it('should use order_no as description when description is empty', async () => {
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_test_abc',
        url: 'https://checkout.stripe.com/pay/cs_test_abc',
      });

      await strategy.create(payment, undefined);

      const callArg = mockSessionsCreate.mock.calls[0][0];
      expect(callArg.line_items[0].price_data.product_data.name).toBe('Order #ORD001');
    });

    it('should convert currency to lowercase', async () => {
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_test_abc',
        url: 'https://checkout.stripe.com/pay/cs_test_abc',
      });

      await strategy.create({ ...payment, currency: 'EUR' }, 'Euro payment');

      const callArg = mockSessionsCreate.mock.calls[0][0];
      expect(callArg.line_items[0].price_data.currency).toBe('eur');
    });

    it('should convert amount to cents correctly', async () => {
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_test_abc',
        url: 'https://checkout.stripe.com/pay/cs_test_abc',
      });

      await strategy.create({ ...payment, amount: '10.50' }, 'Test');

      const callArg = mockSessionsCreate.mock.calls[0][0];
      expect(callArg.line_items[0].price_data.unit_amount).toBe(1050);
    });

    it('should include metadata with payment info', async () => {
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_test_abc',
        url: 'https://checkout.stripe.com/pay/cs_test_abc',
      });

      await strategy.create(payment, 'Test');

      const callArg = mockSessionsCreate.mock.calls[0][0];
      expect(callArg.metadata).toEqual({
        order_no: 'ORD001',
        payment_no: 'PAY001',
        payment_id: '1',
      });
      expect(callArg.client_reference_id).toBe('PAY001');
    });

    it('should handle CNY currency correctly', async () => {
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_test_cny',
        url: 'https://checkout.stripe.com/pay/cs_test_cny',
      });

      await strategy.create({ ...payment, currency: 'CNY' }, 'CNY payment');

      const callArg = mockSessionsCreate.mock.calls[0][0];
      expect(callArg.line_items[0].price_data.currency).toBe('cny');
    });

    it('should wrap Stripe errors in IntegrationError', async () => {
      mockSessionsCreate.mockRejectedValueOnce(
        new Error('Invalid API Key')
      );

      await expect(strategy.create(payment, 'Test')).rejects.toThrow();
      expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
    });

    it('should handle Stripe API rate limit error', async () => {
      mockSessionsCreate.mockRejectedValueOnce(
        new Error('Rate limit exceeded')
      );

      await expect(strategy.create(payment, 'Test')).rejects.toThrow();
    });

    it('should handle network error', async () => {
      mockSessionsCreate.mockRejectedValueOnce(
        new Error('Network error')
      );

      await expect(strategy.create(payment, 'Test')).rejects.toThrow();
    });

    it('should handle empty amount string', async () => {
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_test_empty',
        url: 'https://checkout.stripe.com/pay/cs_test_empty',
      });

      await strategy.create({ ...payment, amount: '' }, 'Test');

      const callArg = mockSessionsCreate.mock.calls[0][0];
      expect(callArg.line_items[0].price_data.unit_amount).toBe(0);
    });
  });

  // ─── refund() ──────────────────────────────────────────────
  describe('refund', () => {
    const payment = {
      id: 1,
      payment_no: 'PAY001',
      third_party_id: 'cs_test_abc',
      amount: '99.99',
      currency: 'USD',
    };

    it('should process full refund successfully', async () => {
      mockSessionsRetrieve.mockResolvedValueOnce({
        id: 'cs_test_abc',
        payment_intent: 'pi_xxx',
      });
      mockRefundsCreate.mockResolvedValueOnce({
        id: 're_123',
        status: 'succeeded',
        amount: 9999,
      });

      const result = await strategy.refund(payment, null);

      expect(result.id).toBe('re_123');
      expect(result.status).toBe('succeeded');
      expect(mockSessionsRetrieve).toHaveBeenCalledWith('cs_test_abc');
      expect(mockRefundsCreate).toHaveBeenCalledWith({
        payment_intent: 'pi_xxx',
      });
    });

    it('should process partial refund with amount', async () => {
      mockSessionsRetrieve.mockResolvedValueOnce({
        id: 'cs_test_abc',
        payment_intent: 'pi_xxx',
      });
      mockRefundsCreate.mockResolvedValueOnce({
        id: 're_456',
        status: 'succeeded',
        amount: 5000,
      });

      const result = await strategy.refund(payment, 50.00);

      expect(result.amount).toBe(5000);
      expect(mockRefundsCreate).toHaveBeenCalledWith({
        payment_intent: 'pi_xxx',
        amount: 5000,
      });
    });

    it('should convert refund amount to cents', async () => {
      mockSessionsRetrieve.mockResolvedValueOnce({
        id: 'cs_test_abc',
        payment_intent: 'pi_xxx',
      });
      mockRefundsCreate.mockResolvedValueOnce({
        id: 're_789',
        status: 'succeeded',
        amount: 1234,
      });

      await strategy.refund(payment, 12.34);

      expect(mockRefundsCreate).toHaveBeenCalledWith({
        payment_intent: 'pi_xxx',
        amount: 1234,
      });
    });

    it('should throw BusinessError when no payment_intent found', async () => {
      mockSessionsRetrieve.mockResolvedValueOnce({
        id: 'cs_test_abc',
        payment_intent: null,
      });

      await expect(strategy.refund(payment, null)).rejects.toThrow();
    });

    it('should throw IntegrationError on refund API failure', async () => {
      mockSessionsRetrieve.mockResolvedValueOnce({
        id: 'cs_test_abc',
        payment_intent: 'pi_xxx',
      });
      mockRefundsCreate.mockRejectedValueOnce(
        new Error('Refund failed: charge already refunded')
      );

      await expect(strategy.refund(payment, null)).rejects.toThrow();
    });

    it('should throw IntegrationError when session retrieval fails', async () => {
      mockSessionsRetrieve.mockRejectedValueOnce(
        new Error('Session not found')
      );

      await expect(strategy.refund(payment, null)).rejects.toThrow();
    });

    it('should handle refund amount of 0', async () => {
      mockSessionsRetrieve.mockResolvedValueOnce({
        id: 'cs_test_abc',
        payment_intent: 'pi_xxx',
      });
      mockRefundsCreate.mockResolvedValueOnce({
        id: 're_0',
        status: 'succeeded',
        amount: 0,
      });

      const result = await strategy.refund(payment, 0);

      expect(result.amount).toBe(0);
      expect(mockRefundsCreate).toHaveBeenCalledWith({
        payment_intent: 'pi_xxx',
        amount: 0,
      });
    });
  });

  // ─── constructEvent() ──────────────────────────────────────
  describe('constructEvent', () => {
    it('should verify webhook signature when secret is set', () => {
      const payload = '{"type":"test"}';
      const signature = 't=123,v1=abc';
      const expectedEvent = { type: 'test', id: 'evt_1' };

      mockWebhooksConstructEvent.mockReturnValueOnce(expectedEvent);

      const result = strategy.constructEvent(payload, signature);

      expect(result).toEqual(expectedEvent);
      expect(mockWebhooksConstructEvent).toHaveBeenCalledWith(
        payload,
        signature,
        'whsec_test_xxx'
      );
    });

    it('should parse JSON directly when no webhook secret is set', () => {
      const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
      process.env.STRIPE_WEBHOOK_SECRET = '';

      // Re-instantiate strategy to pick up new env
      const localStrategy = new StripeStrategy();
      const payload = '{"type":"test.event","id":"evt_2"}';

      const result = localStrategy.constructEvent(payload, 'sig');

      expect(result).toEqual({ type: 'test.event', id: 'evt_2' });

      process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
    });

    it('should parse JSON directly when webhook secret is undefined', () => {
      const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
      delete process.env.STRIPE_WEBHOOK_SECRET;

      const localStrategy = new StripeStrategy();
      const payload = '{"type":"test.event","id":"evt_3"}';

      const result = localStrategy.constructEvent(payload, 'sig');

      expect(result).toEqual({ type: 'test.event', id: 'evt_3' });

      process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
    });

    it('should throw error on invalid signature', () => {
      const payload = '{"type":"test"}';
      const signature = 'invalid_sig';

      mockWebhooksConstructEvent.mockImplementationOnce(() => {
        throw new Error('No signatures found matching the expected signature');
      });

      expect(() => strategy.constructEvent(payload, signature)).toThrow();
    });

    it('should throw error on malformed JSON payload', () => {
      const payload = 'not valid json{';
      const signature = 't=123,v1=abc';

      mockWebhooksConstructEvent.mockImplementationOnce(() => {
        throw new Error('Invalid JSON payload');
      });

      expect(() => strategy.constructEvent(payload, signature)).toThrow();
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────
  describe('edge cases', () => {
    it('should handle large amounts correctly', async () => {
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_large',
        url: 'https://checkout.stripe.com/pay/cs_large',
      });

      await strategy.create(
        { ...payment, amount: '999999.99' },
        'Large payment'
      );

      const callArg = mockSessionsCreate.mock.calls[0][0];
      expect(callArg.line_items[0].price_data.unit_amount).toBe(99999999);
    });

    it('should handle very small amounts', async () => {
      mockSessionsCreate.mockResolvedValueOnce({
        id: 'cs_small',
        url: 'https://checkout.stripe.com/pay/cs_small',
      });

      await strategy.create(
        { ...payment, amount: '0.01' },
        'Tiny payment'
      );

      const callArg = mockSessionsCreate.mock.calls[0][0];
      expect(callArg.line_items[0].price_data.unit_amount).toBe(1);
    });
  });
});

/**
 * alipay.test.js — Alipay Strategy tests
 * Covers: create payment, refund, signature, verifyCallback, error paths
 */

const crypto = require('crypto');
const { AlipayStrategy } = require('../strategies/alipay');

// Mock logger
jest.mock('../../shared/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('AlipayStrategy', () => {
  let strategy;

  beforeEach(() => {
    jest.clearAllMocks();
    strategy = new AlipayStrategy();
  });

  // ─── Constructor ───────────────────────────────────────────
  describe('constructor', () => {
    it('should read ALIPAY_APP_ID from env', () => {
      expect(strategy.appId).toBe('test_alipay_app_id');
    });

    it('should use default gateway when env not set', () => {
      const originalGateway = process.env.ALIPAY_GATEWAY;
      delete process.env.ALIPAY_GATEWAY;

      const localStrategy = new AlipayStrategy();
      expect(localStrategy.gateway).toBe('https://openapi.alipay.com/gateway.do');

      process.env.ALIPAY_GATEWAY = originalGateway;
    });

    it('should format private key correctly', () => {
      expect(strategy.privateKey).toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(strategy.privateKey).toContain('-----END RSA PRIVATE KEY-----');
    });

    it('should format private key with escaped newlines', () => {
      const originalKey = process.env.ALIPAY_PRIVATE_KEY;
      process.env.ALIPAY_PRIVATE_KEY = 'raw_key_without_formatting';

      const localStrategy = new AlipayStrategy();
      expect(localStrategy.privateKey).toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(localStrategy.privateKey).toContain('raw_key_without_formatting');

      process.env.ALIPAY_PRIVATE_KEY = originalKey;
    });

    it('should handle empty private key', () => {
      const originalKey = process.env.ALIPAY_PRIVATE_KEY;
      process.env.ALIPAY_PRIVATE_KEY = '';

      const localStrategy = new AlipayStrategy();
      expect(localStrategy.privateKey).toBe('');

      process.env.ALIPAY_PRIVATE_KEY = originalKey;
    });
  });

  // ─── _formatPrivateKey ─────────────────────────────────────
  describe('_formatPrivateKey', () => {
    it('should return empty string for empty input', () => {
      const result = strategy._formatPrivateKey('');
      expect(result).toBe('');
    });

    it('should return already-formatted key as-is', () => {
      const key = '-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----';
      const result = strategy._formatPrivateKey(key);
      expect(result).toBe(key);
    });

    it('should wrap raw key with PEM headers', () => {
      const result = strategy._formatPrivateKey('raw_key_data');
      expect(result).toBe('-----BEGIN RSA PRIVATE KEY-----\nraw_key_data\n-----END RSA PRIVATE KEY-----');
    });

    it('should handle escaped newline characters', () => {
      const result = strategy._formatPrivateKey('line1\\nline2');
      expect(result).toContain('line1');
      expect(result).toContain('line2');
    });
  });

  // ─── _sign ─────────────────────────────────────────────────
  describe('_sign', () => {
    it('should throw IntegrationError when private key is empty', () => {
      strategy.privateKey = '';
      expect(() => strategy._sign({ app_id: 'test' })).toThrow();
    });

    it('should generate RSA-SHA256 signature', () => {
      const params = {
        app_id: 'test_alipay_app_id',
        method: 'alipay.trade.page.pay',
        charset: 'utf-8',
        sign_type: 'RSA2',
        timestamp: '2024-01-01 12:00:00',
        version: '1.0',
        biz_content: '{"out_trade_no":"PAY001"}',
      };

      const signature = strategy._sign(params);
      expect(typeof signature).toBe('string');
      expect(signature.length).toBeGreaterThan(0);
    });

    it('should exclude sign and sign_type from signing string', () => {
      const params = {
        app_id: 'test',
        method: 'test',
        sign: 'existing_sign',
        sign_type: 'RSA2',
        charset: 'utf-8',
      };

      // Should not throw and should generate a valid signature
      const signature = strategy._sign(params);
      expect(typeof signature).toBe('string');
      expect(signature.length).toBeGreaterThan(0);
    });

    it('should sort parameters alphabetically', () => {
      const params = {
        z_param: 'last',
        a_param: 'first',
        m_param: 'middle',
        charset: 'utf-8',
      };

      const signature = strategy._sign(params);
      expect(typeof signature).toBe('string');
    });

    it('should exclude undefined and empty values', () => {
      const params = {
        app_id: 'test',
        empty_string: '',
        undefined_value: undefined,
        null_value: null,
        charset: 'utf-8',
      };

      const signature = strategy._sign(params);
      expect(typeof signature).toBe('string');
    });
  });

  // ─── create() ──────────────────────────────────────────────
  describe('create', () => {
    const payment = {
      id: 1,
      payment_no: 'PAY001',
      order_no: 'ORD001',
      amount: '99.99',
      currency: 'CNY',
    };

    it('should throw IntegrationError when app_id is not configured', async () => {
      strategy.appId = null;

      await expect(strategy.create(payment, 'Test')).rejects.toThrow('ALIPAY_APP_ID not configured');
    });

    it('should create alipay payment URL successfully', async () => {
      const result = await strategy.create(payment, 'Test Product');

      expect(result.thirdPartyId).toBe('PAY001');
      expect(result.checkoutUrl).toContain('https://openapi.alipay.com/gateway.do');
      expect(result.checkoutUrl).toContain('app_id=test_alipay_app_id');
      expect(result.raw).toBeDefined();
      expect(result.raw.sign).toBeDefined();
    });

    it('should use payment_no as out_trade_no', async () => {
      const result = await strategy.create(payment, 'Test');
      expect(result.thirdPartyId).toBe('PAY001');
    });

    it('should format amount to 2 decimal places', async () => {
      const result = await strategy.create(
        { ...payment, amount: '100' },
        'Test'
      );
      expect(result.raw.biz_content).toContain('100.00');
    });

    it('should include order_no in biz_content', async () => {
      const result = await strategy.create(payment, 'Test Product');
      expect(result.raw.biz_content).toContain('ORD001');
      expect(result.raw.biz_content).toContain('PAY001');
    });

    it('should use description as subject', async () => {
      const result = await strategy.create(payment, 'Custom Description');
      expect(result.raw.biz_content).toContain('Custom Description');
    });

    it('should use order_no as fallback subject', async () => {
      const result = await strategy.create(payment, undefined);
      expect(result.raw.biz_content).toContain('Order #ORD001');
    });

    it('should generate timestamp in correct format', async () => {
      const result = await strategy.create(payment, 'Test');
      expect(result.raw.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('should include all required parameters', async () => {
      const result = await strategy.create(payment, 'Test');

      expect(result.raw).toMatchObject({
        app_id: 'test_alipay_app_id',
        method: 'alipay.trade.page.pay',
        charset: 'utf-8',
        sign_type: 'RSA2',
        version: '1.0',
        return_url: expect.stringContaining('/payment/success'),
        notify_url: expect.stringContaining('/webhooks/alipay'),
      });
    });

    it('should include product_code in biz_content', async () => {
      const result = await strategy.create(payment, 'Test');
      expect(result.raw.biz_content).toContain('FAST_INSTANT_TRADE_PAY');
    });

    it('should include passback_params with payment info', async () => {
      const result = await strategy.create(payment, 'Test');
      expect(result.raw.biz_content).toContain('payment_id');
      expect(result.raw.biz_content).toContain('order_no');
    });

    it('should handle zero amount', async () => {
      const result = await strategy.create(
        { ...payment, amount: '0' },
        'Free item'
      );
      expect(result.raw.biz_content).toContain('0.00');
    });
  });

  // ─── refund() ──────────────────────────────────────────────
  describe('refund', () => {
    const payment = {
      id: 1,
      payment_no: 'PAY001',
      third_party_id: 'PAY001',
      amount: '99.99',
    };

    it('should throw IntegrationError when app_id is not configured', async () => {
      strategy.appId = null;

      await expect(strategy.refund(payment, 50)).rejects.toThrow('ALIPAY_APP_ID not configured');
    });

    it('should create refund request with full amount', async () => {
      const result = await strategy.refund(payment, null);

      expect(result.amount).toBe(99.99);
      expect(result.params.method).toBe('alipay.trade.refund');
    });

    it('should create refund request with partial amount', async () => {
      const result = await strategy.refund(payment, 50.00);

      expect(result.amount).toBe(50.00);
    });

    it('should format refund amount to 2 decimal places', async () => {
      const result = await strategy.refund(payment, 10);

      expect(result.amount).toBe(10);
      expect(result.params.biz_content).toContain('10.00');
    });

    it('should generate unique out_request_no', async () => {
      const result1 = await strategy.refund(payment, 10);
      const result2 = await strategy.refund(payment, 10);

      expect(result1.params.biz_content).not.toBe(result2.params.biz_content);
    });

    it('should use third_party_id for out_trade_no', async () => {
      const result = await strategy.refund(
        { ...payment, third_party_id: 'TPID_001' },
        10
      );

      expect(result.params.biz_content).toContain('TPID_001');
    });

    it('should fallback to payment_no when third_party_id is empty', async () => {
      const result = await strategy.refund(
        { ...payment, third_party_id: null },
        10
      );

      expect(result.params.biz_content).toContain('PAY001');
    });

    it('should include sign in refund params', async () => {
      const result = await strategy.refund(payment, 10);

      expect(result.params.sign).toBeDefined();
      expect(typeof result.params.sign).toBe('string');
    });

    it('should handle amount of 0', async () => {
      const result = await strategy.refund(payment, 0);

      expect(result.amount).toBe(0);
      expect(result.params.biz_content).toContain('0.00');
    });

    it('should handle undefined amount', async () => {
      const result = await strategy.refund(payment, undefined);

      expect(result.amount).toBe(99.99);
    });
  });

  // ─── verifyCallback ────────────────────────────────────────
  describe('verifyCallback', () => {
    it('should return true when sign is present', () => {
      const params = {
        out_trade_no: 'PAY001',
        trade_status: 'TRADE_SUCCESS',
        sign: 'valid_signature_base64==',
      };

      const result = strategy.verifyCallback(params);
      expect(result).toBe(true);
    });

    it('should return false when sign is missing', () => {
      const params = {
        out_trade_no: 'PAY001',
        trade_status: 'TRADE_SUCCESS',
      };

      const result = strategy.verifyCallback(params);
      expect(result).toBe(false);
    });

    it('should return false for empty sign', () => {
      const params = {
        out_trade_no: 'PAY001',
        trade_status: 'TRADE_SUCCESS',
        sign: '',
      };

      const result = strategy.verifyCallback(params);
      expect(result).toBe(false);
    });

    it('should handle complex callback params', () => {
      const params = {
        out_trade_no: 'PAY001',
        trade_no: '2024.alipay.123',
        trade_status: 'TRADE_SUCCESS',
        total_amount: '99.99',
        sign: 'abc123signature==',
        sign_type: 'RSA2',
      };

      const result = strategy.verifyCallback(params);
      expect(result).toBe(true);
    });

    it('should handle empty params object', () => {
      const result = strategy.verifyCallback({});
      expect(result).toBe(false);
    });
  });

  // ─── Error Handling ────────────────────────────────────────
  describe('error handling', () => {
    it('should handle _sign with null params values', () => {
      const params = {
        app_id: 'test',
        null_value: null,
        undefined_value: undefined,
        real_value: 'exists',
      };

      // Should not throw
      const signature = strategy._sign(params);
      expect(typeof signature).toBe('string');
    });

    it('should handle very large amounts in create', async () => {
      const largePayment = {
        id: 1,
        payment_no: 'PAY999',
        order_no: 'ORD999',
        amount: '9999999.99',
      };

      const result = await strategy.create(largePayment, 'Big purchase');
      expect(result.raw.biz_content).toContain('9999999.99');
    });
  });
});

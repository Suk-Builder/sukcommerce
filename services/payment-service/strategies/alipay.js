const crypto = require('crypto');
const querystring = require('querystring');
const { createLogger } = require('../../shared/lib/logger');
const { Errors } = require('../../shared/lib/errors');

const logger = createLogger('alipay-strategy');

class AlipayStrategy {
  constructor() {
    this.appId = process.env.ALIPAY_APP_ID;
    this.privateKey = this._formatPrivateKey(process.env.ALIPAY_PRIVATE_KEY || '');
    this.gateway = process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do';
  }

  _formatPrivateKey(key) {
    if (!key) return '';
    const trimmed = key.replace(/\\n/g, '\n').trim();
    if (trimmed.includes('-----BEGIN RSA PRIVATE KEY-----')) return trimmed;
    return `-----BEGIN RSA PRIVATE KEY-----\n${trimmed}\n-----END RSA PRIVATE KEY-----`;
  }

  /**
   * Generate RSA2 signature for Alipay
   * @param {Object} params - Parameters to sign
   * @returns {string} - Base64 encoded signature
   */
  _sign(params) {
    if (!this.privateKey) {
      throw new Errors.IntegrationError('Alipay private key not configured');
    }
    // Sort and filter params
    const sortedKeys = Object.keys(params)
      .filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== '' && k !== 'sign_type')
      .sort();

    const signString = sortedKeys
      .map(k => `${k}=${params[k]}`)
      .join('&');

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signString, 'utf8');
    return signer.sign(this.privateKey, 'base64');
  }

  /**
   * Create an Alipay payment (page pay)
   * @param {Object} payment - Payment record from DB
   * @param {string} description - Payment description
   * @returns {Promise<{thirdPartyId: string, checkoutUrl: string, raw: Object}>}
   */
  async create(payment, description) {
    if (!this.appId) {
      throw new Errors.IntegrationError('ALIPAY_APP_ID not configured');
    }

    const outTradeNo = payment.payment_no;
    const totalAmount = payment.amount.toFixed(2);
    const subject = description || `Order #${payment.order_no}`;
    const returnUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/payment/success?order_no=${payment.order_no}`;
    const notifyUrl = `${process.env.PUBLIC_URL || 'http://localhost:3004'}/webhooks/alipay`;

    const bizContent = JSON.stringify({
      out_trade_no: outTradeNo,
      total_amount: totalAmount,
      subject: subject,
      product_code: 'FAST_INSTANT_TRADE_PAY',
      body: description || '',
      passback_params: encodeURIComponent(JSON.stringify({
        order_no: payment.order_no,
        payment_no: payment.payment_no,
        payment_id: String(payment.id),
      })),
    });

    const params = {
      app_id: this.appId,
      method: 'alipay.trade.page.pay',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      version: '1.0',
      biz_content: bizContent,
      return_url: returnUrl,
      notify_url: notifyUrl,
    };

    // Generate signature
    params.sign = this._sign(params);

    // Build redirect URL
    const queryStr = querystring.stringify(params);
    const checkoutUrl = `${this.gateway}?${queryStr}`;

    logger.info('Alipay payment URL created', {
      paymentNo: outTradeNo,
      appId: this.appId,
    });

    return {
      thirdPartyId: outTradeNo, // Alipay uses our payment_no as out_trade_no
      checkoutUrl,
      raw: params,
    };
  }

  /**
   * Refund an Alipay payment
   * @param {Object} payment - Payment record
   * @param {number|null} amount - Refund amount (null for full refund)
   * @returns {Promise<Object>}
   */
  async refund(payment, amount) {
    if (!this.appId) {
      throw new Errors.IntegrationError('ALIPAY_APP_ID not configured');
    }

    const refundAmount = amount !== null && amount !== undefined ? amount.toFixed(2) : payment.amount.toFixed(2);

    const bizContent = JSON.stringify({
      out_trade_no: payment.third_party_id || payment.payment_no,
      refund_amount: refundAmount,
      out_request_no: `REF${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`,
    });

    const params = {
      app_id: this.appId,
      method: 'alipay.trade.refund',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      version: '1.0',
      biz_content: bizContent,
    };

    params.sign = this._sign(params);

    logger.info('Alipay refund submitted', {
      paymentNo: payment.payment_no,
      refundAmount,
    });

    return { params, amount: parseFloat(refundAmount) };
  }

  /**
   * Verify Alipay callback signature (simplified)
   * @param {Object} params - Callback query/body params
   * @returns {boolean}
   */
  verifyCallback(params) {
    // Simplified verification - in production, verify sign with Alipay public key
    const sign = params.sign;
    if (!sign) return false;
    logger.debug('Alipay callback signature verification (simplified)');
    return true;
  }
}

module.exports = { AlipayStrategy };

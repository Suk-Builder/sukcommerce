/**
 * 支付宝策略 — 当面付/网页支付
 */
const crypto = require('crypto');

class AlipayStrategy {
  constructor() {
    this.appId = process.env.ALIPAY_APP_ID;
    this.privateKey = process.env.ALIPAY_PRIVATE_KEY;
    this.gateway = 'https://openapi.alipay.com/gateway.do';
  }

  async create(payment, description) {
    const bizContent = JSON.stringify({
      out_trade_no: payment.payment_no,
      total_amount: payment.amount,
      subject: description || `订单 ${payment.order_no}`,
      product_code: 'FAST_INSTANT_TRADE_PAY',
    });

    const params = {
      app_id: this.appId,
      method: 'alipay.trade.page.pay',
      format: 'JSON',
      return_url: `https://sukcommerce.com/orders/${payment.order_no}?status=success`,
      notify_url: 'https://api.sukcommerce.com/webhooks/alipay',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      version: '1.0',
      biz_content: bizContent,
    };

    params.sign = this.sign(params);

    const query = new URLSearchParams(params).toString();
    const checkoutUrl = `${this.gateway}?${query}`;

    return {
      thirdPartyId: payment.payment_no,
      checkoutUrl,
      raw: { params },
    };
  }

  sign(params) {
    const signStr = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return crypto.createSign('RSA-SHA256').update(signStr).sign(this.privateKey, 'base64');
  }

  verifySign(params, sign) {
    const signStr = Object.keys(params).filter(k => k !== 'sign').sort().map(k => `${k}=${params[k]}`).join('&');
    return crypto.createVerify('RSA-SHA256').update(signStr).verify(this.publicKey, sign, 'base64');
  }
}

module.exports = { AlipayStrategy };

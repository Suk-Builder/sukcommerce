/**
 * 支付服务 — 多支付渠道策略模式
 * Stripe / 支付宝 / 微信支付
 */
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const { createLogger, requestIdMiddleware } = require('../../shared/lib/logger');
const { Errors, errorHandler } = require('../../shared/lib/errors');
const { EventBus, EventTypes } = require('../../shared/lib/events');
const { StripeStrategy } = require('./strategies/stripe');
const { AlipayStrategy } = require('./strategies/alipay');

const logger = createLogger();
const app = express();
app.use(express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(requestIdMiddleware);

const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
const eventBus = new EventBus();
eventBus.connect();

// ─── 策略注册 ───
const strategies = {
  stripe: new StripeStrategy(),
  alipay: new AlipayStrategy(),
};

// ─── DB ───
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      payment_no VARCHAR(32) UNIQUE NOT NULL,
      order_id BIGINT NOT NULL,
      order_no VARCHAR(32) NOT NULL,
      user_id BIGINT NOT NULL,
      channel VARCHAR(20) NOT NULL CHECK (channel IN ('stripe','alipay','wechat')),
      amount DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'CNY',
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','processing','succeeded','failed','cancelled','refunding','refunded')),
      third_party_id VARCHAR(255),
      third_party_response JSONB,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
  `);
}

function generatePaymentNo() {
  return 'PAY' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();
}

// ─── 创建支付 ───
app.post('/payments', async (req, res, next) => {
  try {
    const { order_id, order_no, user_id, amount, channel = 'stripe', description } = req.body;
    const strategy = strategies[channel];
    if (!strategy) throw Errors.INVALID_PAYMENT_METHOD();

    const paymentNo = generatePaymentNo();
    const result = await pool.query(
      `INSERT INTO payments (payment_no, order_id, order_no, user_id, channel, amount, currency, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
      [paymentNo, order_id, order_no, user_id, channel, amount, channel === 'stripe' ? 'USD' : 'CNY']
    );
    const payment = result.rows[0];

    // 调用第三方支付创建
    const payResult = await strategy.create(payment, description);
    await pool.query(
      'UPDATE payments SET third_party_id = $1, third_party_response = $2, status = $3 WHERE id = $4',
      [payResult.thirdPartyId, JSON.stringify(payResult.raw), 'processing', payment.id]
    );

    res.status(201).json({ payment: { ...payment, checkout_url: payResult.checkoutUrl } });
  } catch (err) { next(err); }
});

// ─── 取消支付 ───
app.post('/payments/:orderNo/cancel', async (req, res, next) => {
  try {
    const result = await pool.query("UPDATE payments SET status = 'cancelled' WHERE order_no = $1 RETURNING *", [req.params.orderNo]);
    res.json({ payment: result.rows[0] });
  } catch (err) { next(err); }
});

// ─── Stripe Webhook ───
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const event = stripe.webhooks.constructEvent(req.body, sig, secret);

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      await handlePaymentSuccess('stripe', paymentIntent.id, paymentIntent);
    } else if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object;
      await handlePaymentFailure('stripe', paymentIntent.id);
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// ─── 支付宝回调 ───
app.post('/webhooks/alipay', async (req, res) => {
  try {
    const { out_trade_no, trade_status, trade_no } = req.body;
    if (trade_status === 'TRADE_SUCCESS') {
      await handlePaymentSuccess('alipay', trade_no, req.body);
    }
    res.send('success'); // 支付宝要求返回 'success'
  } catch (err) {
    logger.error('Alipay webhook error:', err);
    res.status(500).send('fail');
  }
});

// ─── 内部函数 ───
async function handlePaymentSuccess(channel, thirdPartyId, raw) {
  const result = await pool.query(
    'UPDATE payments SET status = $1, third_party_response = $2, paid_at = NOW() WHERE third_party_id = $3 RETURNING *',
    ['succeeded', JSON.stringify(raw), thirdPartyId]
  );
  if (result.rows[0]) {
    await eventBus.publish(EventTypes.PAYMENT_SUCCEEDED, {
      payment_id: result.rows[0].id,
      order_id: result.rows[0].order_id,
      order_no: result.rows[0].order_no,
      amount: result.rows[0].amount,
      channel
    });
    await eventBus.publish(EventTypes.ORDER_PAID, {
      order_id: result.rows[0].order_id,
      payment_id: result.rows[0].id
    });
  }
}

async function handlePaymentFailure(channel, thirdPartyId) {
  const result = await pool.query(
    "UPDATE payments SET status = 'failed' WHERE third_party_id = $1 RETURNING *",
    [thirdPartyId]
  );
  if (result.rows[0]) {
    await eventBus.publish(EventTypes.PAYMENT_FAILED, {
      order_id: result.rows[0].order_id,
      order_no: result.rows[0].order_no
    });
  }
}

app.get('/health', (req, res) => res.json({ service: 'payment-service', status: 'healthy' }));
app.use(errorHandler);

const PORT = process.env.PORT || 3004;
initDb().then(() => {
  app.listen(PORT, () => logger.info(`PaymentService on ${PORT}`));
});

require('dotenv').config();

const express = require('express');
const { createLogger, requestIdMiddleware } = require('../../shared/lib/logger');
const { Errors, errorHandler } = require('../../shared/lib/errors');
const { EventBus, EventTypes } = require('../../shared/lib/events');
const { getPool, query, transaction } = require('../../shared/lib/db');

const { StripeStrategy } = require('./strategies/stripe');
const { AlipayStrategy } = require('./strategies/alipay');

const logger = createLogger('payment-service');
const app = express();
const PORT = process.env.PORT || 3004;

// ─── Strategy Registry ───────────────────────────────────────────────────────

class BaseStrategy {
  async create(payment, description) {
    throw new Error('create() must be implemented');
  }
  async refund(payment, amount) {
    throw new Error('refund() must be implemented');
  }
}

const strategies = {
  stripe: new StripeStrategy(),
  alipay: new AlipayStrategy(),
  wechat: null, // placeholder
};

function getStrategy(channel) {
  const strategy = strategies[channel];
  if (!strategy) {
    throw new Errors.BusinessError(`Unsupported payment channel: ${channel}`);
  }
  return strategy;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function generatePaymentNo() {
  return `PAY${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
}

// ─── Event Bus ───────────────────────────────────────────────────────────────

let eventBus;
async function publishEvent(eventType, payload) {
  if (!eventBus) return;
  try {
    await eventBus.publish(eventType, payload);
  } catch (err) {
    logger.error('Failed to publish event', { eventType, error: err.message });
  }
}

// ─── Payment Handlers ────────────────────────────────────────────────────────

async function handlePaymentSuccess(thirdPartyId, rawResponse) {
  logger.info('Processing payment success', { thirdPartyId });

  const result = await transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM payments WHERE third_party_id = $1 AND status IN ('pending', 'processing') FOR UPDATE`,
      [thirdPartyId]
    );
    if (rows.length === 0) {
      logger.warn('Payment not found or already processed', { thirdPartyId });
      return null;
    }

    const payment = rows[0];
    const { rows: updated } = await client.query(
      `UPDATE payments SET status = 'succeeded', paid_at = NOW(), third_party_response = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [rawResponse ? JSON.stringify(rawResponse) : null, payment.id]
    );
    return updated[0];
  });

  if (result) {
    await publishEvent(EventTypes.PAYMENT_SUCCEEDED, {
      paymentId: result.id,
      paymentNo: result.payment_no,
      orderId: result.order_id,
      orderNo: result.order_no,
      amount: result.amount,
      channel: result.channel,
    });
    logger.info('Payment marked as succeeded', { paymentNo: result.payment_no });
  }

  return result;
}

async function handlePaymentFailure(thirdPartyId, rawResponse) {
  logger.info('Processing payment failure', { thirdPartyId });

  const result = await transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM payments WHERE third_party_id = $1 AND status IN ('pending', 'processing') FOR UPDATE`,
      [thirdPartyId]
    );
    if (rows.length === 0) return null;

    const payment = rows[0];
    const { rows: updated } = await client.query(
      `UPDATE payments SET status = 'failed', third_party_response = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [rawResponse ? JSON.stringify(rawResponse) : null, payment.id]
    );
    return updated[0];
  });

  if (result) {
    await publishEvent(EventTypes.PAYMENT_FAILED, {
      paymentId: result.id,
      paymentNo: result.payment_no,
      orderId: result.order_id,
      orderNo: result.order_no,
      channel: result.channel,
    });
    logger.info('Payment marked as failed', { paymentNo: result.payment_no });
  }

  return result;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(requestIdMiddleware);
app.use(express.json());

// Raw body parser for Stripe webhooks
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

// ─── Routes ──────────────────────────────────────────────────────────────────

// ── Health Check ──
app.get('/health', async (req, res) => {
  const dbOk = await getPool().query('SELECT 1').then(() => true).catch(() => false);
  res.status(dbOk ? 200 : 503).json({
    service: process.env.SERVICE_NAME || 'payment-service',
    status: dbOk ? 'ok' : 'unhealthy',
    db: dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// ── Create Payment ──
app.post('/payments', async (req, res, next) => {
  try {
    const {
      order_id,
      order_no,
      user_id,
      amount,
      channel = 'stripe',
      description,
      currency = 'CNY',
    } = req.body;

    if (!order_id || !order_no || !user_id || !amount) {
      throw new Errors.ValidationError('Missing required fields: order_id, order_no, user_id, amount');
    }

    const paymentNo = generatePaymentNo();
    const paymentCurrency = currency.toUpperCase();
    const paymentChannel = channel.toLowerCase();

    // Insert payment record
    const { rows: paymentRows } = await query(
      `INSERT INTO payments (payment_no, order_id, order_no, user_id, channel, amount, currency, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
       RETURNING *`,
      [paymentNo, order_id, order_no, user_id, paymentChannel, amount, paymentCurrency]
    );

    const payment = paymentRows[0];

    // Get strategy and create third-party payment
    const strategy = getStrategy(paymentChannel);
    const { thirdPartyId, checkoutUrl, raw } = await strategy.create(payment, description);

    // Update payment with third party info
    const { rows: updatedRows } = await query(
      `UPDATE payments SET third_party_id = $1, third_party_response = $2, status = 'processing', updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [thirdPartyId, raw ? JSON.stringify(raw) : null, payment.id]
    );

    const updatedPayment = updatedRows[0];

    logger.info('Payment created', {
      paymentNo: updatedPayment.payment_no,
      channel: paymentChannel,
      orderNo: order_no,
    });

    res.status(201).json({
      payment: {
        ...updatedPayment,
        checkout_url: checkoutUrl,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Get Payment ──
app.get('/payments/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const paymentId = parseInt(id, 10);

    if (isNaN(paymentId)) {
      throw new Errors.ValidationError('Invalid payment ID');
    }

    const { rows } = await query(
      `SELECT * FROM payments WHERE id = $1`,
      [paymentId]
    );

    if (rows.length === 0) {
      throw new Errors.NotFoundError('Payment not found');
    }

    res.json({ payment: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── Cancel Payment ──
app.post('/payments/:id/cancel', async (req, res, next) => {
  try {
    const { id } = req.params;
    const paymentId = parseInt(id, 10);

    if (isNaN(paymentId)) {
      throw new Errors.ValidationError('Invalid payment ID');
    }

    const { rows } = await query(
      `UPDATE payments SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'processing') RETURNING *`,
      [paymentId]
    );

    if (rows.length === 0) {
      throw new Errors.BusinessError('Payment not found or cannot be cancelled');
    }

    logger.info('Payment cancelled', { paymentNo: rows[0].payment_no });

    res.json({ payment: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ── Refund Payment ──
app.post('/payments/:id/refund', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    const paymentId = parseInt(id, 10);

    if (isNaN(paymentId)) {
      throw new Errors.ValidationError('Invalid payment ID');
    }

    const { rows: paymentRows } = await query(
      `SELECT * FROM payments WHERE id = $1 AND status = 'succeeded'`,
      [paymentId]
    );

    if (paymentRows.length === 0) {
      throw new Errors.BusinessError('Payment not found or not eligible for refund');
    }

    const payment = paymentRows[0];

    // Validate refund amount
    const refundAmount = amount ? parseFloat(amount) : null;
    if (refundAmount && (refundAmount <= 0 || refundAmount > parseFloat(payment.amount))) {
      throw new Errors.ValidationError('Invalid refund amount');
    }

    // Update status to refunding
    await query(
      `UPDATE payments SET status = 'refunding', updated_at = NOW() WHERE id = $1`,
      [paymentId]
    );

    // Execute refund via strategy
    const strategy = getStrategy(payment.channel);
    const refundResult = await strategy.refund(payment, refundAmount);

    // Update to refunded
    const { rows: updatedRows } = await query(
      `UPDATE payments SET status = 'refunded', third_party_response =
        COALESCE(third_party_response, '{}'::jsonb) || jsonb_build_object('refund', $1::jsonb),
       updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(refundResult), paymentId]
    );

    const updatedPayment = updatedRows[0];

    // Publish refund event
    await publishEvent(EventTypes.REFUND_SUCCEEDED, {
      paymentId: updatedPayment.id,
      paymentNo: updatedPayment.payment_no,
      orderId: updatedPayment.order_id,
      orderNo: updatedPayment.order_no,
      amount: refundAmount || updatedPayment.amount,
      channel: updatedPayment.channel,
    });

    logger.info('Payment refunded', {
      paymentNo: updatedPayment.payment_no,
      refundAmount: refundAmount || updatedPayment.amount,
    });

    res.json({ payment: updatedPayment });
  } catch (err) {
    // Revert status on failure
    try {
      await query(
        `UPDATE payments SET status = 'succeeded', updated_at = NOW() WHERE id = $1`,
        [parseInt(id, 10)]
      );
    } catch (_) { /* ignore */ }

    if (err instanceof Errors.AppError) {
      next(err);
    } else {
      next(new Errors.IntegrationError(`Refund failed: ${err.message}`));
    }
  }
});

// ─── Webhooks (No JWT) ───────────────────────────────────────────────────────

// ── Stripe Webhook ──
app.post('/webhooks/stripe', async (req, res) => {
  const payload = req.body;
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    const strategy = getStrategy('stripe');
    event = strategy.constructEvent(payload, signature);
  } catch (err) {
    logger.warn('Stripe webhook signature verification failed', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  logger.info('Stripe webhook received', { type: event.type, id: event.id });

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;
        // Find payment by payment_intent or session
        const { rows } = await query(
          `SELECT * FROM payments WHERE third_party_id = $1 OR
           third_party_response->>'payment_intent' = $2`,
          [paymentIntent.id, paymentIntent.id]
        );
        if (rows.length > 0) {
          await handlePaymentSuccess(rows[0].third_party_id, event);
        } else {
          // Try to find via checkout session
          logger.info('Payment not found directly, will be handled by checkout.session.completed');
        }
        break;
      }
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handlePaymentSuccess(session.id, event);
        break;
      }
      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object;
        const { rows } = await query(
          `SELECT * FROM payments WHERE third_party_id = $1`,
          [paymentIntent.id]
        );
        if (rows.length > 0) {
          await handlePaymentFailure(rows[0].third_party_id, event);
        }
        break;
      }
      default:
        logger.debug('Unhandled Stripe event type', { type: event.type });
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook processing failed', { error: err.message });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── Alipay Webhook ──
app.post('/webhooks/alipay', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  const params = { ...req.body, ...req.query };
  const tradeStatus = params.trade_status;

  logger.info('Alipay webhook received', { tradeStatus, outTradeNo: params.out_trade_no });

  // Simplified verification
  const strategy = getStrategy('alipay');
  if (!strategy.verifyCallback(params)) {
    return res.status(400).send('fail');
  }

  try {
    if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
      const outTradeNo = params.out_trade_no || params.out_trade_no;
      if (outTradeNo) {
        // Find by payment_no (which is used as out_trade_no)
        const { rows } = await query(
          `SELECT * FROM payments WHERE payment_no = $1 OR third_party_id = $2`,
          [outTradeNo, outTradeNo]
        );
        if (rows.length > 0) {
          await handlePaymentSuccess(rows[0].third_party_id || rows[0].payment_no, params);
        }
      }
    }

    res.send('success');
  } catch (err) {
    logger.error('Alipay webhook processing failed', { error: err.message });
    res.status(500).send('fail');
  }
});

// ─── Error Handler ───────────────────────────────────────────────────────────

app.use(errorHandler);

// ─── Database Init ───────────────────────────────────────────────────────────

async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      payment_no VARCHAR(32) UNIQUE NOT NULL,
      order_id BIGINT NOT NULL,
      order_no VARCHAR(32) NOT NULL,
      user_id BIGINT NOT NULL,
      channel VARCHAR(20) NOT NULL CHECK (channel IN ('stripe', 'alipay', 'wechat')),
      amount DECIMAL(12,2) NOT NULL,
      currency VARCHAR(3) DEFAULT 'CNY',
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'cancelled', 'refunding', 'refunded')),
      third_party_id VARCHAR(255),
      third_party_response JSONB,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Create index on payment_no for fast lookup
  await query(`
    CREATE INDEX IF NOT EXISTS idx_payments_payment_no ON payments(payment_no)
  `);

  // Create index on third_party_id for webhook lookups
  await query(`
    CREATE INDEX IF NOT EXISTS idx_payments_third_party_id ON payments(third_party_id)
  `);

  // Create index on order_id for order queries
  await query(`
    CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id)
  `);

  logger.info('Database initialized');
}

// ─── Event Bus Init ──────────────────────────────────────────────────────────

async function initEventBus() {
  try {
    eventBus = new EventBus({ url: process.env.RABBITMQ_URL || 'amqp://localhost' });
    await eventBus.connect();
    logger.info('EventBus connected');
  } catch (err) {
    logger.warn('EventBus not connected, running without events', { error: err.message });
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

async function start() {
  await initDatabase();
  await initEventBus();

  app.listen(PORT, () => {
    logger.info(`Payment service running on port ${PORT}`);
  });
}

start().catch((err) => {
  logger.error('Startup failed', { error: err.message });
  process.exit(1);
});

module.exports = { app, generatePaymentNo };

const Stripe = require('stripe');
const { createLogger } = require('../../shared/lib/logger');
const { Errors } = require('../../shared/lib/errors');

const logger = createLogger('stripe-strategy');

class StripeStrategy {
  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16',
    });
  }

  /**
   * Create a Stripe Checkout Session
   * @param {Object} payment - Payment record from DB
   * @param {string} description - Payment description
   * @returns {Promise<{thirdPartyId: string, checkoutUrl: string, raw: Object}>}
   */
  async create(payment, description) {
    try {
      const amountInCents = Math.round(payment.amount * 100);
      const currency = (payment.currency || 'USD').toLowerCase();
      const successUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/payment/success?order_no=${payment.order_no}`;
      const cancelUrl = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/payment/cancel?order_no=${payment.order_no}`;

      const session = await this.stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency,
              product_data: {
                name: description || `Order #${payment.order_no}`,
              },
              unit_amount: amountInCents,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          order_no: payment.order_no,
          payment_no: payment.payment_no,
          payment_id: String(payment.id),
        },
        client_reference_id: payment.payment_no,
      });

      logger.info('Stripe checkout session created', {
        paymentNo: payment.payment_no,
        sessionId: session.id,
      });

      return {
        thirdPartyId: session.id,
        checkoutUrl: session.url,
        raw: session,
      };
    } catch (err) {
      logger.error('Stripe create checkout failed', { error: err.message, paymentNo: payment.payment_no });
      throw new Errors.IntegrationError(`Stripe checkout creation failed: ${err.message}`);
    }
  }

  /**
   * Refund a Stripe payment
   * @param {Object} payment - Payment record with third_party_id
   * @param {number|null} amount - Refund amount (null for full refund)
   * @returns {Promise<Object>}
   */
  async refund(payment, amount) {
    try {
      // Retrieve session to get payment_intent
      const session = await this.stripe.checkout.sessions.retrieve(payment.third_party_id);
      if (!session.payment_intent) {
        throw new Errors.BusinessError('No payment_intent found for this session');
      }

      const refundData = {
        payment_intent: session.payment_intent,
      };

      if (amount) {
        refundData.amount = Math.round(amount * 100);
      }

      const refund = await this.stripe.refunds.create(refundData);

      logger.info('Stripe refund processed', {
        paymentNo: payment.payment_no,
        refundId: refund.id,
        amount: amount || payment.amount,
      });

      return refund;
    } catch (err) {
      logger.error('Stripe refund failed', { error: err.message, paymentNo: payment.payment_no });
      throw new Errors.IntegrationError(`Stripe refund failed: ${err.message}`);
    }
  }

  /**
   * Construct Stripe webhook event (signature verification)
   * @param {string} payload - Raw request body
   * @param {string} signature - Stripe-Signature header
   * @returns {Object} - Verified event
   */
  constructEvent(payload, signature) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      logger.warn('STRIPE_WEBHOOK_SECRET not set, skipping signature verification');
      return JSON.parse(payload);
    }
    return this.stripe.webhooks.constructEvent(payload, signature, secret);
  }
}

module.exports = { StripeStrategy };

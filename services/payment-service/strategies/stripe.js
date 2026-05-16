/**
 * Stripe 支付策略
 */
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

class StripeStrategy {
  async create(payment, description) {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: description || `Order ${payment.order_no}` },
          unit_amount: Math.round(payment.amount * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://sukcommerce.com/orders/${payment.order_no}?status=success`,
      cancel_url: `https://sukcommerce.com/orders/${payment.order_no}?status=cancel`,
      metadata: { order_no: payment.order_no, payment_no: payment.payment_no },
    });

    return {
      thirdPartyId: session.id,
      checkoutUrl: session.url,
      raw: session,
    };
  }

  async refund(paymentId, amount) {
    const refund = await stripe.refunds.create({
      payment_intent: paymentId,
      amount: amount ? Math.round(amount * 100) : undefined,
    });
    return refund;
  }
}

module.exports = { StripeStrategy };

const axios = require('axios');
const { getPool, query, transaction } = require('../../shared/lib/db');
const { createLogger } = require('../../shared/lib/logger');
const { EventBus, EventTypes } = require('../../shared/lib/events');

const logger = createLogger('OrderSaga');

const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://product-service:3002';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3004';

class OrderSaga {
  constructor({ sagaId, order, items, userId }) {
    this.sagaId = sagaId;
    this.order = order;
    this.items = items;
    this.userId = userId;
    this.stepResults = [];
    this.compensations = [];
  }

  async execute() {
    logger.info(`[Saga:${this.sagaId}] Starting order saga execution`, {
      orderId: this.order.id,
      orderNo: this.order.order_no,
    });

    try {
      await this.stepDeductStock();
      await this.stepCreatePayment();
      await this.stepClearCart();

      await this.markOrderPaid();
      logger.info(`[Saga:${this.sagaId}] Saga completed successfully`);
    } catch (err) {
      logger.error(`[Saga:${this.sagaId}] Saga failed at step, starting compensation`, {
        error: err.message,
      });
      await this.compensate();
    }
  }

  async stepDeductStock() {
    logger.info(`[Saga:${this.sagaId}] Step 1: Deducting stock`);
    const results = [];

    for (const item of this.items) {
      const res = await axios.post(
        `${PRODUCT_SERVICE_URL}/products/${item.product_id}/deduct-stock`,
        { quantity: item.quantity, sagaId: this.sagaId },
        { timeout: 10000 }
      );
      results.push({ productId: item.product_id, response: res.data });
    }

    this.stepResults.push({ step: 'deduct_stock', results });
    this.compensations.unshift(async () => {
      for (const item of this.items) {
        try {
          await axios.post(
            `${PRODUCT_SERVICE_URL}/products/${item.product_id}/restore-stock`,
            { quantity: item.quantity, sagaId: this.sagaId },
            { timeout: 10000 }
          );
        } catch (err) {
          logger.error(`[Saga:${this.sagaId}] Compensate stock failed`, {
            productId: item.product_id,
            error: err.message,
          });
        }
      }
    });

    logger.info(`[Saga:${this.sagaId}] Step 1: Stock deducted`);
  }

  async stepCreatePayment() {
    logger.info(`[Saga:${this.sagaId}] Step 2: Creating payment`);

    const res = await axios.post(
      `${PAYMENT_SERVICE_URL}/payments`,
      {
        orderId: this.order.id,
        orderNo: this.order.order_no,
        userId: this.userId,
        amount: this.order.pay_amount,
        description: `Order ${this.order.order_no}`,
        sagaId: this.sagaId,
      },
      { timeout: 10000 }
    );

    this.stepResults.push({ step: 'create_payment', payment: res.data });
    this.compensations.unshift(async () => {
      try {
        await axios.delete(
          `${PAYBITMQ_URL}/payments/${res.data.id}?sagaId=${this.sagaId}`,
          { timeout: 10000 }
        );
      } catch (err) {
        logger.error(`[Saga:${this.sagaId}] Compensate payment failed`, {
          paymentId: res.data.id,
          error: err.message,
        });
      }
    });

    logger.info(`[Saga:${this.sagaId}] Step 2: Payment created`, {
      paymentId: res.data.id,
    });
  }

  async stepClearCart() {
    logger.info(`[Saga:${this.sagaId}] Step 3: Clearing cart`);

    await query(
      'DELETE FROM carts WHERE user_id = $1 AND selected = TRUE',
      [this.userId]
    );

    this.stepResults.push({ step: 'clear_cart' });
    logger.info(`[Saga:${this.sagaId}] Step 3: Cart cleared`);
  }

  async markOrderPaid() {
    logger.info(`[Saga:${this.sagaId}] Marking order as paid`);

    await query(
      `UPDATE orders SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [this.order.id]
    );

    const eventBus = await EventBus.getInstance();
    await eventBus.publish(EventTypes.ORDER_PAID, {
      orderId: this.order.id,
      orderNo: this.order.order_no,
      userId: this.userId,
      sagaId: this.sagaId,
      items: this.items,
      totalAmount: this.order.total_amount,
      payAmount: this.order.pay_amount,
    });

    logger.info(`[Saga:${this.sagaId}] Order marked as paid`);
  }

  async compensate() {
    logger.warn(`[Saga:${this.sagaId}] Starting compensation (${this.compensations.length} steps)`);

    for (const comp of this.compensations) {
      await comp();
    }

    await query(
      `UPDATE orders SET status = 'pending', updated_at = NOW() WHERE id = $1`,
      [this.order.id]
    );

    const eventBus = await EventBus.getInstance();
    await eventBus.publish(EventTypes.ORDER_CREATED, {
      orderId: this.order.id,
      orderNo: this.order.order_no,
      userId: this.userId,
      status: 'pending',
      sagaId: this.sagaId,
      message: 'Saga failed, order reverted to pending',
    });

    logger.warn(`[Saga:${this.sagaId}] Compensation completed`);
  }
}

module.exports = { OrderSaga };

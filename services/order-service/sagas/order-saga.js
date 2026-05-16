/**
 * Order Saga — 分布式事务协调器
 * 步骤：扣库存 → 创建支付 → 清购物车
 * 任一步失败 → 补偿回滚
 */
const axios = require('axios');

class OrderSaga {
  constructor({ sagaId, order, items, eventBus, pool }) {
    this.sagaId = sagaId;
    this.order = order;
    this.items = items;
    this.eventBus = eventBus;
    this.pool = pool;
    this.steps = [];
    this.compensations = [];
  }

  // ─── 执行 Saga ───
  async execute() {
    const logger = console; // 简化

    try {
      // Step 1: 扣减库存
      await this.step('deduct_inventory', async () => {
        for (const item of this.items) {
          await axios.post(`http://product-service:3002/products/${item.product_id}/deduct-stock`, {
            quantity: item.quantity,
            sku_id: item.sku_id,
            order_id: this.order.id
          });
        }
      }, async () => {
        // 补偿：恢复库存
        for (const item of this.items) {
          try {
            await axios.post(`http://product-service:3002/products/${item.product_id}/restore-stock`, {
              quantity: item.quantity
            });
          } catch (e) { /* 补偿失败记录日志 */ }
        }
      });

      // Step 2: 创建支付单
      await this.step('create_payment', async () => {
        await axios.post('http://payment-service:3004/payments', {
          order_id: this.order.id,
          order_no: this.order.order_no,
          user_id: this.order.user_id,
          amount: this.order.pay_amount,
          description: `订单 ${this.order.order_no}`
        });
      }, async () => {
        try {
          await axios.post(`http://payment-service:3004/payments/${this.order.order_no}/cancel`);
        } catch (e) {}
      });

      // Step 3: 清购物车
      await this.step('clear_cart', async () => {
        await this.pool.query('DELETE FROM carts WHERE user_id = $1 AND selected = TRUE', [this.order.user_id]);
      });

      // Saga 完成
      await this.pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [this.order.id]);
      await this.eventBus.publish('order.saga.completed', { saga_id: this.sagaId, order_id: this.order.id });
      logger.info(`[Saga] Completed: ${this.sagaId}`);

    } catch (err) {
      logger.error(`[Saga] Failed: ${this.sagaId}, executing compensation...`);
      await this.compensate();

      await this.pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [this.order.id]);
      await this.eventBus.publish('order.saga.failed', { saga_id: this.sagaId, order_id: this.order.id, error: err.message });
    }
  }

  async step(name, action, compensate) {
    this.steps.push(name);
    this.compensations.push(compensate);
    await action();
  }

  async compensate() {
    // 反向执行补偿（LIFO）
    for (let i = this.compensations.length - 1; i >= 0; i--) {
      try {
        await this.compensations[i]();
      } catch (err) {
        console.error(`[Saga] Compensation failed for step ${this.steps[i]}:`, err.message);
      }
    }
  }
}

module.exports = { OrderSaga };

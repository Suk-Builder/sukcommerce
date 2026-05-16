/**
 * 事件总线 — RabbitMQ 实现
 * 支撑 Saga 分布式事务 + 事件驱动架构
 * 所有跨服务通信走消息队列，不直接 HTTP 调用
 */
const amqp = require('amqplib');
const { createLogger } = require('./logger');

const logger = createLogger();

class EventBus {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.handlers = new Map();
    this.url = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
  }

  async connect() {
    try {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();

      // 声明交换器（Topic 模式，支持路由键匹配）
      await this.channel.assertExchange('sukcommerce.events', 'topic', { durable: true });

      // 声明死信交换器（处理失败消息）
      await this.channel.assertExchange('sukcommerce.dlx', 'topic', { durable: true });

      // 声明死信队列
      await this.channel.assertQueue('dlq.all', { durable: true });
      await this.channel.bindQueue('dlq.all', 'sukcommerce.dlx', '#');

      logger.info('EventBus connected to RabbitMQ');

      // 自动重连
      this.connection.on('close', () => {
        logger.warn('RabbitMQ connection closed, reconnecting in 5s...');
        setTimeout(() => this.connect(), 5000);
      });

    } catch (err) {
      logger.error('EventBus connection failed:', err.message);
      setTimeout(() => this.connect(), 5000);
    }
  }

  // 发布事件
  async publish(eventType, payload, routingKey = '') {
    if (!this.channel) {
      logger.warn('EventBus not connected, event dropped:', eventType);
      return;
    }

    const message = {
      event: eventType,
      payload,
      timestamp: new Date().toISOString(),
      request_id: payload.request_id || `evt_${Date.now()}`,
      service: process.env.SERVICE_NAME || 'unknown'
    };

    const key = routingKey || eventType;
    const buffer = Buffer.from(JSON.stringify(message));

    this.channel.publish('sukcommerce.events', key, buffer, {
      persistent: true,
      messageId: message.request_id,
      timestamp: Date.now()
    });

    logger.info(`Event published: ${eventType} [${key}]`);
  }

  // 订阅事件
  async subscribe(pattern, handler, queueName) {
    if (!this.channel) return;

    const q = await this.channel.assertQueue(queueName, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'sukcommerce.dlx',
        'x-dead-letter-routing-key': pattern
      }
    });

    await this.channel.bindQueue(q.queue, 'sukcommerce.events', pattern);

    this.channel.consume(q.queue, async (msg) => {
      if (!msg) return;

      try {
        const content = JSON.parse(msg.content.toString());
        logger.info(`Event received: ${content.event} [${pattern}]`);

        await handler(content.payload, content);
        this.channel.ack(msg);
      } catch (err) {
        logger.error(`Event handler failed: ${pattern}`, err);

        // 重试3次后进入死信队列
        const retryCount = (msg.properties.headers?.['x-retry'] || 0) + 1;
        if (retryCount <= 3) {
          this.channel.nack(msg, false, false);
          this.channel.publish('sukcommerce.events', pattern, msg.content, {
            headers: { 'x-retry': retryCount }
          });
        } else {
          this.channel.nack(msg, false, false); // 进入死信队列
        }
      }
    });

    logger.info(`Subscribed: ${pattern} -> ${queueName}`);
  }

  // Saga 事务协调 — 发送命令
  async sendSagaCommand(sagaId, command, payload) {
    const sagaEvent = {
      saga_id: sagaId,
      command,
      payload,
      status: 'pending',
      timestamp: new Date().toISOString()
    };

    await this.publish(`saga.${command}`, sagaEvent);
    logger.info(`Saga command sent: ${command} [${sagaId}]`);
  }

  async close() {
    await this.channel?.close();
    await this.connection?.close();
  }
}

// 事件类型常量（所有服务共享）
const EventTypes = {
  // 用户
  USER_REGISTERED: 'user.registered',
  USER_LOGIN: 'user.login',
  USER_SUSPENDED: 'user.suspended',

  // 商品
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_LOW_STOCK: 'product.low_stock',
  PRICE_CHANGED: 'product.price_changed',

  // 订单
  ORDER_CREATED: 'order.created',
  ORDER_PAID: 'order.paid',
  ORDER_SHIPPED: 'order.shipped',
  ORDER_COMPLETED: 'order.completed',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_PAYMENT_FAILED: 'order.payment_failed',

  // 支付
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  REFUND_SUCCEEDED: 'refund.succeeded',

  // 通知
  NOTIFY_EMAIL: 'notify.email',
  NOTIFY_SMS: 'notify.sms',
  NOTIFY_PUSH: 'notify.push',
  NOTIFY_WEBSOCKET: 'notify.websocket',

  // Saga 协调
  SAGA_ORDER_START: 'saga.order.start',
  SAGA_ORDER_RESERVE: 'saga.order.reserve_inventory',
  SAGA_ORDER_PAY: 'saga.order.process_payment',
  SAGA_ORDER_SHIP: 'saga.order.create_shipment',
  SAGA_ORDER_COMPENSATE: 'saga.order.compensate',
};

module.exports = { EventBus, EventTypes };

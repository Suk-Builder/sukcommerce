/**
 * 通知服务 — 事件驱动消息推送
 * 邮件 / 短信 / 站内信 / WebSocket
 */
require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const WebSocket = require('ws');

const { createLogger } = require('../../shared/lib/logger');
const { EventBus, EventTypes } = require('../../shared/lib/events');

const logger = createLogger();
const app = express();
app.use(express.json());

const eventBus = new EventBus();

// ─── SMTP ───
const mailer = nodemailer.createTransporter({
  host: process.env.SMTP_HOST,
  port: 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// ─── WebSocket 客户端管理 ───
const wss = new WebSocket.Server({ port: 3006 });
const wsClients = new Map(); // userId -> ws

wss.on('connection', (ws, req) => {
  const userId = new URL(req.url, 'http://localhost').searchParams.get('userId');
  if (userId) {
    wsClients.set(userId, ws);
    ws.on('close', () => wsClients.delete(userId));
  }
});

// ─── 消息模板 ───
const templates = {
  order_created: (data) => ({
    subject: `订单已创建 #${data.order_no}`,
    body: `您的订单 ${data.order_no} 已创建，金额 ¥${data.amount}，请尽快支付。`,
  }),
  order_paid: (data) => ({
    subject: `订单已支付 #${data.order_no}`,
    body: `您的订单 ${data.order_no} 已支付成功，我们将尽快发货。`,
  }),
  order_shipped: (data) => ({
    subject: `订单已发货 #${data.order_no}`,
    body: `您的订单 ${data.order_no} 已发货，物流单号：${data.tracking_no}。`,
  }),
  payment_failed: (data) => ({
    subject: `支付失败 #${data.order_no}`,
    body: `订单 ${data.order_no} 支付失败，请重试或更换支付方式。`,
  }),
};

// ─── 事件订阅 ───
async function start() {
  await eventBus.connect();

  // 监听所有订单事件
  await eventBus.subscribe('order.*', async (payload, meta) => {
    const event = meta.event; // order.created / order.paid 等
    const type = event.split('.')[1]; // created / paid / shipped
    const tmpl = templates[`order_${type}`];
    if (!tmpl) return;

    const { subject, body } = tmpl(payload);

    // 1. 发送邮件
    try {
      await mailer.sendMail({
        from: process.env.SMTP_USER,
        to: payload.user_email,
        subject,
        text: body,
      });
      logger.info(`Email sent to ${payload.user_email}: ${subject}`);
    } catch (err) {
      logger.error('Email send failed:', err.message);
    }

    // 2. WebSocket 推送
    const ws = wsClients.get(String(payload.user_id));
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'notification', event, data: payload }));
    }

    // 3. 发布"通知已发送"事件
    await eventBus.publish(EventTypes.NOTIFY_EMAIL, {
      user_id: payload.user_id,
      order_id: payload.order_id,
      channel: 'email',
      status: 'sent'
    });
  }, 'notification.order-events');

  logger.info('NotificationService started, listening for events');
}

app.get('/health', (req, res) => res.json({ service: 'notification-service', status: 'healthy' }));

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => {
  logger.info(`NotificationService on ${PORT}`);
  start();
});

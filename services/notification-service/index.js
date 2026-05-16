const express = require('express');
const nodemailer = require('nodemailer');
const { WebSocketServer } = require('ws');
const { createLogger } = require('../../shared/lib/logger');
const { EventBus, EventTypes } = require('../../shared/lib/events');

const logger = createLogger(process.env.SERVICE_NAME || 'notification-service');

const PORT = parseInt(process.env.PORT, 10) || 3005;
const WS_PORT = PORT + 1;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';

// ── Nodemailer Transport ──
const mailer = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

// ── WebSocket Clients Map<userId, WebSocket> ──
const wsClients = new Map();

// ── Express App ──
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    service: process.env.SERVICE_NAME || 'notification-service',
    status: 'ok',
    uptime: process.uptime(),
    wsClients: wsClients.size,
    timestamp: new Date().toISOString(),
  });
});

// ── WebSocket Server ──
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${WS_PORT}`);
  const userId = url.searchParams.get('userId');

  if (!userId) {
    logger.warn('[WS] Connection rejected: missing userId');
    ws.close(1008, 'Missing userId');
    return;
  }

  // Close previous connection for same user
  if (wsClients.has(userId)) {
    const oldWs = wsClients.get(userId);
    if (oldWs !== ws && oldWs.readyState === 1) {
      oldWs.close(1000, 'New connection');
    }
  }

  wsClients.set(userId, ws);
  logger.info(`[WS] Client connected: userId=${userId}, total=${wsClients.size}`);

  ws.on('close', () => {
    if (wsClients.get(userId) === ws) {
      wsClients.delete(userId);
    }
    logger.info(`[WS] Client disconnected: userId=${userId}, total=${wsClients.size}`);
  });

  ws.on('error', (err) => {
    logger.error(`[WS] Error for userId=${userId}:`, err.message);
    wsClients.delete(userId);
  });
});

// ── Send WebSocket Push ──
function pushWsNotification(userId, notification) {
  const ws = wsClients.get(userId);
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(notification));
      logger.info(`[WS] Push sent to userId=${userId}, type=${notification.type}`);
    } catch (err) {
      logger.error(`[WS] Push failed for userId=${userId}:`, err.message);
    }
  }
}

// ── Send Email ──
async function sendEmail(to, subject, html) {
  if (!SMTP_USER || !SMTP_PASS) {
    logger.warn('[Email] Skipped: SMTP credentials not configured');
    return;
  }
  try {
    const info = await mailer.sendMail({
      from: `"SukCommerce" <${SMTP_USER}>`,
      to,
      subject,
      html,
    });
    logger.info(`[Email] Sent to ${to}: ${subject}, messageId=${info.messageId}`);
  } catch (err) {
    logger.error(`[Email] Failed to send to ${to}:`, err.message);
  }
}

// ── Email Templates ──
function buildEmailTemplate(type, data) {
  const orderId = data.orderId || data.orderNumber || data.id || 'N/A';
  const amount = data.amount || data.total || data.price || 0;
  const status = data.status || 'N/A';
  const userName = data.userName || data.username || data.name || '用户';
  const email = data.email || data.userEmail;
  const currency = data.currency || '¥';

  const templates = {
    'order.created': {
      subject: `【SukCommerce】订单已创建 - #${orderId}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#333;">订单已创建</h2>
          <p>尊敬的 ${userName}，您好！</p>
          <p>您的订单已成功创建，详情如下：</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">订单号</td><td style="padding:8px;border:1px solid #ddd;">${orderId}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">订单金额</td><td style="padding:8px;border:1px solid #ddd;">${currency}${amount}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">订单状态</td><td style="padding:8px;border:1px solid #ddd;">${status}</td></tr>
          </table>
          <p><a href="#" style="color:#1890ff;">查看订单详情 &rarr;</a></p>
        </div>`,
    },
    'order.paid': {
      subject: `【SukCommerce】订单已支付 - #${orderId}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#52c41a;">订单已支付</h2>
          <p>尊敬的 ${userName}，您好！</p>
          <p>您的订单已成功支付，我们将尽快为您安排发货。</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">订单号</td><td style="padding:8px;border:1px solid #ddd;">${orderId}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">支付金额</td><td style="padding:8px;border:1px solid #ddd;">${currency}${amount}</td></tr>
          </table>
          <p><a href="#" style="color:#1890ff;">查看订单详情 &rarr;</a></p>
        </div>`,
    },
    'order.shipped': {
      subject: `【SukCommerce】订单已发货 - #${orderId}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#1890ff;">订单已发货</h2>
          <p>尊敬的 ${userName}，您好！</p>
          <p>您的订单已发货，请注意查收。</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">订单号</td><td style="padding:8px;border:1px solid #ddd;">${orderId}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">物流单号</td><td style="padding:8px;border:1px solid #ddd;">${data.trackingNumber || '暂无'}</td></tr>
          </table>
          <p><a href="#" style="color:#1890ff;">查看物流详情 &rarr;</a></p>
        </div>`,
    },
    'order.completed': {
      subject: `【SukCommerce】订单已完成 - #${orderId}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#52c41a;">订单已完成</h2>
          <p>尊敬的 ${userName}，您好！</p>
          <p>您的订单已完成，感谢您的购买！</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">订单号</td><td style="padding:8px;border:1px solid #ddd;">${orderId}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">订单金额</td><td style="padding:8px;border:1px solid #ddd;">${currency}${amount}</td></tr>
          </table>
          <p><a href="#" style="color:#1890ff;">去评价 &rarr;</a></p>
        </div>`,
    },
    'order.cancelled': {
      subject: `【SukCommerce】订单已取消 - #${orderId}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#f5222d;">订单已取消</h2>
          <p>尊敬的 ${userName}，您好！</p>
          <p>您的订单已取消。</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">订单号</td><td style="padding:8px;border:1px solid #ddd;">${orderId}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">取消原因</td><td style="padding:8px;border:1px solid #ddd;">${data.reason || '用户取消'}</td></tr>
          </table>
          <p><a href="#" style="color:#1890ff;">重新下单 &rarr;</a></p>
        </div>`,
    },
    'payment.failed': {
      subject: `【SukCommerce】支付失败 - #${orderId}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#f5222d;">支付失败</h2>
          <p>尊敬的 ${userName}，您好！</p>
          <p>很抱歉，您的订单支付失败，请重试。</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">订单号</td><td style="padding:8px;border:1px solid #ddd;">${orderId}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">支付金额</td><td style="padding:8px;border:1px solid #ddd;">${currency}${amount}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f5f5f5;">失败原因</td><td style="padding:8px;border:1px solid #ddd;">${data.errorMessage || '未知错误'}</td></tr>
          </table>
          <p><a href="#" style="color:#1890ff;">重新支付 &rarr;</a></p>
        </div>`,
    },
    'user.registered': {
      subject: '【SukCommerce】欢迎注册！',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#1890ff;">欢迎加入 SukCommerce！</h2>
          <p>尊敬的 ${userName}，您好！</p>
          <p>恭喜您成功注册 SukCommerce 账户，开启您的购物之旅！</p>
          <p><a href="#" style="display:inline-block;padding:10px 24px;background:#1890ff;color:#fff;text-decoration:none;border-radius:4px;">开始购物</a></p>
        </div>`,
    },
  };

  return templates[type] || { subject: `【SukCommerce】通知`, html: `<p>您有一条新通知。</p>` };
}

// ── Event Handlers ──
const eventHandlers = {
  'order.created': async (data) => {
    const tmpl = buildEmailTemplate('order.created', data);
    if (data.email) await sendEmail(data.email, tmpl.subject, tmpl.html);
    pushWsNotification(data.userId, { type: 'order.created', title: '订单已创建', data });
  },
  'order.paid': async (data) => {
    const tmpl = buildEmailTemplate('order.paid', data);
    if (data.email) await sendEmail(data.email, tmpl.subject, tmpl.html);
    pushWsNotification(data.userId, { type: 'order.paid', title: '订单已支付', data });
  },
  'order.shipped': async (data) => {
    const tmpl = buildEmailTemplate('order.shipped', data);
    if (data.email) await sendEmail(data.email, tmpl.subject, tmpl.html);
    pushWsNotification(data.userId, { type: 'order.shipped', title: '订单已发货', data });
  },
  'order.completed': async (data) => {
    const tmpl = buildEmailTemplate('order.completed', data);
    if (data.email) await sendEmail(data.email, tmpl.subject, tmpl.html);
    pushWsNotification(data.userId, { type: 'order.completed', title: '订单已完成', data });
  },
  'order.cancelled': async (data) => {
    const tmpl = buildEmailTemplate('order.cancelled', data);
    if (data.email) await sendEmail(data.email, tmpl.subject, tmpl.html);
    pushWsNotification(data.userId, { type: 'order.cancelled', title: '订单已取消', data });
  },
  'payment.failed': async (data) => {
    const tmpl = buildEmailTemplate('payment.failed', data);
    if (data.email) await sendEmail(data.email, tmpl.subject, tmpl.html);
    pushWsNotification(data.userId, { type: 'payment.failed', title: '支付失败', data });
  },
  'user.registered': async (data) => {
    const tmpl = buildEmailTemplate('user.registered', data);
    if (data.email) await sendEmail(data.email, tmpl.subject, tmpl.html);
    pushWsNotification(data.userId, { type: 'user.registered', title: '欢迎注册', data });
  },
};

// ── Subscribe Events ──
async function subscribeEvents(eventBus) {
  for (const [eventType, handler] of Object.entries(eventHandlers)) {
    await eventBus.subscribe(eventType, async (payload) => {
      logger.info(`[Event] Received ${eventType}:`, JSON.stringify(payload));
      try {
        await handler(payload);
      } catch (err) {
        logger.error(`[Event] Handler error for ${eventType}:`, err.message);
      }
    });
    logger.info(`[Event] Subscribed: ${eventType}`);
  }
}

// ── Start ──
async function start() {
  logger.info('Starting notification-service...');

  // Connect to EventBus (RabbitMQ)
  const eventBus = new EventBus(RABBITMQ_URL);
  await eventBus.connect();
  logger.info(`[EventBus] Connected to ${RABBITMQ_URL}`);

  // Subscribe all events
  await subscribeEvents(eventBus);

  // Start HTTP Server
  app.listen(PORT, () => {
    logger.info(`HTTP Server running on port ${PORT}`);
  });

  // WebSocket Server already started (wss listens on WS_PORT)
  logger.info(`WebSocket Server running on port ${WS_PORT}`);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down notification-service...');
    wss.clients.forEach((ws) => ws.close());
    wss.close();
    await eventBus.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down notification-service...');
    wss.clients.forEach((ws) => ws.close());
    wss.close();
    await eventBus.close();
    process.exit(0);
  });
}

start().catch((err) => {
  logger.error('Failed to start notification-service:', err);
  process.exit(1);
});

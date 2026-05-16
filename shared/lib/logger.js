/**
 * 统一日志系统 — Winston + ELK 结构化日志
 * 包含链路追踪 request_id、服务名、日志级别
 */
const winston = require('winston');

const { combine, timestamp, json, errors } = winston.format;

// 日志级别对应颜色（控制台输出用）
const colors = {
  error: '\x1b[31m',   // 红
  warn: '\x1b[33m',    // 黄
  info: '\x1b[36m',    // 青
  debug: '\x1b[90m',   // 灰
};

const service = process.env.SERVICE_NAME || 'unknown';
const instance = process.env.HOSTNAME || `pid-${process.pid}`;

// 创建 Logger 工厂
function createLogger(opts = {}) {
  const level = process.env.LOG_LEVEL || 'info';
  const isDev = process.env.NODE_ENV !== 'production';

  const transports = [
    // 控制台输出（开发环境彩色）
    new winston.transports.Console({
      format: isDev
        ? winston.format.combine(
            winston.format.printf(({ level, message, timestamp, request_id, ...meta }) => {
              const color = colors[level] || '';
              const reset = '\x1b[0m';
              const req = request_id ? `[${request_id}]` : '';
              return `${color}[${timestamp}] [${service}]${req} ${level}: ${message}${reset} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
            })
          )
        : winston.format.combine(timestamp(), json())
    }),
  ];

  // 生产环境添加文件输出
  if (!isDev) {
    transports.push(
      new winston.transports.File({ filename: '/var/log/app/error.log', level: 'error' }),
      new winston.transports.File({ filename: '/var/log/app/combined.log' })
    );
  }

  return winston.createLogger({
    level,
    defaultMeta: { service, instance, environment: process.env.NODE_ENV },
    format: combine(timestamp(), errors({ stack: true }), json()),
    transports,
    ...opts
  });
}

// 添加链路追踪中间件
function requestIdMiddleware(req, res, next) {
  req.request_id = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  res.setHeader('X-Request-ID', req.request_id);
  next();
}

module.exports = { createLogger, requestIdMiddleware };

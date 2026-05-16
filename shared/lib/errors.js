/**
 * 错误体系设计
 * 业务错误码 + HTTP状态码 + 多语言消息
 * 支持错误聚合（一次返回多个字段错误）
 */

class AppError extends Error {
  constructor(code, message, statusCode = 500, details = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        status: this.statusCode,
        details: this.details,
        timestamp: this.timestamp,
        trace: process.env.NODE_ENV !== 'production' ? this.stack : undefined
      }
    };
  }
}

// 预定义业务错误（覆盖电商全部场景）
const Errors = {
  // 系统级 1xxx
  INTERNAL_ERROR: (msg) => new AppError('E1000', msg || '服务器内部错误', 500),
  SERVICE_UNAVAILABLE: (service) => new AppError('E1001', `服务 ${service} 暂时不可用`, 503),
  TIMEOUT: () => new AppError('E1002', '请求超时', 504),
  RATE_LIMITED: () => new AppError('E1003', '请求过于频繁，请稍后再试', 429),
  CIRCUIT_OPEN: () => new AppError('E1004', '服务熔断中，请稍后重试', 503),

  // 认证 2xxx
  UNAUTHORIZED: () => new AppError('E2000', '未授权，请先登录', 401),
  FORBIDDEN: () => new AppError('E2001', '权限不足', 403),
  TOKEN_EXPIRED: () => new AppError('E2002', '登录已过期，请重新登录', 401),
  INVALID_CREDENTIALS: () => new AppError('E2003', '用户名或密码错误', 401),

  // 用户 3xxx
  USER_NOT_FOUND: () => new AppError('E3000', '用户不存在', 404),
  USER_EXISTS: (field) => new AppError('E3001', `${field} 已被注册`, 409),
  USER_SUSPENDED: () => new AppError('E3002', '账户已被停用', 403),

  // 商品 4xxx
  PRODUCT_NOT_FOUND: () => new AppError('E4000', '商品不存在', 404),
  PRODUCT_OUT_OF_STOCK: () => new AppError('E4001', '商品库存不足', 400),
  PRODUCT_PRICE_CHANGED: () => new AppError('E4002', '商品价格已变更，请刷新', 409),
  CATEGORY_NOT_FOUND: () => new AppError('E4003', '分类不存在', 404),

  // 订单 5xxx
  ORDER_NOT_FOUND: () => new AppError('E5000', '订单不存在', 404),
  ORDER_CANNOT_CANCEL: () => new AppError('E5001', '当前状态不可取消', 400),
  ORDER_PAYMENT_FAILED: () => new AppError('E5002', '订单支付失败', 400),
  CART_EMPTY: () => new AppError('E5003', '购物车为空', 400),
  INVENTORY_SHORTAGE: (sku) => new AppError('E5004', `商品 ${sku} 库存不足`, 400),

  // 支付 6xxx
  PAYMENT_FAILED: () => new AppError('E6000', '支付失败', 400),
  PAYMENT_TIMEOUT: () => new AppError('E6001', '支付超时', 408),
  PAYMENT_ALREADY_PAID: () => new AppError('E6002', '订单已支付', 409),
  REFUND_FAILED: () => new AppError('E6003', '退款失败', 400),
  INVALID_PAYMENT_METHOD: () => new AppError('E6004', '不支持的支付方式', 400),

  // 文件/上传 7xxx
  FILE_TOO_LARGE: (max) => new AppError('E7000', `文件超过 ${max}MB 限制`, 413),
  INVALID_FILE_TYPE: () => new AppError('E7001', '不支持的文件类型', 415),
  UPLOAD_FAILED: () => new AppError('E7002', '上传失败', 500),

  // 验证 8xxx
  VALIDATION_ERROR: (fields) => new AppError('E8000', '参数验证失败', 400, { fields }),
  MISSING_FIELD: (field) => new AppError('E8001', `缺少必填字段: ${field}`, 400),
};

// 全局错误处理中间件
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(err.toJSON());
  }

  // 数据库唯一约束
  if (err.code === '23505') {
    return res.status(409).json({
      error: { code: 'E3001', message: '数据已存在', status: 409 }
    });
  }

  // 数据库外键约束
  if (err.code === '23503') {
    return res.status(400).json({
      error: { code: 'E8000', message: '关联数据不存在', status: 400 }
    });
  }

  // 未知错误
  console.error('[Unhandled Error]', err);
  res.status(500).json({
    error: { code: 'E1000', message: '服务器内部错误', status: 500 }
  });
}

module.exports = { AppError, Errors, errorHandler };

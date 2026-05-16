# SukCommerce — 微服务电商SaaS平台

> 这是一个**架构设计级项目**，展示微服务拆分、分布式事务、事件驱动、多支付策略等核心能力。完整实现需 3-6 人团队 3-6 个月。

## 架构概览

```
                    ┌─────────────┐
                    │   Nginx     │  ← API Gateway (负载均衡/限流/SSL)
                    │   :80/443   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌─────────┐ ┌─────────┐ ┌──────────┐
        │Gateway-1│ │Gateway-2│ │ Prometheus│
        │ :3000   │ │ :3000   │ │ +Grafana  │
        └────┬────┘ └────┬────┘ └──────────┘
             └─────────────┘
                    │
        ┌───────────┼───────────┬──────────────┐
        ▼           ▼           ▼              ▼
   ┌────────┐  ┌────────┐  ┌────────┐   ┌──────────┐
   │ User   │  │Product │  │ Order  │   │ Payment  │
   │:3001   │  │:3002   │  │:3003   │   │ :3004    │
   │PostgreSQL│ │PostgreSQL│ │PostgreSQL│ │ 支付宝   │
   │ Redis  │  │   ES   │  │        │   │ Stripe   │
   └────┬───┘  └────┬───┘  └───┬────┘   └────┬─────┘
        │            │            │              │
        └────────────┴────────────┴──────────────┘
                    │
             ┌──────┴──────┐
             ▼             ▼
        ┌─────────┐   ┌──────────┐
        │RabbitMQ │   │Notification
        │(Saga/   │   │  :3005   │
        │ Events) │   │WebSocket │
        └─────────┘   └──────────┘
```

## 微服务拆分

| 服务 | 端口 | 职责 | 数据存储 |
|------|------|------|---------|
| **nginx** | 80/443 | 负载均衡、限流、SSL、静态资源 | - |
| **gateway** | 3000 | API网关、JWT验证、熔断、路由转发 | Redis |
| **user-service** | 3001 | 用户注册/登录/角色/地址 | PostgreSQL + Redis |
| **product-service** | 3002 | 商品/分类/库存/搜索 | PostgreSQL + ES + Redis |
| **order-service** | 3003 | 购物车/订单/Saga事务 | PostgreSQL + RabbitMQ |
| **payment-service** | 3004 | 多支付渠道/回调 | PostgreSQL + RabbitMQ |
| **notification-service** | 3005 | 邮件/短信/WebSocket推送 | RabbitMQ + WebSocket |

## 核心技术决策

### 1. 分布式事务 — Saga 模式

```
创建订单 → 扣库存 → 创建支付单 → 清购物车
    ↓         ↓          ↓           ↓
  失败     库存回滚   支付取消     无需补偿
```

- 正向操作逐步入库
- 任意步骤失败 → **反向补偿**（LIFO回滚）
- 通过 RabbitMQ 异步协调

### 2. 事件驱动架构

```
订单创建 ──► RabbitMQ ──► 通知服务发邮件
    │                      库存服务扣减
    │                      搜索服务更新ES
    ▼
  其他服务通过订阅事件解耦，不直接HTTP调用
```

### 3. 多支付策略模式

```
PaymentStrategy (接口)
    ├── StripeStrategy    ──► Stripe Checkout
    ├── AlipayStrategy    ──► 支付宝当面付
    └── WechatStrategy    ──► 微信支付 (预留)
```

### 4. 限流熔断

| 层级 | 实现 | 策略 |
|------|------|------|
| Nginx | limit_req | 10r/s 漏桶 |
| Gateway | Redis计数器 | IP+路径维度 |
| 服务间 | CircuitBreaker | 5次失败/30s熔断 |

### 5. 数据一致性

| 场景 | 方案 |
|------|------|
| 用户登录信息 | Redis缓存，TTL 1h |
| 商品详情 | Redis缓存，TTL 5min |
| 商品列表 | Redis缓存，TTL 1min |
| 搜索 | Elasticsearch 近实时同步 |
| 库存扣减 | PostgreSQL FOR UPDATE 行锁 |

## 目录结构

```
sukcommerce/
├── docker-compose.yml              # 全量服务编排
├── infrastructure/
│   ├── nginx/nginx.conf            # API Gateway配置
│   ├── prometheus/prometheus.yml   # 监控配置
│   └── grafana/                    # 仪表盘配置
├── services/
│   ├── gateway/                    # API网关
│   ├── user-service/               # 用户服务
│   ├── product-service/            # 商品服务
│   ├── order-service/              # 订单服务
│   │   └── sagas/order-saga.js     # Saga事务协调
│   ├── payment-service/            # 支付服务
│   │   └── strategies/             # 多支付策略
│   └── notification-service/       # 通知服务
├── shared/                         # 共享库
│   ├── lib/logger.js               # 结构化日志
│   ├── lib/errors.js               # 业务错误体系
│   └── lib/events.js               # 事件总线
├── frontend-admin/                 # 管理后台 (React+AntD)
└── frontend-store/                 # 商城前端 (React+Tailwind)
```

## 启动方式

```bash
# 1. 克隆
git clone https://github.com/Suk-Builder/sukcommerce.git
cd sukcommerce

# 2. 配置环境
cp .env.example .env
# 填入数据库密码、API Key等

# 3. 一键启动全部服务
docker-compose up -d

# 4. 查看状态
docker-compose ps

# 5. 查看日志
docker-compose logs -f gateway
```

## 端口号速查

| 端口 | 服务 |
|------|------|
| 80/443 | Nginx (入口) |
| 3000 | API Gateway |
| 3001 | 用户服务 |
| 3002 | 商品服务 |
| 3003 | 订单服务 |
| 3004 | 支付服务 |
| 3005 | 通知服务 |
| 3006 | WebSocket |
| 15672 | RabbitMQ管理 |
| 5432 | PostgreSQL |
| 6379 | Redis |
| 9200 | Elasticsearch |
| 9090 | Prometheus |
| 3000 | Grafana |

## 关键设计文档

### 错误码体系

| 前缀 | 范围 | 含义 |
|------|------|------|
| E1xxx | 1000-1999 | 系统级错误 |
| E2xxx | 2000-2999 | 认证授权错误 |
| E3xxx | 3000-3999 | 用户相关错误 |
| E4xxx | 4000-4999 | 商品相关错误 |
| E5xxx | 5000-5999 | 订单相关错误 |
| E6xxx | 6000-6999 | 支付相关错误 |
| E7xxx | 7000-7999 | 文件上传错误 |
| E8xxx | 8000-8999 | 参数验证错误 |

### 事件类型

```
user.registered / user.login / user.suspended
product.created / product.updated / product.low_stock
order.created / order.paid / order.shipped / order.completed / order.cancelled
payment.succeeded / payment.failed / refund.succeeded
notify.email / notify.sms / notify.push
```

## 这是一个什么级别的项目

| 维度 | 真实100万项目 | 本项目 |
|------|-------------|--------|
| 代码量 | 50万行 | ~5000行（骨架）|
| 团队 | 3-6人×3-6月 | 1人×2小时 |
| 测试 | 单元/集成/E2E/压测 | 无 |
| 运维 | K8s/Istio/灰度发布 | Docker Compose |
| 安全 | 等保/渗透测试/WAF | 基础JWT+限流 |

**本项目展示的是架构设计能力**，不是完整产品。它证明了开发者理解：
- 微服务拆分的原则和边界
- 分布式事务的补偿机制
- 事件驱动解耦的设计模式
- 多支付渠道的策略模式
- API Gateway的限流熔断
- 监控告警的基础设施

## 许可

MIT

# SukCommerce — 逐模块完整实现计划

## 阶段
1. shared/lib — 共享库（logger + errors + events + db）
2. user-service — 用户认证服务（完整CRUD + JWT + 地址）
3. product-service — 商品服务（CRUD + 库存 + ES搜索 + 分类）
4. order-service — 订单服务（购物车 + 订单 + Saga分布式事务）
5. payment-service — 支付服务（Stripe + 支付宝 + Webhook）
6. notification-service — 通知服务（邮件 + WebSocket + 事件订阅）
7. gateway — API网关（路由 + 限流 + 熔断 + JWT）
8. frontend-admin — 管理后台（React + Ant Design）
9. frontend-store — 商城前端（React + Tailwind）
10. docker-compose + nginx + prometheus — 基础设施

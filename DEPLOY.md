# SukCommerce 部署指南

## 部署方式选择

| 方式 | 内存需求 | 适用场景 | 文件 |
|------|---------|---------|------|
| **精简版** | 2-4G | 开发/测试/小流量 | `docker-compose.light.yml` |
| **全量版** | 8G+ | 生产环境 | `docker-compose.yml` |

## 精简版 vs 全量版 差异

| 组件 | 精简版 | 全量版 |
|------|--------|--------|
| PostgreSQL | 1个实例（共用） | 3个实例（按服务分库） |
| Elasticsearch | 禁用（使用SQL搜索） | 独立实例 |
| Nginx | 手动配置 | Docker容器 |
| Prometheus/Grafana | 无 | 有 |
| RabbitMQ | 无管理界面 | 带管理界面(15672) |

## 一键部署（精简版）

```bash
# 1. 进入项目目录
cd /www/wwwroot/sukcommerce

# 2. 创建环境变量文件
cat > .env << 'EOF'
DB_PASSWORD=YourSecurePassword
JWT_SECRET=YourLongRandomSecretKey
RABBITMQ_PASSWORD=YourRabbitMQPassword
EOF

# 3. 初始化数据库表
docker-compose -f docker-compose.light.yml run --rm user-service node -e "
require('./shared/lib/db').getPool().query(\`
  CREATE TABLE IF NOT EXISTS users (...);
  CREATE TABLE IF NOT EXISTS addresses (...);
  -- 其他表 ...
\`).then(() => process.exit(0));
"

# 4. 启动全部服务
docker-compose -f docker-compose.light.yml up -d

# 5. 查看状态
docker-compose -f docker-compose.light.yml ps

# 6. 查看日志
docker-compose -f docker-compose.light.yml logs -f gateway
```

## 与现有项目共存（Nginx配置）

在 `/etc/nginx/sites-available/sukaczev.top` 中添加：

```nginx
# SukCommerce API
location /api/ {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

# SukCommerce 管理后台
location /admin/ {
    alias /www/wwwroot/sukcommerce/frontend-admin/dist/;
    try_files $uri $uri/ /admin/index.html;
}

# SukCommerce 商城
location /shop/ {
    alias /www/wwwroot/sukcommerce/frontend-store/dist/;
    try_files $uri $uri/ /shop/index.html;
}
```

然后：
```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 常用命令

```bash
# 查看所有服务状态
docker-compose -f docker-compose.light.yml ps

# 查看某服务日志
docker-compose -f docker-compose.light.yml logs -f user-service

# 重启某服务
docker-compose -f docker-compose.light.yml restart gateway

# 停止全部
docker-compose -f docker-compose.light.yml down

# 重建并启动
docker-compose -f docker-compose.light.yml up -d --build

# 进入容器调试
docker-compose -f docker-compose.light.yml exec postgres psql -U postgres

# 查看资源使用
docker stats --no-stream
```

## 内存监控

```bash
# 如果内存不足，查看哪个容器占用最多
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}"

# 如果 OOM，增加交换分区
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

## 生产环境 checklist

- [ ] 修改所有默认密码
- [ ] 配置 SSL 证书
- [ ] 配置 Stripe/支付宝 API Key
- [ ] 配置 SMTP 邮件服务器
- [ ] 启用防火墙（只开放 80/443）
- [ ] 配置日志轮转
- [ ] 配置自动备份（数据库）
- [ ] 配置监控告警

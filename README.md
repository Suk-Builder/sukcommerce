# SukCommerce

> A microservices-based e-commerce SaaS platform with multi-tenant architecture. Frontend separates admin dashboard and customer store; backend uses service-oriented design with shared infrastructure.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue)](https://docker.com/)

## Overview

**SukCommerce** is a full-featured e-commerce platform demonstrating enterprise-grade architecture patterns: microservices decomposition, multi-frontend strategy, CI/CD pipelines, and containerized deployment.

## Architecture

```
┌─────────────────┐  ┌─────────────────┐
│  Admin Frontend │  │  Store Frontend │
│  (React)        │  │  (React)        │
└────────┬────────┘  └────────┬────────┘
         │                    │
         └────────┬───────────┘
                  │
         ┌────────▼────────┐
         │  API Gateway    │
         └────────┬────────┘
                  │
    ┌─────────────┼─────────────┐
    ▼             ▼             ▼
┌────────┐  ┌──────────┐  ┌──────────┐
│Product │  │  Order   │  │  User    │
│Service │  │ Service  │  │ Service  │
└────────┘  └──────────┘  └──────────┘
    │             │             │
    └─────────────┼─────────────┘
                  │
         ┌────────▼────────┐
         │  Shared Layer   │
         │  (DB, Cache,    │
         │   Message Q)    │
         └─────────────────┘
```

## Services

| Service | Tech | Port | Description |
|---------|------|------|-------------|
| **frontend-admin** | React 19, Vite, Tailwind | 5173 | Admin dashboard for merchants |
| **frontend-store** | React 19, Vite, Tailwind | 5174 | Customer-facing store |
| **product-service** | Node.js, Express | 3001 | Product catalog, inventory |
| **order-service** | Node.js, Express | 3002 | Order processing, payments |
| **user-service** | Node.js, Express | 3003 | Auth, profiles, roles |
| **shared** | — | — | DB schemas, utilities, middleware |

## Features

- **Multi-tenant SaaS**: Single deployment serving multiple merchants
- **Admin dashboard**: Product management, order tracking, analytics
- **Customer store**: Browse, cart, checkout, order history
- **Service independence**: Each service deployable and scalable separately
- **Docker deployment**: Full containerization with docker-compose
- **CI/CD**: GitHub Actions workflows for automated testing and deployment

## Quick Start

```bash
git clone https://github.com/Suk-Builder/sukcommerce.git
cd sukcommerce

# Full stack with Docker
docker-compose up -d

# Or lightweight mode (fewer services)
docker-compose -f docker-compose.light.yml up -d
```

## Development

```bash
# Install shared dependencies
cd shared && npm install

# Start individual services
cd services/product-service && npm install && npm start
cd services/order-service && npm install && npm start
cd services/user-service && npm install && npm start

# Start frontends
cd frontend-admin && npm install && npm run dev
cd frontend-store && npm install && npm run dev
```

## Deployment

See [DEPLOY.md](DEPLOY.md) for detailed deployment instructions including:
- Production docker-compose configuration
- Environment variable setup
- SSL/TLS configuration
- Database migration procedures

## Tech Highlights

| Pattern | Implementation |
|---------|---------------|
| Microservices | Independent Node.js services with API Gateway |
| Multi-frontend | Separate React apps for admin and store |
| Database | Per-service SQLite/PostgreSQL |
| CI/CD | GitHub Actions with automated testing |
| Deployment | Docker Compose with health checks |

## About

Built by [Ying Momo](https://github.com/Suk-Builder) — targeting SaaS product development roles in Germany's startup ecosystem.

## License

MIT

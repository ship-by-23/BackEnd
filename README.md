# SimpanDulu Backend

REST API for the SimpanDulu read-it-later application.

## Requirements

- Node.js 24
- Docker with Docker Compose

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

Start PostgreSQL separately with:

```bash
docker compose up postgres -d
```

The API listens on `http://localhost:3000`. Health endpoints are available at
`/health/live` and `/health/ready`.

## Docker

```bash
docker compose up --build
```

## Validation

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Database tables and migrations are introduced in the next milestone.

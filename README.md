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

## Database

Apply migrations with:

```bash
npm run db:migrate
```

Run database integration tests against the isolated test service:

```bash
docker compose --profile test up postgres-test --detach --wait
TEST_DATABASE_URL=postgresql://simpandulu:simpandulu@localhost:5433/simpandulu_test npm run test:integration
docker compose --profile test down
```

The optional development administrator seed requires `SEED_ADMIN_EMAIL` and an
already-hashed bcrypt value in `SEED_ADMIN_PASSWORD_HASH`. It refuses to run when
`NODE_ENV=production`.

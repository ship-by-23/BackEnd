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

Authentication endpoints are available under `/api/v1`:

- `POST /auth/register`, `/auth/login`, `/auth/refresh`, and `/auth/logout`
- `GET /me` and `PATCH /me`
- `PUT /me/password`

Access tokens are returned in JSON and sent as `Authorization: Bearer <token>`.
Refresh tokens are rotating HTTP-only cookies and are never returned in JSON.

Article ingestion endpoints are also under `/api/v1`:

- `POST /articles` queues a URL and returns `202 Accepted`.
- `GET /articles/:articleId` returns owned article content and extraction state.
- `POST /articles/:articleId/retry` requeues a failed extraction.

The in-process worker claims durable PostgreSQL jobs, validates and pins every
network destination, follows only validated redirects, extracts readable content,
and sanitizes HTML before storage. Failed submissions remain visible with a stable
error code.

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

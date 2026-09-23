# Backend delivery and operations

The root `compose.yml` is a local development stack with fixed local database
credentials. Use a managed PostgreSQL database and externally supplied secrets
for any deployed environment. The API requires Node.js 24 and PostgreSQL 17.

## Render staging

`render.yaml` defines a separate staging API and PostgreSQL database in
Singapore. The API image is built from the repository `Dockerfile`. Render runs
`node dist/db/migrate.js` when its free-tier instance starts, before starting
the API, and checks `/health/ready` before serving requests. The database
connection and access-token secret are provided by Render; neither is stored
in Git.

The initial `CORS_ORIGIN` is `http://localhost:5173`. Set it to the frontend's
exact HTTPS origin when that site exists. The refresh cookie uses
`SameSite=Lax`, so a frontend on another site cannot use the refresh flow by
calling the API directly. Host the frontend on the same site as the API, or
proxy API requests through the frontend's origin. Do not weaken the cookie
policy just to make unrelated staging domains work.

Render's free PostgreSQL database expires after 30 days and has no managed
backups. Treat this staging data as disposable; upgrade or export it before
expiry if it needs to be retained. Free web services can also sleep when idle,
so the first request after inactivity may be slower.

## Configuration

Use [`.env.production.example`](../.env.production.example) as a list of required
and optional settings, not as a deployable secret file. Supply `DATABASE_URL`
and a unique, randomly generated `ACCESS_TOKEN_SECRET` through the deployment
secret store. `CORS_ORIGIN` must be the actual HTTPS frontend origin. Terminate
TLS at a trusted reverse proxy and restrict direct access to the API and
database. The API fetches public article URLs, so its network policy must allow
public HTTP(S) egress while keeping database and internal network addresses
unreachable.

The refresh token is an HTTP-only, `SameSite=Lax` cookie with the `Secure`
attribute in production. The access token remains in the JSON response and
must be sent as a bearer token. Browser code and bookmarklets must never embed
a long-lived credential. Configure the proxy and frontend to use the same
trusted HTTPS site for the refresh-cookie flow.

The API logs a request ID, HTTP method, path without its query string, status,
and elapsed time. It does not log request bodies, authorization headers,
cookies, article text, or submitted article URLs. Worker logs use article IDs
and safe extraction codes.

## Deploy and migrate

1. Build the image from the repository's `Dockerfile`. The runtime process uses
   the unprivileged `simpandulu` user and exposes port 3000.
2. Back up the target database before applying a new migration.
3. Run `node dist/db/migrate.js` once against the target database using its
   deployment `DATABASE_URL`.
4. Start the API with the production environment settings. `/health/live`
   checks the process; `/health/ready` checks database connectivity. Route
   traffic only after readiness succeeds.
5. On shutdown, send `SIGTERM`. The API stops accepting connections and job
   claims, waits for active requests and extraction work, then closes the
   PostgreSQL pool. Unfinished jobs remain durable and stale claims are
   reclaimed after restart.

Run the repository checks before releasing:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --audit-level=moderate
```

Database integration tests require the isolated `TEST_DATABASE_URL` documented
in the README. CI starts a fresh PostgreSQL service, applies migrations, and
runs the checks. Scan the built container image with the organization's
approved image scanner before deployment; the scanner result is specific to the
built image and base image at release time.

## Backup and rollback

Take a PostgreSQL custom-format backup before a migration. Store it encrypted
with access limited to operators, and verify a restore in an isolated database.
For example, with `DATABASE_URL` pointing to the exact intended database:

```bash
pg_dump --format=custom --file=simpandulu-before-migration.dump "$DATABASE_URL"
```

Migrations are forward-only and are not automatically reversed. To roll back
application code, first check that the previous build can read the new schema.
If the migration is incompatible, stop writers, restore the verified backup to
a newly provisioned database, then point the previous build at that restored
database. A restore replaces database state after the backup; account for any
accepted writes since the backup before switching traffic. Never test a restore
against the live database.

## Deterministic demo content

On an isolated development database, set `NODE_ENV=development`,
`DATABASE_URL`, and `DEMO_USER_PASSWORD` through local environment settings,
then run `npm run db:migrate` and `npm run db:seed:demo`. The seed refuses to run
in production. It creates `demo@example.test` and two completed articles with
fixed IDs, URLs, text, and search vectors. The article content is stored
directly, so the demo does not depend on third-party websites. Re-running the
seed leaves existing demo records intact.

Use the normal registration and article submission flow for a full extraction
check. The database-backed integration suite supplies a controlled HTTP fixture
and covers register, submit, extraction, search, progress, highlight, favorite,
archive, and logout without contacting a live site.

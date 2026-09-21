# SimpanDulu Backend Implementation Plan

## Goal

Build the smallest production-shaped backend that satisfies the SimpanDulu MVP: private authentication, secure article extraction, library management, reading progress, tags, highlights, PostgreSQL full-text search, and a blocked-domain administration surface.

The backend is complete when it can be started from a clean checkout with Docker Compose and the end-to-end save, extract, search, read, and highlight flow passes automated integration tests.

## Fixed Technical Direction

- Node.js active LTS and TypeScript in strict mode
- Express REST API under `/api/v1`
- PostgreSQL and Drizzle ORM
- Zod at environment and HTTP request boundaries
- Mozilla Readability with JSDOM for readable-content extraction
- HTML sanitization using an explicit allowlist
- bcrypt for password hashing
- JWT access tokens and rotating refresh sessions
- Vitest and Supertest for service and API integration tests
- Docker Compose for the API and PostgreSQL

Cheerio is not installed initially. Add it only if direct DOM queries cannot reliably extract required metadata. Redis, Elasticsearch, WebSockets, dependency-injection frameworks, and microservices are outside the MVP.

## Architecture Decisions

### API Structure

Organize by product capability instead of technical layer:

```text
src/
  app.ts
  server.ts
  config/
  db/
  lib/
  middleware/
  modules/
    auth/
    users/
    articles/
    extraction/
    tags/
    highlights/
    admin/
  test/
```

Each module owns its route, schema, service, repository queries, and focused tests. Shared code belongs in `lib` only after two modules genuinely need it.

### Authentication

- Return a short-lived JWT access token to the client.
- Store the refresh token in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie.
- Store only a hash of each refresh token in PostgreSQL.
- Rotate the refresh token on every refresh request.
- Revoke the active session on logout, password change, detected token reuse, or account deactivation.
- Keep authorization checks in database queries by combining resource ID with authenticated user ID.

### Extraction Jobs

Use PostgreSQL as the durable source of truth instead of adding Redis:

- `POST /articles` creates an article and persisted extraction job in one transaction.
- The API returns `202 Accepted` with the article ID and `pending` status.
- An in-process worker claims jobs with row locking and `SKIP LOCKED`.
- A job records attempts, scheduling time, lock time, completion time, and a stable error code.
- Expired locks can be reclaimed after a crash.
- Retry is explicit and idempotent.
- The frontend polls article status with bounded backoff.

This keeps deployment simple while ensuring jobs are not stored only in memory.

### Stored Article Formats

Store only:

- sanitized readable HTML for the reader;
- plain text for search, snippets, and accessibility.

Do not add Markdown as a third representation unless a later requirement needs it.

## Milestone 0 Product Contract

### Tasks

- Confirm the English and Indonesian PRDs have the same technical contract.
- Resolve decisions that affect the schema:
  - extracted metadata overrides;
  - local or cross-device appearance settings;
  - account deletion;
  - PostgreSQL search configuration;
  - Collections remain deferred.
- Agree with frontend on error envelope, pagination envelope, authentication transport, and article extraction states.
- Record the API examples in an OpenAPI document only after the contract is agreed.

### Exit Criteria

- No unresolved decision blocks the initial schema.
- Frontend and backend use the same enum and endpoint names.

## Milestone 1 Repository Foundation

### Tasks

- Create `package.json`, TypeScript configuration, scripts, and strict linting/formatting rules.
- Add environment parsing that fails fast on invalid configuration.
- Create the Express application separately from the listening server for testability.
- Add JSON parsing limits, request IDs, structured logging, Helmet, and restricted CORS.
- Add centralized error translation and 404 handling.
- Add `/health/live` and `/health/ready`.
- Add Dockerfile and Docker Compose services for API and PostgreSQL.
- Add Vitest and Supertest test setup.
- Add CI for typecheck, tests, and production build.

### Verification

- A clean checkout starts through Docker Compose.
- Invalid environment values prevent startup with a clear message.
- Readiness fails when PostgreSQL is unavailable.
- Typecheck, build, and a health endpoint integration test pass.

## Milestone 2 Database Schema

### Tasks

- Define enums for role, reading status, extraction status, and extraction error code.
- Create tables:
  - `users`;
  - `sessions`;
  - `articles`;
  - `extraction_jobs`;
  - `tags`;
  - `article_tags`;
  - `highlights`;
  - `blocked_domains`.
- Add foreign keys and deliberate cascade behavior.
- Add unique constraints for normalized email, per-user canonical URL, per-user normalized tag, and article-tag pairs.
- Add indexes for ownership, status filters, favorite, archive, job claims, and common sorting.
- Add migration and seed commands.
- Seed one administrator only through explicit development seed data.

### Verification

- Migrations succeed on an empty database.
- Migrations can be reapplied safely in CI from scratch.
- Constraints reject duplicate emails, tags, article URLs, and article-tag relations.
- Deleting an article removes dependent highlights and tag relations without deleting tags.

## Milestone 3 Authentication and Ownership

### Tasks

- Implement registration, login, refresh, logout, `GET /me`, `PATCH /me`, and password change.
- Normalize emails before lookup and persistence.
- Apply a reviewed bcrypt cost without blocking tests unnecessarily.
- Implement access-token verification middleware.
- Implement refresh-token rotation and reuse detection.
- Apply focused rate limits to authentication endpoints.
- Use generic credential errors that do not reveal account existence.
- Add user-active checks to authenticated requests.

### Verification

- Happy-path registration, login, refresh rotation, logout, and password change pass.
- Duplicate normalized email is rejected.
- Expired, malformed, revoked, and reused tokens are rejected.
- Logout and password change invalidate the relevant sessions.
- An inactive user cannot authenticate or refresh.
- Security-sensitive responses never include password hashes or refresh-token hashes.

## Milestone 4 Secure Article Ingestion

### Tasks

- Validate absolute HTTP and HTTPS URLs and reject embedded credentials.
- Normalize submitted URLs for duplicate detection without changing meaningful query parameters.
- Normalize hostnames and enforce the blocked-domain policy.
- Resolve DNS and reject private, loopback, link-local, multicast, unspecified, and reserved IPv4 and IPv6 ranges.
- Pin or otherwise verify the actual connection destination to prevent DNS rebinding.
- Re-run the complete destination policy for every redirect.
- Limit redirects, response size, content type, and total request duration.
- Parse the HTML with JSDOM and Readability.
- Extract metadata using DOM APIs; introduce Cheerio only if evidence shows it is needed.
- Sanitize readable HTML using an explicit element, attribute, and URL-protocol allowlist.
- Produce plain text, word count, and estimated reading time.
- Implement persisted job claiming, completion, failure, stale-lock recovery, and retry.

### Verification

- A normal public article is extracted and stored.
- Localhost, private IPv4, private IPv6, link-local, blocked domains, and redirect-to-private targets are rejected.
- Oversized, timed-out, non-HTML, redirect-loop, malformed, and unreadable responses fail with stable safe codes.
- Script, event-handler, unsafe URL, form, iframe, and unsupported markup payloads do not survive sanitization.
- Restarting the API does not permanently lose a pending or stale job.
- Retrying does not create a duplicate article or concurrent duplicate jobs.

## Milestone 5 Article Library

### Tasks

- Implement article creation, list, detail, patch, delete, extraction retry, and progress endpoints.
- Return summary projections from list endpoints without article HTML.
- Add page and page-size validation with a maximum size.
- Add status, tag, favorite, archive, and sort filters.
- Define allowed user edits explicitly; never spread arbitrary request objects into database updates.
- Implement reading transitions and finished timestamps.
- Throttle progress in the frontend; make the backend update idempotent.
- Return an existing owned article when the same normalized URL is submitted again.

### Verification

- Filters and sorting work alone and in combination.
- Pagination metadata is correct at zero, partial, and full pages.
- Article details and mutations are inaccessible across users.
- Finished status produces 100 percent progress.
- Deletion removes dependent data and returns a consistent result.
- List responses never contain full readable HTML or plain text.

## Milestone 6 Tags and Highlights

### Tasks

- Implement tag list, create, rename, delete, attach, and detach endpoints.
- Normalize tag names consistently before uniqueness checks.
- Implement highlights across the library and per article.
- Store quote, prefix, suffix, offsets when available, and optional note.
- Enforce ownership through the related article and authenticated user.
- Keep highlight colors out of the MVP unless design confirms a meaningful use.

### Verification

- Duplicate normalized tag names are rejected.
- Deleting a tag preserves articles.
- Attaching an existing tag twice remains safe.
- Cross-user tag and highlight access is rejected.
- Highlight notes can be created, updated, listed, reopened, and deleted.

## Milestone 7 Full Text Search

### Tasks

- Create a weighted PostgreSQL `tsvector` from title, description, and body text.
- Use the `simple` configuration for mixed Indonesian and English MVP content unless testing supports a better choice.
- Add and verify a GIN index.
- Implement ranked results and safe snippets.
- Combine search with the existing library filters and pagination.
- Treat empty or whitespace-only queries as normal library navigation.

### Verification

- Search finds title and body terms.
- Title matches rank above body-only matches.
- Search results are isolated by owner.
- Snippet markers cannot introduce XSS.
- Query plans use the intended index on representative seeded data.

## Milestone 8 Administration and Bookmarklet Support

### Tasks

- Implement blocked-domain CRUD for administrators.
- Document exact-host and subdomain behavior.
- Record admin changes without storing private article content.
- Ensure article creation supports the frontend bookmarklet handoff without special credentials.
- Keep bookmarklet authentication in the normal SimpanDulu web session.

### Verification

- Normal users receive `403` from admin endpoints.
- A newly blocked domain is rejected by article ingestion.
- Subdomain matching follows the documented rule.
- Bookmarklet submission works without embedding a token in bookmarklet code.

## Milestone 9 Hardening and Delivery

### Tasks

- Add request and response examples to the OpenAPI contract.
- Add production configuration documentation and an example environment file with no secrets.
- Add graceful shutdown for HTTP traffic, database connections, and job claiming.
- Add container health checks and a non-root runtime user.
- Review log fields and redact credentials, cookies, and article content.
- Run dependency and container vulnerability checks.
- Prepare deterministic demo seed data that does not rely on live third-party websites.
- Document backup, migration, and rollback expectations for the demonstration environment.

### Verification

- A fresh environment can be started using only documented commands.
- Typecheck, unit tests, integration tests, build, and migration checks pass in CI.
- The real end-to-end flow passes:
  1. register;
  2. login;
  3. submit article;
  4. observe extraction completion;
  5. search body content;
  6. update reading progress;
  7. create a highlight and note;
  8. favorite and archive;
  9. logout and confirm refresh revocation.
- Authorization, SSRF, redirect, stored-XSS, and token-reuse regression suites pass.

## Test Strategy

### Unit Tests

Reserve unit tests for deterministic logic with meaningful branches:

- URL and hostname normalization;
- IP classification and redirect policy;
- tag normalization;
- reading-state transitions;
- token hashing and comparison helpers;
- extraction metadata normalization;
- search-query preparation.

### Integration Tests

Use a real PostgreSQL test database for:

- authentication lifecycle;
- constraints and cascades;
- ownership isolation;
- article filters and pagination;
- job claiming and stale-lock recovery;
- tags and highlights;
- full-text search ranking and isolation.

### Controlled Extraction Tests

Use a local controlled HTTP fixture server to produce redirects, slow responses, large bodies, invalid content types, malicious HTML, and known article markup. The fetcher needs an injectable resolver or destination policy so SSRF behavior can be tested without contacting real internal addresses.

Avoid a large number of shallow controller tests. Prefer fewer tests that cross the HTTP, validation, service, and database boundaries.

## Pull Request Sequence

Keep pull requests small enough to review but complete enough to demonstrate behavior:

1. `chore: initialize backend foundation`
2. `feat: add database schema and migrations`
3. `feat: implement authentication and sessions`
4. `feat: add secure article extraction pipeline`
5. `feat: implement article library endpoints`
6. `feat: add tags and highlights`
7. `feat: implement full text search`
8. `feat: add blocked domain administration`
9. `chore: harden and document backend delivery`

Every PR description must contain Summary, What, Why, and Validation sections. Do not combine foundation, authentication, and extraction into one initial PR.

## Definition of Done for Every Milestone

- Requirements and failure behavior are explicit.
- Validation is implemented at the boundary.
- Ownership and role authorization are enforced in backend queries.
- Database changes include a migration and constraint-level verification.
- New behavior has focused automated tests.
- Typecheck, tests, and production build pass.
- Logs contain enough context to diagnose failure without exposing secrets or private article content.
- API behavior is documented for the frontend.
- No unrelated user files are staged or modified.

## Main Risks

| Risk | Mitigation |
| --- | --- |
| Cross-user data exposure | Scope repository queries by authenticated user and test guessed IDs across every resource |
| SSRF and DNS rebinding | Validate resolved destinations, pin or verify connections, and revalidate every redirect |
| Stored XSS in article content | Sanitize on ingestion with an allowlist and test hostile fixtures |
| Lost extraction work | Persist jobs, reclaim stale locks, and make retries idempotent |
| Refresh-token theft or reuse | HTTP-only cookies, token hashing, rotation, revocation, and reuse detection |
| Scope growth | Keep Collections, Markdown storage, Redis, WebSockets, and semantic search outside MVP |
| Fragile live-site tests | Use deterministic fixture pages and reserve live checks for manual smoke testing |

## Recommended Starting Point

Start with Milestone 0 and Milestone 1 only. Do not design every module in advance. Establish the shared API envelopes and repository foundation, verify the clean-start workflow, then add the schema in a separate reviewable change.

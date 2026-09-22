import { createServer, type Server } from "node:http";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pino from "pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApiRouter } from "../../api.js";
import { createApp } from "../../app.js";
import type { AppConfig } from "../../config/env.js";
import { createDatabase } from "../../db/client.js";
import { ArticleFetcher } from "../extraction/article-fetcher.js";
import { ExtractionRepository } from "../extraction/extraction.repository.js";
import { ExtractionWorker } from "../extraction/extraction.worker.js";
import { createDestinationPolicy } from "../extraction/url-policy.js";

const connectionString = process.env.TEST_DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: connectionString ?? "postgresql://unused",
  CORS_ORIGIN: "http://localhost:5173",
  LOG_LEVEL: "silent",
  DATABASE_MAX_CONNECTIONS: 5,
  ACCESS_TOKEN_SECRET: "test-access-token-secret-at-least-32-characters",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 30,
  JWT_ISSUER: "simpandulu-api",
  JWT_AUDIENCE: "simpandulu-web",
  BCRYPT_ROUNDS: 10,
  AUTH_RATE_LIMIT_MAX: 1_000,
  EXTRACTION_TIMEOUT_MS: 500,
  EXTRACTION_MAX_BYTES: 100_000,
  EXTRACTION_MAX_REDIRECTS: 3,
  EXTRACTION_POLL_INTERVAL_MS: 100,
  EXTRACTION_STALE_LOCK_MS: 10_000,
  SHUTDOWN_TIMEOUT_MS: 10_000,
};

const authResponseSchema = z.object({
  data: z.object({ accessToken: z.string() }),
});
const articleResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    extractionStatus: z.enum(["pending", "processing", "completed", "failed"]),
    extractionErrorCode: z.string().nullable(),
  }),
});

describeWithDatabase("article extraction API", () => {
  const pool = new Pool({ connectionString });
  const database = createDatabase(pool);
  const logger = pino({ level: "silent" });
  const app = createApp({
    config,
    logger,
    checkDatabase: async () => {
      await pool.query("select 1");
    },
    apiRouter: createApiRouter(database, config),
  });
  let fixtureServer: Server;
  let fixturePort: number;
  let worker: ExtractionWorker;

  beforeAll(async () => {
    await pool.query(
      "drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public",
    );
    await migrate(drizzle(pool), { migrationsFolder: "drizzle" });

    fixtureServer = createServer((request, response) => {
      if (request.url === "/non-html") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head>
        <title>Integration article</title>
        <meta name="description" content="Integration description">
      </head><body><article><h1>Integration article</h1>
        <p>${"Meaningful article content for extraction. ".repeat(40)}</p>
        <script>alert(1)</script><p onclick="alert(2)">Sanitized paragraph</p>
      </article></body></html>`);
    });
    await new Promise<void>((resolve) =>
      fixtureServer.listen(0, "127.0.0.1", resolve),
    );
    const address = fixtureServer.address();
    if (!address || typeof address === "string")
      throw new Error("Expected fixture server address");
    fixturePort = address.port;

    const policy = createDestinationPolicy(database, {
      allowPrivateNetworks: true,
      allowNonStandardPorts: true,
      resolveHostname: () =>
        Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    });
    worker = new ExtractionWorker(
      new ExtractionRepository(
        pool,
        "integration-worker",
        config.EXTRACTION_STALE_LOCK_MS,
      ),
      new ArticleFetcher(config, policy),
      logger,
      config.EXTRACTION_POLL_INTERVAL_MS,
    );
  });

  beforeEach(async () => {
    await pool.query("truncate table users, blocked_domains cascade");
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      fixtureServer.close((error) => (error ? reject(error) : resolve()));
    });
    await pool.end();
  });

  async function register(email: string): Promise<string> {
    const response = await request(app).post("/api/v1/auth/register").send({
      name: "Article Reader",
      email,
      password: "correct-horse-battery-staple",
      passwordConfirmation: "correct-horse-battery-staple",
    });
    return authResponseSchema.parse(response.body as unknown).data.accessToken;
  }

  function fixtureUrl(path: string): string {
    return `http://fixture.test:${String(fixturePort)}${path}`;
  }

  it("queues, deduplicates, extracts, sanitizes, and isolates an article", async () => {
    const accessToken = await register("owner@example.com");
    const create = await request(app)
      .post("/api/v1/articles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ url: fixtureUrl("/article") });
    expect(create.status).toBe(202);
    const queued = articleResponseSchema.parse(create.body as unknown).data;

    const duplicate = await request(app)
      .post("/api/v1/articles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ url: fixtureUrl("/article") });
    expect(duplicate.status).toBe(200);
    expect(articleResponseSchema.parse(duplicate.body as unknown).data.id).toBe(
      queued.id,
    );

    await expect(worker.processNext()).resolves.toBe(true);
    const detail = await request(app)
      .get(`/api/v1/articles/${queued.id}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      data: {
        extractionStatus: "completed",
        title: "Integration article",
        description: "Integration description",
      },
    });
    const detailBody = z
      .object({ data: z.object({ contentHtml: z.string() }) })
      .parse(detail.body as unknown);
    expect(detailBody.data.contentHtml).not.toMatch(/<script|onclick|alert\(/i);

    const otherAccessToken = await register("other@example.com");
    const crossUser = await request(app)
      .get(`/api/v1/articles/${queued.id}`)
      .set("Authorization", `Bearer ${otherAccessToken}`);
    expect(crossUser.status).toBe(404);
  });

  it("stores safe failure codes and retries idempotently", async () => {
    const accessToken = await register("owner@example.com");
    const create = await request(app)
      .post("/api/v1/articles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ url: fixtureUrl("/non-html") });
    const article = articleResponseSchema.parse(create.body as unknown).data;

    await worker.processNext();
    const failed = await request(app)
      .get(`/api/v1/articles/${article.id}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(failed.body).toMatchObject({
      data: {
        extractionStatus: "failed",
        extractionErrorCode: "UNSUPPORTED_CONTENT",
      },
    });

    const retry = await request(app)
      .post(`/api/v1/articles/${article.id}/retry`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ data: { extractionStatus: "pending" } });
    const duplicateRetry = await request(app)
      .post(`/api/v1/articles/${article.id}/retry`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(duplicateRetry.status).toBe(409);
  });

  it("fails blocked domains without contacting them", async () => {
    const accessToken = await register("owner@example.com");
    await pool.query(
      "insert into blocked_domains (hostname, reason) values ('blocked.test', 'Integration test')",
    );
    const create = await request(app)
      .post("/api/v1/articles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ url: `http://blocked.test:${String(fixturePort)}/article` });
    const article = articleResponseSchema.parse(create.body as unknown).data;

    await worker.processNext();
    const failed = await request(app)
      .get(`/api/v1/articles/${article.id}`)
      .set("Authorization", `Bearer ${accessToken}`);
    expect(failed.body).toMatchObject({
      data: { extractionStatus: "failed", extractionErrorCode: "URL_BLOCKED" },
    });
  });

  it("rejects private and mixed DNS answers before opening a connection", async () => {
    const privatePolicy = createDestinationPolicy(database, {
      allowNonStandardPorts: true,
      resolveHostname: () =>
        Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    });
    await expect(
      privatePolicy(new URL(fixtureUrl("/article"))),
    ).rejects.toMatchObject({
      code: "URL_BLOCKED",
    });

    const mixedPolicy = createDestinationPolicy(database, {
      allowNonStandardPorts: true,
      resolveHostname: () =>
        Promise.resolve([
          { address: "1.1.1.1", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ]),
    });
    await expect(
      mixedPolicy(new URL(fixtureUrl("/article"))),
    ).rejects.toMatchObject({
      code: "URL_BLOCKED",
    });
  });

  it("reclaims stale jobs and prevents concurrent duplicate claims", async () => {
    const accessToken = await register("owner@example.com");
    await request(app)
      .post("/api/v1/articles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ url: fixtureUrl("/stale") });
    await pool.query(
      `update extraction_jobs
       set status = 'processing', locked_by = 'dead-worker', locked_at = now() - interval '1 hour'`,
    );

    const firstRepository = new ExtractionRepository(
      pool,
      "claim-worker-one",
      10_000,
    );
    const reclaimed = await firstRepository.claim();
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.attempts).toBe(1);
    const processingArticle = await pool.query<{ extraction_status: string }>(
      "select extraction_status from articles where id = $1",
      [reclaimed?.articleId],
    );
    expect(processingArticle.rows[0]?.extraction_status).toBe("processing");

    await request(app)
      .post("/api/v1/articles")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ url: fixtureUrl("/concurrent") });
    const secondRepository = new ExtractionRepository(
      pool,
      "claim-worker-two",
      10_000,
    );
    const thirdRepository = new ExtractionRepository(
      pool,
      "claim-worker-three",
      10_000,
    );
    const claims = await Promise.all([
      secondRepository.claim(),
      thirdRepository.claim(),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
  });
});

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

  it("lists only owned article summaries with combined filters and pagination", async () => {
    const ownerToken = await register("owner@example.com");
    const otherToken = await register("other@example.com");
    const create = async (token: string, path: string) => {
      const response = await request(app)
        .post("/api/v1/articles")
        .set("Authorization", `Bearer ${token}`)
        .send({ url: fixtureUrl(path) });
      expect(response.status).toBe(202);
      return articleResponseSchema.parse(response.body as unknown).data.id;
    };
    const firstId = await create(ownerToken, "/first");
    const secondId = await create(ownerToken, "/second");
    const archivedId = await create(ownerToken, "/archived");
    const otherId = await create(otherToken, "/other");
    await pool.query(
      `update articles set title = case id
         when $1::uuid then 'Alpha' when $2::uuid then 'Beta' else 'Hidden' end,
         reading_status = (case when id = $2::uuid then 'reading' else 'unread' end)::reading_status,
         is_favorite = id = $2::uuid, is_archived = id = $3::uuid,
         content_html = '<p>private reader content</p>', content_text = 'private reader content'
       where id in ($1::uuid, $2::uuid, $3::uuid)`,
      [firstId, secondId, archivedId],
    );
    const owner = await pool.query<{ user_id: string }>(
      "select user_id from articles where id = $1",
      [firstId],
    );
    const tag = await pool.query<{ id: string }>(
      "insert into tags (user_id, name, normalized_name) values ($1, 'Read', 'read') returning id",
      [owner.rows[0]?.user_id],
    );
    const tagId = tag.rows[0]?.id;
    if (!tagId) throw new Error("Expected tag to be created");
    await pool.query(
      "insert into article_tags (article_id, tag_id, user_id) values ($1, $2, $3)",
      [secondId, tagId, owner.rows[0]?.user_id],
    );

    const page = await request(app)
      .get("/api/v1/articles?page=1&pageSize=1&sort=title&order=asc")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      data: [{ id: firstId, title: "Alpha" }],
      pagination: { page: 1, pageSize: 1, totalItems: 2, totalPages: 2 },
    });
    expect(JSON.stringify(page.body)).not.toContain("private reader content");
    const pageData = z
      .object({ data: z.array(z.object({ id: z.uuid() })) })
      .parse(page.body as unknown).data;
    expect(pageData[0]).not.toHaveProperty("contentHtml");
    expect(pageData[0]).not.toHaveProperty("contentText");
    expect(pageData[0]).not.toHaveProperty("userId");

    const filtered = await request(app)
      .get(`/api/v1/articles?status=reading&favorite=true&tagId=${tagId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(filtered.body).toMatchObject({
      data: [{ id: secondId }],
      pagination: { totalItems: 1, totalPages: 1 },
    });
    const archived = await request(app)
      .get("/api/v1/articles?archived=true")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(archived.body).toMatchObject({ data: [{ id: archivedId }] });
    const empty = await request(app)
      .get("/api/v1/articles?page=3&pageSize=1")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(empty.body).toMatchObject({
      data: [],
      pagination: { page: 3, pageSize: 1, totalItems: 2, totalPages: 2 },
    });
    const isolated = await request(app)
      .get("/api/v1/articles")
      .set("Authorization", `Bearer ${otherToken}`);
    expect(isolated.body).toMatchObject({
      data: [{ id: otherId }],
      pagination: { totalItems: 1 },
    });
  });

  it("validates library query parameters and requires authentication", async () => {
    const token = await register("owner@example.com");
    for (const query of [
      "page=0",
      "pageSize=101",
      "favorite=yes",
      "sort=invalid",
      "tagId=bad",
    ]) {
      const response = await request(app)
        .get(`/api/v1/articles?${query}`)
        .set("Authorization", `Bearer ${token}`);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
    }
    expect((await request(app).get("/api/v1/articles")).status).toBe(401);
  });

  it("updates and deletes only owned articles with consistent reading state", async () => {
    const ownerToken = await register("owner@example.com");
    const otherToken = await register("other@example.com");
    const created = await request(app)
      .post("/api/v1/articles")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ url: fixtureUrl("/manageable") });
    const articleId = articleResponseSchema.parse(created.body as unknown).data
      .id;
    const path = `/api/v1/articles/${articleId}`;

    const otherPatch = await request(app)
      .patch(path)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ isFavorite: true });
    const otherProgress = await request(app)
      .put(`${path}/progress`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ progress: 25 });
    const otherDelete = await request(app)
      .delete(path)
      .set("Authorization", `Bearer ${otherToken}`);
    expect([
      otherPatch.status,
      otherProgress.status,
      otherDelete.status,
    ]).toEqual([404, 404, 404]);
    expect(
      (
        await request(app)
          .patch(path)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ title: "Injected" })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put(`${path}/progress`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ progress: 101 })
      ).status,
    ).toBe(400);

    const updated = await request(app)
      .patch(path)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ isFavorite: true, isArchived: true });
    expect(updated.body).toMatchObject({
      data: { isFavorite: true, isArchived: true },
    });

    const reading = await request(app)
      .put(`${path}/progress`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ progress: 25, anchor: "paragraph-2" });
    expect(reading.body).toMatchObject({
      data: {
        readingStatus: "reading",
        readingProgress: 25,
        readingAnchor: "paragraph-2",
      },
    });
    const finished = await request(app)
      .patch(path)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ readingStatus: "finished" });
    expect(finished.body).toMatchObject({
      data: { readingStatus: "finished", readingProgress: 100 },
    });
    const finishedAt = z
      .object({ data: z.object({ finishedAt: z.string() }) })
      .parse(finished.body as unknown).data.finishedAt;
    const repeated = await request(app)
      .put(`${path}/progress`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ progress: 100 });
    expect(repeated.body).toMatchObject({ data: { finishedAt } });

    expect(
      (
        await request(app)
          .delete(path)
          .set("Authorization", `Bearer ${ownerToken}`)
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .get(path)
          .set("Authorization", `Bearer ${ownerToken}`)
      ).status,
    ).toBe(404);
    const job = await pool.query(
      "select id from extraction_jobs where article_id = $1",
      [articleId],
    );
    expect(job.rowCount).toBe(0);
  });

  it("normalizes tags, attaches them idempotently, and preserves articles on deletion", async () => {
    const ownerToken = await register("owner@example.com");
    const otherToken = await register("other@example.com");
    const created = await request(app)
      .post("/api/v1/articles")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ url: fixtureUrl("/tagged") });
    const articleId = articleResponseSchema.parse(created.body as unknown).data
      .id;
    const tag = await request(app)
      .post("/api/v1/tags")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "  Research  " });
    expect(tag.status).toBe(201);
    const tagId = z
      .object({ data: z.object({ id: z.uuid(), name: z.string() }) })
      .parse(tag.body as unknown).data.id;
    expect(tag.body).toMatchObject({ data: { name: "Research" } });
    const duplicate = await request(app)
      .post("/api/v1/tags")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "research" });
    expect(duplicate.status).toBe(409);
    const association = `/api/v1/articles/${articleId}/tags/${tagId}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (
          await request(app)
            .put(association)
            .set("Authorization", `Bearer ${ownerToken}`)
        ).status,
      ).toBe(204);
    }
    const links = await pool.query(
      "select article_id from article_tags where article_id = $1",
      [articleId],
    );
    expect(links.rowCount).toBe(1);
    expect(
      (
        await request(app)
          .put(association)
          .set("Authorization", `Bearer ${otherToken}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .delete(`/api/v1/tags/${tagId}`)
          .set("Authorization", `Bearer ${otherToken}`)
      ).status,
    ).toBe(404);
    const renamed = await request(app)
      .patch(`/api/v1/tags/${tagId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Reading" });
    expect(renamed.body).toMatchObject({ data: { name: "Reading" } });
    const list = await request(app)
      .get("/api/v1/tags")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(list.body).toMatchObject({
      data: [{ id: tagId }],
      pagination: { totalItems: 1 },
    });
    expect(
      (
        await request(app)
          .delete(`/api/v1/tags/${tagId}`)
          .set("Authorization", `Bearer ${ownerToken}`)
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .get(`/api/v1/articles/${articleId}`)
          .set("Authorization", `Bearer ${ownerToken}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await pool.query(
          "select article_id from article_tags where article_id = $1",
          [articleId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("creates, lists, edits, and deletes highlights without cross-user access", async () => {
    const ownerToken = await register("owner@example.com");
    const otherToken = await register("other@example.com");
    const created = await request(app)
      .post("/api/v1/articles")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ url: fixtureUrl("/highlighted") });
    const articleId = articleResponseSchema.parse(created.body as unknown).data
      .id;
    const articlePath = `/api/v1/articles/${articleId}/highlights`;
    expect(
      (
        await request(app)
          .post(articlePath)
          .set("Authorization", `Bearer ${otherToken}`)
          .send({ quote: "Private" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(articlePath)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ quote: "Quote", startOffset: 5 })
      ).status,
    ).toBe(400);
    const createdHighlight = await request(app)
      .post(articlePath)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        quote: "  Selected sentence  ",
        prefix: "before",
        suffix: "after",
        startOffset: 10,
        endOffset: 27,
        note: "Initial note",
      });
    expect(createdHighlight.status).toBe(201);
    const highlightId = z
      .object({ data: z.object({ id: z.uuid() }) })
      .parse(createdHighlight.body as unknown).data.id;
    const highlightPath = `/api/v1/highlights/${highlightId}`;
    expect(createdHighlight.body).toMatchObject({
      data: { quote: "Selected sentence", note: "Initial note" },
    });
    const all = await request(app)
      .get("/api/v1/highlights")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(all.body).toMatchObject({
      data: [{ id: highlightId }],
      pagination: { totalItems: 1 },
    });
    const perArticle = await request(app)
      .get(articlePath)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(perArticle.body).toMatchObject({ data: [{ id: highlightId }] });
    expect(
      (
        await request(app)
          .get(articlePath)
          .set("Authorization", `Bearer ${otherToken}`)
      ).status,
    ).toBe(404);
    const isolated = await request(app)
      .get("/api/v1/highlights")
      .set("Authorization", `Bearer ${otherToken}`);
    expect(isolated.body).toMatchObject({
      data: [],
      pagination: { totalItems: 0 },
    });
    expect(
      (
        await request(app)
          .patch(highlightPath)
          .set("Authorization", `Bearer ${otherToken}`)
          .send({ note: "Stolen" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .delete(highlightPath)
          .set("Authorization", `Bearer ${otherToken}`)
      ).status,
    ).toBe(404);
    const updated = await request(app)
      .patch(highlightPath)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ note: "Updated note" });
    expect(updated.body).toMatchObject({ data: { note: "Updated note" } });
    expect(
      (
        await request(app)
          .delete(highlightPath)
          .set("Authorization", `Bearer ${ownerToken}`)
      ).status,
    ).toBe(204);
    expect(
      (
        await request(app)
          .get(articlePath)
          .set("Authorization", `Bearer ${ownerToken}`)
      ).body,
    ).toMatchObject({ data: [] });
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

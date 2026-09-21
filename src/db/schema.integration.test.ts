import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const connectionString = process.env.TEST_DATABASE_URL;
const describeWithDatabase = connectionString ? describe : describe.skip;

describeWithDatabase("database schema", () => {
  const pool = new Pool({ connectionString });
  const database = drizzle(pool);

  beforeAll(async () => {
    await pool.query(
      "drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public",
    );
    await migrate(database, { migrationsFolder: "drizzle" });
  });

  beforeEach(async () => {
    await pool.query("truncate table users, blocked_domains cascade");
  });

  afterAll(async () => {
    await pool.end();
  });

  function firstRow<T>(rows: T[]): T {
    const row = rows[0];
    if (!row) throw new Error("Expected the database query to return a row");
    return row;
  }

  async function createUser(email: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `insert into users (email, normalized_email, password_hash, name)
       values ($1, $2, 'test-password-hash', 'Test User') returning id`,
      [email, email.trim().toLowerCase()],
    );
    return firstRow(result.rows).id;
  }

  async function createArticle(userId: string, url: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `insert into articles (user_id, submitted_url, normalized_url)
       values ($1, $2, $2) returning id`,
      [userId, url],
    );
    return firstRow(result.rows).id;
  }

  it("enforces normalized email and per-user URL uniqueness", async () => {
    const firstUserId = await createUser("reader@example.com");
    const secondUserId = await createUser("other@example.com");

    await expect(createUser("reader@example.com")).rejects.toMatchObject({
      code: "23505",
    });
    await createArticle(firstUserId, "https://example.com/article");
    await expect(
      createArticle(firstUserId, "https://example.com/article"),
    ).rejects.toMatchObject({
      code: "23505",
    });
    await expect(
      createArticle(secondUserId, "https://example.com/article"),
    ).resolves.toBeTypeOf("string");
  });

  it("prevents cross-user tag and highlight associations", async () => {
    const ownerId = await createUser("owner@example.com");
    const otherUserId = await createUser("other@example.com");
    const articleId = await createArticle(ownerId, "https://example.com/owned");
    const tagResult = await pool.query<{ id: string }>(
      `insert into tags (user_id, name, normalized_name)
       values ($1, 'Research', 'research') returning id`,
      [otherUserId],
    );
    const tagId = firstRow(tagResult.rows).id;

    await expect(
      pool.query(
        "insert into article_tags (article_id, tag_id, user_id) values ($1, $2, $3)",
        [articleId, tagId, ownerId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        "insert into highlights (article_id, user_id, quote) values ($1, $2, 'private')",
        [articleId, otherUserId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects duplicate normalized tags and article-tag relations", async () => {
    const userId = await createUser("reader@example.com");
    const articleId = await createArticle(userId, "https://example.com/tags");
    const tagResult = await pool.query<{ id: string }>(
      `insert into tags (user_id, name, normalized_name)
       values ($1, 'Research', 'research') returning id`,
      [userId],
    );
    const tagId = firstRow(tagResult.rows).id;

    await expect(
      pool.query(
        "insert into tags (user_id, name, normalized_name) values ($1, 'research', 'research')",
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await pool.query(
      "insert into article_tags (article_id, tag_id, user_id) values ($1, $2, $3)",
      [articleId, tagId, userId],
    );
    await expect(
      pool.query(
        "insert into article_tags (article_id, tag_id, user_id) values ($1, $2, $3)",
        [articleId, tagId, userId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("cascades article-owned records while preserving tags", async () => {
    const userId = await createUser("reader@example.com");
    const articleId = await createArticle(
      userId,
      "https://example.com/cascade",
    );
    const tagResult = await pool.query<{ id: string }>(
      `insert into tags (user_id, name, normalized_name)
       values ($1, 'Backend', 'backend') returning id`,
      [userId],
    );
    const tagId = firstRow(tagResult.rows).id;

    await pool.query("insert into extraction_jobs (article_id) values ($1)", [
      articleId,
    ]);
    await pool.query(
      "insert into article_tags (article_id, tag_id, user_id) values ($1, $2, $3)",
      [articleId, tagId, userId],
    );
    await pool.query(
      "insert into highlights (article_id, user_id, quote) values ($1, $2, 'selected text')",
      [articleId, userId],
    );

    await pool.query("delete from articles where id = $1", [articleId]);

    const dependents = await pool.query<{ count: string }>(
      `select count(*) from (
        select article_id from extraction_jobs where article_id = $1
        union all select article_id from article_tags where article_id = $1
        union all select article_id from highlights where article_id = $1
      ) records`,
      [articleId],
    );
    const remainingTag = await pool.query("select id from tags where id = $1", [
      tagId,
    ]);

    expect(firstRow(dependents.rows).count).toBe("0");
    expect(remainingTag.rowCount).toBe(1);
  });

  it("tracks refresh rotation families and validates bounded values", async () => {
    const userId = await createUser("reader@example.com");
    const familyId = randomUUID();
    const firstSessionId = randomUUID();
    const secondSessionId = randomUUID();

    await pool.query(
      `insert into sessions (id, user_id, family_id, refresh_token_hash, expires_at)
       values ($1, $2, $3, 'first-token-hash', now() + interval '1 day')`,
      [firstSessionId, userId, familyId],
    );
    await pool.query(
      `insert into sessions (id, user_id, family_id, refresh_token_hash, expires_at)
       values ($1, $2, $3, 'second-token-hash', now() + interval '1 day')`,
      [secondSessionId, userId, familyId],
    );
    await pool.query(
      "update sessions set revoked_at = now(), replaced_by_session_id = $1 where id = $2",
      [secondSessionId, firstSessionId],
    );

    const sessions = await pool.query<{
      family_id: string;
      replaced_by_session_id: string | null;
    }>(
      "select family_id, replaced_by_session_id from sessions order by created_at, id",
    );
    expect(sessions.rows).toHaveLength(2);
    expect(
      sessions.rows.every((session) => session.family_id === familyId),
    ).toBe(true);
    expect(
      sessions.rows.some(
        (session) => session.replaced_by_session_id === secondSessionId,
      ),
    ).toBe(true);

    const articleId = await createArticle(
      userId,
      "https://example.com/progress",
    );
    await expect(
      pool.query("update articles set reading_progress = 101 where id = $1", [
        articleId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("removes user-owned data while preserving administrator domain rules", async () => {
    const userId = await createUser("admin@example.com");
    const articleId = await createArticle(
      userId,
      "https://example.com/private",
    );
    await pool.query(
      "insert into blocked_domains (hostname, reason, created_by_user_id) values ('blocked.example', 'Test rule', $1)",
      [userId],
    );

    await pool.query("delete from users where id = $1", [userId]);

    const article = await pool.query("select id from articles where id = $1", [
      articleId,
    ]);
    const blockedDomain = await pool.query<{
      created_by_user_id: string | null;
    }>(
      "select created_by_user_id from blocked_domains where hostname = 'blocked.example'",
    );
    expect(article.rowCount).toBe(0);
    expect(firstRow(blockedDomain.rows).created_by_user_id).toBeNull();
  });
});

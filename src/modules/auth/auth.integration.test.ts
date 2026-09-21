import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pino from "pino";
import { Pool } from "pg";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../app.js";
import type { AppConfig } from "../../config/env.js";
import { createDatabase } from "../../db/client.js";
import { createAuthRouter } from "./auth.routes.js";

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
  EXTRACTION_TIMEOUT_MS: 15_000,
  EXTRACTION_MAX_BYTES: 2_000_000,
  EXTRACTION_MAX_REDIRECTS: 5,
  EXTRACTION_POLL_INTERVAL_MS: 500,
  EXTRACTION_STALE_LOCK_MS: 300_000,
  SHUTDOWN_TIMEOUT_MS: 10_000,
};

const authResponseSchema = z.object({
  data: z.object({
    user: z.object({
      id: z.uuid(),
      email: z.email(),
      name: z.string(),
      role: z.enum(["user", "admin"]),
    }),
    accessToken: z.string().min(1),
    tokenType: z.literal("Bearer"),
    expiresIn: z.number(),
  }),
});

function cookieFrom(response: Response): string {
  const header: unknown = response.headers["set-cookie"];
  if (!Array.isArray(header) || typeof header[0] !== "string") {
    throw new Error("Expected a Set-Cookie response header");
  }
  const [cookie] = header[0].split(";");
  if (!cookie) throw new Error("Expected a refresh cookie");
  return cookie;
}

describeWithDatabase("authentication API", () => {
  const pool = new Pool({ connectionString });
  const database = createDatabase(pool);
  const app = createApp({
    config,
    logger: pino({ level: "silent" }),
    checkDatabase: async () => {
      await pool.query("select 1");
    },
    apiRouter: createAuthRouter(database, config),
  });

  beforeAll(async () => {
    await pool.query(
      "drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public",
    );
    await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  });

  beforeEach(async () => {
    await pool.query("truncate table users cascade");
  });

  afterAll(async () => {
    await pool.end();
  });

  async function register() {
    const response = await request(app).post("/api/v1/auth/register").send({
      name: "Test Reader",
      email: "Reader@Example.com",
      password: "correct-horse-battery-staple",
      passwordConfirmation: "correct-horse-battery-staple",
    });
    return {
      response,
      body: authResponseSchema.parse(response.body as unknown),
      cookie: cookieFrom(response),
    };
  }

  it("registers, reads and updates the profile, rotates, and logs out", async () => {
    const registration = await register();
    expect(registration.response.status).toBe(201);
    expect(registration.body.data.user.email).toBe("reader@example.com");
    expect(JSON.stringify(registration.response.body)).not.toMatch(
      /passwordHash|refreshTokenHash/,
    );

    const profile = await request(app)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${registration.body.data.accessToken}`);
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ data: { name: "Test Reader" } });

    const updated = await request(app)
      .patch("/api/v1/me")
      .set("Authorization", `Bearer ${registration.body.data.accessToken}`)
      .send({ name: "Updated Reader" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ data: { name: "Updated Reader" } });

    const refreshed = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", registration.cookie);
    expect(refreshed.status).toBe(200);
    const nextCookie = cookieFrom(refreshed);
    expect(nextCookie).not.toBe(registration.cookie);

    const logout = await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", nextCookie);
    expect(logout.status).toBe(204);
    const afterLogout = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", nextCookie);
    expect(afterLogout.status).toBe(401);
  });

  it("detects refresh-token reuse and revokes the replacement session", async () => {
    const registration = await register();
    const firstRefresh = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", registration.cookie);
    const replacementCookie = cookieFrom(firstRefresh);

    const reused = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", registration.cookie);
    expect(reused.status).toBe(401);
    expect(reused.body).toMatchObject({
      error: { code: "REFRESH_TOKEN_REUSED" },
    });

    const replacement = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", replacementCookie);
    expect(replacement.status).toBe(401);
  });

  it("uses generic login failures and rejects inactive users", async () => {
    const registration = await register();

    const wrongPassword = await request(app).post("/api/v1/auth/login").send({
      email: "reader@example.com",
      password: "incorrect",
    });
    const unknownEmail = await request(app).post("/api/v1/auth/login").send({
      email: "unknown@example.com",
      password: "incorrect",
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);

    await pool.query(
      "update users set is_active = false where email = 'reader@example.com'",
    );
    const inactiveProfile = await request(app)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${registration.body.data.accessToken}`);
    const inactiveRefresh = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", registration.cookie);
    expect(inactiveProfile.status).toBe(401);
    expect(inactiveRefresh.status).toBe(401);
  });

  it("rejects duplicate email normalization and malformed input", async () => {
    await register();
    const duplicate = await request(app).post("/api/v1/auth/register").send({
      name: "Another Reader",
      email: " READER@example.com ",
      password: "another-secure-password",
      passwordConfirmation: "another-secure-password",
    });
    expect(duplicate.status).toBe(409);

    const invalid = await request(app).post("/api/v1/auth/register").send({
      name: "A",
      email: "not-an-email",
      password: "short",
      passwordConfirmation: "different",
    });
    expect(invalid.status).toBe(400);
    const invalidBody = z
      .object({
        error: z.object({
          code: z.literal("VALIDATION_ERROR"),
          fields: z.record(z.string(), z.string()),
        }),
      })
      .parse(invalid.body as unknown);
    expect(Object.keys(invalidBody.error.fields).length).toBeGreaterThan(0);
  });

  it("changes the password and revokes all refresh sessions", async () => {
    const registration = await register();
    const secondLogin = await request(app).post("/api/v1/auth/login").send({
      email: "reader@example.com",
      password: "correct-horse-battery-staple",
    });
    const secondCookie = cookieFrom(secondLogin);

    const change = await request(app)
      .put("/api/v1/me/password")
      .set("Authorization", `Bearer ${registration.body.data.accessToken}`)
      .send({
        currentPassword: "correct-horse-battery-staple",
        newPassword: "new-correct-horse-battery-staple",
        passwordConfirmation: "new-correct-horse-battery-staple",
      });
    expect(change.status).toBe(204);

    const oldSession = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", registration.cookie);
    const secondSession = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", secondCookie);
    expect(oldSession.status).toBe(401);
    expect(secondSession.status).toBe(401);

    const oldPassword = await request(app).post("/api/v1/auth/login").send({
      email: "reader@example.com",
      password: "correct-horse-battery-staple",
    });
    const newPassword = await request(app).post("/api/v1/auth/login").send({
      email: "reader@example.com",
      password: "new-correct-horse-battery-staple",
    });
    expect(oldPassword.status).toBe(401);
    expect(newPassword.status).toBe(200);
  });
});

import pino from "pino";
import { Writable } from "node:stream";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { AppConfig } from "./config/env.js";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "postgresql://user:password@localhost:5432/simpandulu_test",
  CORS_ORIGIN: "http://localhost:5173",
  LOG_LEVEL: "silent",
  DATABASE_MAX_CONNECTIONS: 10,
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

const logger = pino({ level: "silent" });

describe("health endpoints", () => {
  it("logs request paths without query text or credentials", async () => {
    const entries: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        entries.push(chunk.toString());
        done();
      },
    });
    const app = createApp({
      config,
      logger: pino({ level: "info" }, sink),
      checkDatabase: vi.fn(),
    });
    const response = await request(app)
      .get("/health/live?url=private-article&token=private-token")
      .set("Authorization", "Bearer private-access-token")
      .set("Cookie", "session=private-cookie");

    expect(response.status).toBe(200);
    const output = entries.join("");
    expect(output).toContain('"path":"/health/live"');
    expect(output).not.toMatch(
      /private-article|private-token|private-access-token|private-cookie/,
    );
    sink.destroy();
  });

  it("reports that the process is alive", async () => {
    const app = createApp({ config, logger, checkDatabase: vi.fn() });
    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toBeTypeOf("string");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("reports readiness when PostgreSQL is reachable", async () => {
    const checkDatabase = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ config, logger, checkDatabase });
    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready" });
    expect(checkDatabase).toHaveBeenCalledOnce();
  });

  it("reports unavailability when PostgreSQL is unreachable", async () => {
    const app = createApp({
      config,
      logger,
      checkDatabase: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "unavailable" });
  });
});

describe("public API documentation", () => {
  it("serves the OpenAPI document without authentication", async () => {
    const app = createApp({ config, logger, checkDatabase: vi.fn() });
    const response = await request(app).get("/openapi.yaml");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/yaml/);
    expect(response.text).toContain("openapi: 3.1.0");
    expect(response.text).toContain("url: /");
  });

  it("renders an interactive reference without authentication", async () => {
    const app = createApp({ config, logger, checkDatabase: vi.fn() });
    const response = await request(app).get("/docs");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/html/);
    expect(response.text).toContain("Scalar");
    expect(response.text).toContain("/openapi.yaml");
  });
});

describe("fallback behavior", () => {
  it("uses the shared error envelope for unknown routes", async () => {
    const app = createApp({ config, logger, checkDatabase: vi.fn() });
    const response = await request(app).get("/missing");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    });
  });
});

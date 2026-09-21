import pino from "pino";
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
  SHUTDOWN_TIMEOUT_MS: 10_000,
};

const logger = pino({ level: "silent" });

describe("health endpoints", () => {
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

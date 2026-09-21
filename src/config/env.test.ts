import { describe, expect, it } from "vitest";
import { parseEnvironment } from "./env.js";

const validEnvironment = {
  NODE_ENV: "test",
  PORT: "3000",
  DATABASE_URL: "postgresql://user:password@localhost:5432/simpandulu_test",
  CORS_ORIGIN: "http://localhost:5173",
  ACCESS_TOKEN_SECRET: "test-access-token-secret-at-least-32-characters",
};

describe("parseEnvironment", () => {
  it("parses valid configuration and applies defaults", () => {
    expect(parseEnvironment(validEnvironment)).toMatchObject({
      NODE_ENV: "test",
      PORT: 3000,
      LOG_LEVEL: "info",
      DATABASE_MAX_CONNECTIONS: 10,
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 30,
    });
  });

  it("rejects invalid database protocols", () => {
    expect(() =>
      parseEnvironment({
        ...validEnvironment,
        DATABASE_URL: "https://example.com",
      }),
    ).toThrow("DATABASE_URL must use the postgresql or postgres protocol");
  });

  it("rejects invalid ports", () => {
    expect(() =>
      parseEnvironment({ ...validEnvironment, PORT: "70000" }),
    ).toThrow("Invalid environment configuration");
  });
});

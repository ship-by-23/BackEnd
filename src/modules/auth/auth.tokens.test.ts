import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  createRefreshToken,
  hashRefreshToken,
  refreshTokenHashMatches,
  refreshTokenSessionId,
  signAccessToken,
  verifyAccessToken,
} from "./auth.tokens.js";

const config = {
  ACCESS_TOKEN_SECRET: "test-access-token-secret-at-least-32-characters",
  ACCESS_TOKEN_TTL_SECONDS: 900,
  JWT_ISSUER: "simpandulu-api",
  JWT_AUDIENCE: "simpandulu-web",
};

describe("access tokens", () => {
  it("signs and verifies the expected identity", async () => {
    const identity = {
      sub: "2b6b5df3-4514-41a6-aab7-7d8a0be927ae",
      role: "user" as const,
    };
    const token = await signAccessToken(identity, config);
    await expect(verifyAccessToken(token, config)).resolves.toEqual(identity);
  });

  it("rejects malformed and expired tokens", async () => {
    await expect(verifyAccessToken("not-a-jwt", config)).rejects.toBeDefined();

    const expired = await new SignJWT({ role: "user" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("2b6b5df3-4514-41a6-aab7-7d8a0be927ae")
      .setIssuer(config.JWT_ISSUER)
      .setAudience(config.JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1_000) - 1)
      .sign(new TextEncoder().encode(config.ACCESS_TOKEN_SECRET));
    await expect(verifyAccessToken(expired, config)).rejects.toBeDefined();
  });
});

describe("refresh tokens", () => {
  it("embeds the session id and compares only fixed-length hashes", () => {
    const sessionId = "2b6b5df3-4514-41a6-aab7-7d8a0be927ae";
    const token = createRefreshToken(sessionId);
    const hash = hashRefreshToken(token);

    expect(refreshTokenSessionId(token)).toBe(sessionId);
    expect(refreshTokenSessionId("malformed")).toBeNull();
    expect(refreshTokenHashMatches(hash, hash)).toBe(true);
    expect(refreshTokenHashMatches(hash, hashRefreshToken(`${token}x`))).toBe(
      false,
    );
  });
});

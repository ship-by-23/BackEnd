import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { AppConfig } from "../../config/env.js";

type TokenConfig = Pick<
  AppConfig,
  | "ACCESS_TOKEN_SECRET"
  | "ACCESS_TOKEN_TTL_SECONDS"
  | "JWT_ISSUER"
  | "JWT_AUDIENCE"
>;

const accessTokenPayloadSchema = z.object({
  sub: z.uuid(),
  role: z.enum(["user", "admin"]),
});

export type AccessTokenIdentity = z.infer<typeof accessTokenPayloadSchema>;

function secretKey(config: TokenConfig): Uint8Array {
  return new TextEncoder().encode(config.ACCESS_TOKEN_SECRET);
}

export async function signAccessToken(
  identity: AccessTokenIdentity,
  config: TokenConfig,
): Promise<string> {
  return new SignJWT({ role: identity.role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(identity.sub)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(config.ACCESS_TOKEN_TTL_SECONDS)}s`)
    .sign(secretKey(config));
}

export async function verifyAccessToken(
  token: string,
  config: TokenConfig,
): Promise<AccessTokenIdentity> {
  const { payload } = await jwtVerify(token, secretKey(config), {
    algorithms: ["HS256"],
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });
  return accessTokenPayloadSchema.parse(payload);
}

export function createRefreshToken(sessionId: string): string {
  return `${sessionId}.${randomBytes(32).toString("base64url")}`;
}

export function refreshTokenSessionId(token: string): string | null {
  const separator = token.indexOf(".");
  if (separator === -1) return null;

  const sessionId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  return z.uuid().safeParse(sessionId).success && secret.length === 43
    ? sessionId
    : null;
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function refreshTokenHashMatches(
  actualHash: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(actualHash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

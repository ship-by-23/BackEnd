import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/errors.js";
import { createRequireAuth } from "./auth.middleware.js";
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from "./auth.schemas.js";
import { AuthService, type AuthenticatedSession } from "./auth.service.js";

const refreshCookieName = "simpandulu_refresh";

function validationFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !fields[field])
      fields[field] = issue.message;
  }
  return fields;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "The request could not be processed.",
      validationFields(result.error),
    );
  }
  return result.data;
}

function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.header("cookie");
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name) {
      try {
        return decodeURIComponent(valueParts.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function requireUserId(request: Request): string {
  if (!request.auth)
    throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");
  return request.auth.userId;
}

function setRefreshCookie(
  response: Response,
  token: string,
  config: AppConfig,
): void {
  response.cookie(refreshCookieName, token, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/v1/auth",
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

function clearRefreshCookie(response: Response, config: AppConfig): void {
  response.clearCookie(refreshCookieName, {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/v1/auth",
  });
}

function sessionResponse(session: AuthenticatedSession, config: AppConfig) {
  return {
    data: {
      user: session.user,
      accessToken: session.accessToken,
      tokenType: "Bearer",
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    },
  };
}

export function createAuthRouter(
  database: Database,
  config: AppConfig,
): Router {
  const router = Router();
  const authService = new AuthService(database, config);
  const requireAuth = createRequireAuth(database, config);
  const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1_000,
    limit: config.AUTH_RATE_LIMIT_MAX,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, response) => {
      response.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many authentication attempts. Try again later.",
        },
      });
    },
  });

  router.post("/auth/register", authRateLimit, async (request, response) => {
    const input = parseBody(registerSchema, request.body as unknown);
    const session = await authService.register(input);
    setRefreshCookie(response, session.refreshToken, config);
    response.status(201).json(sessionResponse(session, config));
  });

  router.post("/auth/login", authRateLimit, async (request, response) => {
    const input = parseBody(loginSchema, request.body as unknown);
    const session = await authService.login(input);
    setRefreshCookie(response, session.refreshToken, config);
    response.json(sessionResponse(session, config));
  });

  router.post("/auth/refresh", authRateLimit, async (request, response) => {
    const refreshToken = readCookie(request, refreshCookieName);
    if (!refreshToken) {
      throw new AppError(
        401,
        "INVALID_REFRESH_TOKEN",
        "The session is no longer valid.",
      );
    }
    const session = await authService.refresh(refreshToken);
    setRefreshCookie(response, session.refreshToken, config);
    response.json(sessionResponse(session, config));
  });

  router.post("/auth/logout", authRateLimit, async (request, response) => {
    await authService.logout(readCookie(request, refreshCookieName));
    clearRefreshCookie(response, config);
    response.status(204).send();
  });

  router.get("/me", requireAuth, async (request, response) => {
    const user = await authService.getProfile(requireUserId(request));
    response.json({ data: user });
  });

  router.patch("/me", requireAuth, async (request, response) => {
    const input = parseBody(updateProfileSchema, request.body as unknown);
    const user = await authService.updateProfile(requireUserId(request), input);
    response.json({ data: user });
  });

  router.put(
    "/me/password",
    authRateLimit,
    requireAuth,
    async (request, response) => {
      const input = parseBody(changePasswordSchema, request.body as unknown);
      await authService.changePassword(requireUserId(request), input);
      clearRefreshCookie(response, config);
      response.status(204).send();
    },
  );

  return router;
}

import { eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { users } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { verifyAccessToken } from "./auth.tokens.js";

const unauthenticated = () =>
  new AppError(401, "UNAUTHENTICATED", "Authentication is required.");

export function createRequireAuth(
  database: Database,
  config: AppConfig,
): RequestHandler {
  return async (request, _response, next) => {
    const authorization = request.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      next(unauthenticated());
      return;
    }

    try {
      const identity = await verifyAccessToken(authorization.slice(7), config);
      const [user] = await database
        .select({ id: users.id, role: users.role, isActive: users.isActive })
        .from(users)
        .where(eq(users.id, identity.sub))
        .limit(1);

      if (!user?.isActive) {
        next(unauthenticated());
        return;
      }

      request.auth = { userId: user.id, role: user.role };
      next();
    } catch {
      next(unauthenticated());
    }
  };
}

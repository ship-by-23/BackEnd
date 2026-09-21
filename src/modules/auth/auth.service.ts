import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { and, eq, isNull } from "drizzle-orm";
import { DatabaseError } from "pg";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { sessions, users } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
  UpdateProfileInput,
} from "./auth.schemas.js";
import {
  createRefreshToken,
  hashRefreshToken,
  refreshTokenHashMatches,
  refreshTokenSessionId,
  signAccessToken,
} from "./auth.tokens.js";

const dummyPasswordHash =
  "$2b$12$xpVAmp9hUy4gzK73FcPYhuTOrzK3QHL76a2b4L23i0O2HJDpunqLW";

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  createdAt: Date;
  updatedAt: Date;
};

export type AuthenticatedSession = {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
};

type UserRecord = typeof users.$inferSelect;

function databaseErrorCode(error: unknown): string | undefined {
  if (error instanceof DatabaseError) return error.code;
  if (error instanceof Error && error.cause)
    return databaseErrorCode(error.cause);
  return undefined;
}

function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function expiresAt(config: AppConfig): Date {
  return new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
}

export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
  ) {}

  async register(input: RegisterInput): Promise<AuthenticatedSession> {
    const passwordHash = await bcrypt.hash(
      input.password,
      this.config.BCRYPT_ROUNDS,
    );

    try {
      const result = await this.database.transaction(async (transaction) => {
        const [user] = await transaction
          .insert(users)
          .values({
            name: input.name,
            email: input.email,
            normalizedEmail: input.email,
            passwordHash,
          })
          .returning();
        if (!user) throw new Error("User insert did not return a record");

        const sessionId = randomUUID();
        const refreshToken = createRefreshToken(sessionId);
        await transaction.insert(sessions).values({
          id: sessionId,
          userId: user.id,
          refreshTokenHash: hashRefreshToken(refreshToken),
          expiresAt: expiresAt(this.config),
        });
        return { user, refreshToken };
      });

      return {
        user: toPublicUser(result.user),
        accessToken: await signAccessToken(
          { sub: result.user.id, role: result.user.role },
          this.config,
        ),
        refreshToken: result.refreshToken,
      };
    } catch (error) {
      if (databaseErrorCode(error) === "23505") {
        throw new AppError(
          409,
          "EMAIL_ALREADY_EXISTS",
          "An account with this email already exists.",
        );
      }
      throw error;
    }
  }

  async login(input: LoginInput): Promise<AuthenticatedSession> {
    const [user] = await this.database
      .select()
      .from(users)
      .where(eq(users.normalizedEmail, input.email))
      .limit(1);
    const passwordMatches = await bcrypt.compare(
      input.password,
      user?.passwordHash ?? dummyPasswordHash,
    );

    if (!user || !passwordMatches || !user.isActive) {
      throw new AppError(
        401,
        "INVALID_CREDENTIALS",
        "The email or password is incorrect.",
      );
    }

    const sessionId = randomUUID();
    const refreshToken = createRefreshToken(sessionId);
    await this.database.insert(sessions).values({
      id: sessionId,
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: expiresAt(this.config),
    });

    return {
      user: toPublicUser(user),
      accessToken: await signAccessToken(
        { sub: user.id, role: user.role },
        this.config,
      ),
      refreshToken,
    };
  }

  async refresh(refreshToken: string): Promise<AuthenticatedSession> {
    const sessionId = refreshTokenSessionId(refreshToken);
    if (!sessionId) throw this.invalidRefreshToken();
    const presentedHash = hashRefreshToken(refreshToken);

    const outcome = await this.database.transaction(async (transaction) => {
      const [record] = await transaction
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.id, sessionId))
        .for("update")
        .limit(1);

      if (
        !record ||
        !refreshTokenHashMatches(presentedHash, record.session.refreshTokenHash)
      ) {
        return { kind: "invalid" } as const;
      }

      if (record.session.revokedAt) {
        await transaction
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sessions.familyId, record.session.familyId),
              isNull(sessions.revokedAt),
            ),
          );
        return { kind: "reuse" } as const;
      }

      if (record.session.expiresAt <= new Date() || !record.user.isActive) {
        await transaction
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(sessions.familyId, record.session.familyId),
              isNull(sessions.revokedAt),
            ),
          );
        return { kind: "invalid" } as const;
      }

      const nextSessionId = randomUUID();
      const nextRefreshToken = createRefreshToken(nextSessionId);
      await transaction.insert(sessions).values({
        id: nextSessionId,
        userId: record.user.id,
        familyId: record.session.familyId,
        refreshTokenHash: hashRefreshToken(nextRefreshToken),
        expiresAt: expiresAt(this.config),
      });
      await transaction
        .update(sessions)
        .set({ revokedAt: new Date(), replacedBySessionId: nextSessionId })
        .where(eq(sessions.id, record.session.id));

      return {
        kind: "success",
        user: record.user,
        refreshToken: nextRefreshToken,
      } as const;
    });

    if (outcome.kind === "reuse") {
      throw new AppError(
        401,
        "REFRESH_TOKEN_REUSED",
        "The session is no longer valid.",
      );
    }
    if (outcome.kind === "invalid") throw this.invalidRefreshToken();

    return {
      user: toPublicUser(outcome.user),
      accessToken: await signAccessToken(
        { sub: outcome.user.id, role: outcome.user.role },
        this.config,
      ),
      refreshToken: outcome.refreshToken,
    };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const sessionId = refreshTokenSessionId(refreshToken);
    if (!sessionId) return;
    const presentedHash = hashRefreshToken(refreshToken);
    const [session] = await this.database
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (
      session &&
      refreshTokenHashMatches(presentedHash, session.refreshTokenHash)
    ) {
      await this.database
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, session.id), isNull(sessions.revokedAt)));
    }
  }

  async getProfile(userId: string): Promise<PublicUser> {
    const [user] = await this.database
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user?.isActive)
      throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");
    return toPublicUser(user);
  }

  async updateProfile(
    userId: string,
    input: UpdateProfileInput,
  ): Promise<PublicUser> {
    const [user] = await this.database
      .update(users)
      .set({ name: input.name, updatedAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.isActive, true)))
      .returning();
    if (!user)
      throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");
    return toPublicUser(user);
  }

  async changePassword(
    userId: string,
    input: ChangePasswordInput,
  ): Promise<void> {
    const [user] = await this.database
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user?.isActive)
      throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");
    const passwordMatches = await bcrypt.compare(
      input.currentPassword,
      user.passwordHash,
    );
    if (!passwordMatches) {
      throw new AppError(
        401,
        "INVALID_CURRENT_PASSWORD",
        "The current password is incorrect.",
      );
    }

    const passwordHash = await bcrypt.hash(
      input.newPassword,
      this.config.BCRYPT_ROUNDS,
    );
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await transaction
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    });
  }

  private invalidRefreshToken(): AppError {
    return new AppError(
      401,
      "INVALID_REFRESH_TOKEN",
      "The session is no longer valid.",
    );
  }
}

import { asc, count, eq } from "drizzle-orm";
import { Router, type Request } from "express";
import { DatabaseError } from "pg";
import { z } from "zod";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { adminAuditLogs, blockedDomains } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { createRequireAuth } from "../auth/auth.middleware.js";

const domainParams = z.object({ domainId: z.uuid() });
const pageQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const createDomainBody = z
  .object({
    hostname: z.string().trim().min(1).max(253),
    includeSubdomains: z.boolean().default(true),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
const updateDomainBody = z
  .object({
    hostname: z.string().trim().min(1).max(253).optional(),
    includeSubdomains: z.boolean().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !fields[field])
      fields[field] = issue.message;
  }
  throw new AppError(
    400,
    "VALIDATION_ERROR",
    "The request could not be processed.",
    fields,
  );
}

function requireAdmin(request: Request): string {
  if (!request.auth)
    throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");
  if (request.auth.role !== "admin")
    throw new AppError(403, "FORBIDDEN", "Administrator access is required.");
  return request.auth.userId;
}

function normalizeHostname(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/, "");
  if (!candidate || !/^[^\s/:?#@]+$/.test(candidate))
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "The request could not be processed.",
      {
        hostname: "Enter a hostname without a scheme, port, or path.",
      },
    );
  let url: URL;
  try {
    url = new URL(`http://${candidate}`);
  } catch {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "The request could not be processed.",
      {
        hostname: "Enter a valid hostname.",
      },
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname.length > 253 ||
    hostname
      .split(".")
      .some(
        (label) =>
          !label ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      )
  ) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "The request could not be processed.",
      {
        hostname: "Enter a valid hostname.",
      },
    );
  }
  return hostname;
}

function databaseErrorCode(error: unknown): string | undefined {
  if (error instanceof DatabaseError) return error.code;
  if (error instanceof Error && error.cause)
    return databaseErrorCode(error.cause);
  return undefined;
}

function duplicateDomain(error: unknown): never {
  if (databaseErrorCode(error) === "23505")
    throw new AppError(
      409,
      "BLOCKED_DOMAIN_ALREADY_EXISTS",
      "A rule for this hostname already exists.",
    );
  throw error;
}

export function createAdminRouter(
  database: Database,
  config: AppConfig,
): Router {
  const router = Router();
  router.use("/admin", createRequireAuth(database, config));

  router.get("/admin/blocked-domains", async (request, response) => {
    requireAdmin(request);
    const { page, pageSize } = parse(pageQuery, request.query);
    const [data, [total]] = await Promise.all([
      database
        .select()
        .from(blockedDomains)
        .orderBy(asc(blockedDomains.hostname), asc(blockedDomains.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      database.select({ value: count() }).from(blockedDomains),
    ]);
    const totalItems = total?.value ?? 0;
    response.json({
      data,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    });
  });

  router.post("/admin/blocked-domains", async (request, response) => {
    const actorUserId = requireAdmin(request);
    const input = parse(createDomainBody, request.body as unknown);
    const hostname = normalizeHostname(input.hostname);
    try {
      const domain = await database.transaction(async (transaction) => {
        const [created] = await transaction
          .insert(blockedDomains)
          .values({ ...input, hostname, createdByUserId: actorUserId })
          .returning();
        if (!created) throw new Error("Blocked domain insert returned no row");
        await transaction.insert(adminAuditLogs).values({
          actorUserId,
          action: "blocked_domain.created",
          blockedDomainId: created.id,
          hostname,
        });
        return created;
      });
      response.status(201).json({ data: domain });
    } catch (error) {
      duplicateDomain(error);
    }
  });

  router.patch(
    "/admin/blocked-domains/:domainId",
    async (request, response) => {
      const actorUserId = requireAdmin(request);
      const { domainId } = parse(domainParams, request.params as unknown);
      const input = parse(updateDomainBody, request.body as unknown);
      const hostname = input.hostname
        ? normalizeHostname(input.hostname)
        : undefined;
      try {
        const domain = await database.transaction(async (transaction) => {
          const [updated] = await transaction
            .update(blockedDomains)
            .set({
              ...(hostname && { hostname }),
              ...(input.includeSubdomains !== undefined && {
                includeSubdomains: input.includeSubdomains,
              }),
              ...(input.reason !== undefined && { reason: input.reason }),
              updatedAt: new Date(),
            })
            .where(eq(blockedDomains.id, domainId))
            .returning();
          if (!updated)
            throw new AppError(
              404,
              "BLOCKED_DOMAIN_NOT_FOUND",
              "The blocked domain was not found.",
            );
          await transaction.insert(adminAuditLogs).values({
            actorUserId,
            action: "blocked_domain.updated",
            blockedDomainId: updated.id,
            hostname: updated.hostname,
          });
          return updated;
        });
        response.json({ data: domain });
      } catch (error) {
        duplicateDomain(error);
      }
    },
  );

  router.delete(
    "/admin/blocked-domains/:domainId",
    async (request, response) => {
      const actorUserId = requireAdmin(request);
      const { domainId } = parse(domainParams, request.params as unknown);
      await database.transaction(async (transaction) => {
        const [deleted] = await transaction
          .delete(blockedDomains)
          .where(eq(blockedDomains.id, domainId))
          .returning({
            id: blockedDomains.id,
            hostname: blockedDomains.hostname,
          });
        if (!deleted)
          throw new AppError(
            404,
            "BLOCKED_DOMAIN_NOT_FOUND",
            "The blocked domain was not found.",
          );
        await transaction.insert(adminAuditLogs).values({
          actorUserId,
          action: "blocked_domain.deleted",
          blockedDomainId: deleted.id,
          hostname: deleted.hostname,
        });
      });
      response.status(204).end();
    },
  );

  return router;
}

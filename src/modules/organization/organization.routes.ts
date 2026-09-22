import { and, count, desc, eq, sql } from "drizzle-orm";
import { Router, type Request } from "express";
import { DatabaseError } from "pg";
import { z } from "zod";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { articleTags, articles, highlights, tags } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { createRequireAuth } from "../auth/auth.middleware.js";

const tagBody = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const tagParams = z.object({ tagId: z.uuid() });
const articleTagParams = z.object({ articleId: z.uuid(), tagId: z.uuid() });
const articleParams = z.object({ articleId: z.uuid() });
const highlightParams = z.object({ highlightId: z.uuid() });
const pageQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const highlightBody = z
  .object({
    quote: z.string().trim().min(1).max(10_000),
    prefix: z.string().max(500).default(""),
    suffix: z.string().max(500).default(""),
    startOffset: z.number().int().min(0).nullable().default(null),
    endOffset: z.number().int().min(0).nullable().default(null),
    note: z.string().max(10_000).nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      (value.startOffset === null && value.endOffset === null) ||
      (value.startOffset !== null &&
        value.endOffset !== null &&
        value.endOffset >= value.startOffset),
    {
      path: ["endOffset"],
      message: "Offsets must be ordered or both omitted.",
    },
  );
const updateHighlightBody = z
  .object({ note: z.string().max(10_000).nullable() })
  .strict();

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

function userId(request: Request): string {
  if (!request.auth)
    throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");
  return request.auth.userId;
}

function notFound(name: "TAG" | "ARTICLE" | "HIGHLIGHT"): AppError {
  return new AppError(
    404,
    `${name}_NOT_FOUND`,
    `The ${name.toLowerCase()} was not found.`,
  );
}

function databaseErrorCode(error: unknown): string | undefined {
  if (error instanceof DatabaseError) return error.code;
  if (error instanceof Error && error.cause)
    return databaseErrorCode(error.cause);
  return undefined;
}

function pagination(page: number, pageSize: number, totalItems: number) {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}

export function createOrganizationRouter(
  database: Database,
  config: AppConfig,
): Router {
  const router = Router();
  router.use(createRequireAuth(database, config));

  router.get("/tags", async (request, response) => {
    const { page, pageSize } = parse(pageQuery, request.query);
    const owner = userId(request);
    const [data, [total]] = await Promise.all([
      database
        .select({
          id: tags.id,
          name: tags.name,
          createdAt: tags.createdAt,
          updatedAt: tags.updatedAt,
        })
        .from(tags)
        .where(eq(tags.userId, owner))
        .orderBy(tags.normalizedName, tags.id)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      database
        .select({ value: count() })
        .from(tags)
        .where(eq(tags.userId, owner)),
    ]);
    response.json({
      data,
      pagination: pagination(page, pageSize, total?.value ?? 0),
    });
  });

  router.post("/tags", async (request, response) => {
    const { name } = parse(tagBody, request.body as unknown);
    try {
      const [tag] = await database
        .insert(tags)
        .values({
          userId: userId(request),
          name,
          normalizedName: sql`lower(${name})`,
        })
        .returning();
      response.status(201).json({ data: tag });
    } catch (error) {
      if (databaseErrorCode(error) === "23505")
        throw new AppError(
          409,
          "TAG_ALREADY_EXISTS",
          "A tag with this name already exists.",
        );
      throw error;
    }
  });

  router.patch("/tags/:tagId", async (request, response) => {
    const { tagId } = parse(tagParams, request.params as unknown);
    const { name } = parse(tagBody, request.body as unknown);
    try {
      const [tag] = await database
        .update(tags)
        .set({
          name,
          normalizedName: sql`lower(${name})`,
          updatedAt: new Date(),
        })
        .where(and(eq(tags.id, tagId), eq(tags.userId, userId(request))))
        .returning();
      if (!tag) throw notFound("TAG");
      response.json({ data: tag });
    } catch (error) {
      if (databaseErrorCode(error) === "23505")
        throw new AppError(
          409,
          "TAG_ALREADY_EXISTS",
          "A tag with this name already exists.",
        );
      throw error;
    }
  });

  router.delete("/tags/:tagId", async (request, response) => {
    const { tagId } = parse(tagParams, request.params as unknown);
    const [tag] = await database
      .delete(tags)
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId(request))))
      .returning({ id: tags.id });
    if (!tag) throw notFound("TAG");
    response.status(204).end();
  });

  router.put("/articles/:articleId/tags/:tagId", async (request, response) => {
    const { articleId, tagId } = parse(
      articleTagParams,
      request.params as unknown,
    );
    const owner = userId(request);
    const [[article], [tag]] = await Promise.all([
      database
        .select({ id: articles.id })
        .from(articles)
        .where(and(eq(articles.id, articleId), eq(articles.userId, owner)))
        .limit(1),
      database
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.id, tagId), eq(tags.userId, owner)))
        .limit(1),
    ]);
    if (!article) throw notFound("ARTICLE");
    if (!tag) throw notFound("TAG");
    await database
      .insert(articleTags)
      .values({ articleId, tagId, userId: owner })
      .onConflictDoNothing();
    response.status(204).end();
  });

  router.delete(
    "/articles/:articleId/tags/:tagId",
    async (request, response) => {
      const { articleId, tagId } = parse(
        articleTagParams,
        request.params as unknown,
      );
      const owner = userId(request);
      const [article] = await database
        .select({ id: articles.id })
        .from(articles)
        .where(and(eq(articles.id, articleId), eq(articles.userId, owner)))
        .limit(1);
      if (!article) throw notFound("ARTICLE");
      await database
        .delete(articleTags)
        .where(
          and(
            eq(articleTags.articleId, articleId),
            eq(articleTags.tagId, tagId),
            eq(articleTags.userId, owner),
          ),
        );
      response.status(204).end();
    },
  );

  async function listHighlights(
    owner: string,
    articleId: string | undefined,
    page: number,
    pageSize: number,
  ) {
    const where = articleId
      ? and(eq(highlights.userId, owner), eq(highlights.articleId, articleId))
      : eq(highlights.userId, owner);
    const [data, [total]] = await Promise.all([
      database
        .select()
        .from(highlights)
        .where(where)
        .orderBy(desc(highlights.createdAt), desc(highlights.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      database.select({ value: count() }).from(highlights).where(where),
    ]);
    return { data, pagination: pagination(page, pageSize, total?.value ?? 0) };
  }

  router.get("/highlights", async (request, response) => {
    const { page, pageSize } = parse(pageQuery, request.query);
    response.json(
      await listHighlights(userId(request), undefined, page, pageSize),
    );
  });

  router.get("/articles/:articleId/highlights", async (request, response) => {
    const { articleId } = parse(articleParams, request.params as unknown);
    const owner = userId(request);
    const [article] = await database
      .select({ id: articles.id })
      .from(articles)
      .where(and(eq(articles.id, articleId), eq(articles.userId, owner)))
      .limit(1);
    if (!article) throw notFound("ARTICLE");
    const { page, pageSize } = parse(pageQuery, request.query);
    response.json(await listHighlights(owner, articleId, page, pageSize));
  });

  router.post("/articles/:articleId/highlights", async (request, response) => {
    const { articleId } = parse(articleParams, request.params as unknown);
    const input = parse(highlightBody, request.body as unknown);
    const owner = userId(request);
    const [article] = await database
      .select({ id: articles.id })
      .from(articles)
      .where(and(eq(articles.id, articleId), eq(articles.userId, owner)))
      .limit(1);
    if (!article) throw notFound("ARTICLE");
    const [highlight] = await database
      .insert(highlights)
      .values({ userId: owner, articleId, ...input })
      .returning();
    response.status(201).json({ data: highlight });
  });

  router.patch("/highlights/:highlightId", async (request, response) => {
    const { highlightId } = parse(highlightParams, request.params as unknown);
    const { note } = parse(updateHighlightBody, request.body as unknown);
    const [highlight] = await database
      .update(highlights)
      .set({ note, updatedAt: new Date() })
      .where(
        and(
          eq(highlights.id, highlightId),
          eq(highlights.userId, userId(request)),
        ),
      )
      .returning();
    if (!highlight) throw notFound("HIGHLIGHT");
    response.json({ data: highlight });
  });

  router.delete("/highlights/:highlightId", async (request, response) => {
    const { highlightId } = parse(highlightParams, request.params as unknown);
    const [highlight] = await database
      .delete(highlights)
      .where(
        and(
          eq(highlights.id, highlightId),
          eq(highlights.userId, userId(request)),
        ),
      )
      .returning({ id: highlights.id });
    if (!highlight) throw notFound("HIGHLIGHT");
    response.status(204).end();
  });

  return router;
}

import { Router, type Request } from "express";
import { z } from "zod";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { AppError } from "../../lib/errors.js";
import { createRequireAuth } from "../auth/auth.middleware.js";
import { ArticleService } from "./article.service.js";

const createArticleSchema = z
  .object({
    url: z.string().trim().min(1).max(2_048),
    tagIds: z.array(z.uuid()).max(20).default([]),
  })
  .strict()
  .refine((value) => new Set(value.tagIds).size === value.tagIds.length, {
    message: "Tag IDs must be unique.",
    path: ["tagIds"],
  });

const articleParamsSchema = z.object({ articleId: z.uuid() });
const updateArticleSchema = z
  .object({
    readingStatus: z.enum(["unread", "reading", "finished"]).optional(),
    isFavorite: z.boolean().optional(),
    isArchived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required.",
  );
const progressSchema = z
  .object({
    progress: z.number().int().min(0).max(100),
    anchor: z.string().max(2_048).nullable().optional(),
  })
  .strict();

const listArticlesSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(["unread", "reading", "finished"]).optional(),
    tagId: z.uuid().optional(),
    favorite: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .default(false),
    sort: z
      .enum(["createdAt", "updatedAt", "title", "readingProgress"])
      .optional(),
    order: z.enum(["asc", "desc"]).default("desc"),
    query: z.string().trim().max(200).optional(),
  })
  .strict();

type Article = Awaited<ReturnType<ArticleService["get"]>>;

function articleDetail(article: Article) {
  return {
    id: article.id,
    submittedUrl: article.submittedUrl,
    canonicalUrl: article.canonicalUrl,
    title: article.title,
    description: article.description,
    siteName: article.siteName,
    author: article.author,
    publishedAt: article.publishedAt,
    imageUrl: article.imageUrl,
    contentHtml: article.contentHtml,
    contentText: article.contentText,
    wordCount: article.wordCount,
    estimatedReadingMinutes: article.estimatedReadingMinutes,
    readingStatus: article.readingStatus,
    readingProgress: article.readingProgress,
    readingAnchor: article.readingAnchor,
    isFavorite: article.isFavorite,
    isArchived: article.isArchived,
    extractionStatus: article.extractionStatus,
    extractionErrorCode: article.extractionErrorCode,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    finishedAt: article.finishedAt,
  };
}

function requireUserId(request: Request): string {
  if (!request.auth)
    throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");
  return request.auth.userId;
}

function validationError(error: z.ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !fields[field])
      fields[field] = issue.message;
  }
  return new AppError(
    400,
    "VALIDATION_ERROR",
    "The request could not be processed.",
    fields,
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export function createArticleRouter(
  database: Database,
  config: AppConfig,
  scheduleExtraction?: () => void,
): Router {
  const router = Router();
  const service = new ArticleService(database, config.NODE_ENV === "test");
  router.use(createRequireAuth(database, config));

  router.post("/articles", async (request, response) => {
    const input = parse(createArticleSchema, request.body as unknown);
    const result = await service.create(requireUserId(request), input);
    response.status(result.created ? 202 : 200).json({
      data: {
        id: result.article.id,
        submittedUrl: result.article.submittedUrl,
        extractionStatus: result.article.extractionStatus,
        extractionErrorCode: result.article.extractionErrorCode,
      },
    });
    if (result.created) scheduleExtraction?.();
  });

  router.get("/articles", async (request, response) => {
    const input = parse(listArticlesSchema, request.query);
    response.json(await service.list(requireUserId(request), input));
  });

  router.get("/articles/:articleId", async (request, response) => {
    const { articleId } = parse(articleParamsSchema, request.params as unknown);
    const article = await service.get(requireUserId(request), articleId);
    response.json({ data: articleDetail(article) });
    if (
      article.extractionStatus === "pending" ||
      article.extractionStatus === "processing"
    ) {
      scheduleExtraction?.();
    }
  });

  router.patch("/articles/:articleId", async (request, response) => {
    const { articleId } = parse(articleParamsSchema, request.params as unknown);
    const input = parse(updateArticleSchema, request.body as unknown);
    const article = await service.update(
      requireUserId(request),
      articleId,
      input,
    );
    response.json({ data: articleDetail(article) });
  });

  router.put("/articles/:articleId/progress", async (request, response) => {
    const { articleId } = parse(articleParamsSchema, request.params as unknown);
    const input = parse(progressSchema, request.body as unknown);
    const article = await service.updateProgress(
      requireUserId(request),
      articleId,
      input,
    );
    response.json({ data: articleDetail(article) });
  });

  router.delete("/articles/:articleId", async (request, response) => {
    const { articleId } = parse(articleParamsSchema, request.params as unknown);
    await service.delete(requireUserId(request), articleId);
    response.status(204).end();
  });

  router.post("/articles/:articleId/retry", async (request, response) => {
    const { articleId } = parse(articleParamsSchema, request.params as unknown);
    const article = await service.retry(requireUserId(request), articleId);
    response.status(202).json({
      data: {
        id: article.id,
        extractionStatus: article.extractionStatus,
        extractionErrorCode: article.extractionErrorCode,
      },
    });
    scheduleExtraction?.();
  });

  return router;
}

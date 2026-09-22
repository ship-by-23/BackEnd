import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { DatabaseError } from "pg";
import type { Database } from "../../db/client.js";
import {
  articleTags,
  articles,
  extractionJobs,
  tags,
} from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { ExtractionError } from "../extraction/extraction.errors.js";
import { normalizeArticleUrl } from "../extraction/url-policy.js";

export type CreateArticleInput = {
  url: string;
  tagIds: string[];
};

export type ListArticlesInput = {
  page: number;
  pageSize: number;
  status?: "unread" | "reading" | "finished" | undefined;
  tagId?: string | undefined;
  favorite?: boolean | undefined;
  archived: boolean;
  sort: "createdAt" | "updatedAt" | "title" | "readingProgress";
  order: "asc" | "desc";
};

export type UpdateArticleInput = {
  readingStatus?: "unread" | "reading" | "finished" | undefined;
  isFavorite?: boolean | undefined;
  isArchived?: boolean | undefined;
};

export type UpdateProgressInput = {
  progress: number;
  anchor?: string | null | undefined;
};

const articleSummary = {
  id: articles.id,
  submittedUrl: articles.submittedUrl,
  canonicalUrl: articles.canonicalUrl,
  title: articles.title,
  description: articles.description,
  siteName: articles.siteName,
  author: articles.author,
  publishedAt: articles.publishedAt,
  imageUrl: articles.imageUrl,
  wordCount: articles.wordCount,
  estimatedReadingMinutes: articles.estimatedReadingMinutes,
  readingStatus: articles.readingStatus,
  readingProgress: articles.readingProgress,
  isFavorite: articles.isFavorite,
  isArchived: articles.isArchived,
  extractionStatus: articles.extractionStatus,
  extractionErrorCode: articles.extractionErrorCode,
  createdAt: articles.createdAt,
  updatedAt: articles.updatedAt,
  finishedAt: articles.finishedAt,
};

function databaseErrorCode(error: unknown): string | undefined {
  if (error instanceof DatabaseError) return error.code;
  if (error instanceof Error && error.cause)
    return databaseErrorCode(error.cause);
  return undefined;
}

export class ArticleService {
  constructor(
    private readonly database: Database,
    private readonly allowNonStandardPorts = false,
  ) {}

  async list(userId: string, input: ListArticlesInput) {
    const conditions: SQL[] = [
      eq(articles.userId, userId),
      eq(articles.isArchived, input.archived),
    ];
    if (input.status) conditions.push(eq(articles.readingStatus, input.status));
    if (input.favorite !== undefined)
      conditions.push(eq(articles.isFavorite, input.favorite));
    if (input.tagId)
      conditions.push(
        exists(
          this.database
            .select({ id: articleTags.articleId })
            .from(articleTags)
            .where(
              and(
                eq(articleTags.articleId, articles.id),
                eq(articleTags.userId, userId),
                eq(articleTags.tagId, input.tagId),
              ),
            ),
        ),
      );

    const where = and(...conditions);
    const sortColumn = articles[input.sort];
    const sort = input.order === "asc" ? asc : desc;
    const [items, [total]] = await Promise.all([
      this.database
        .select(articleSummary)
        .from(articles)
        .where(where)
        .orderBy(sort(sortColumn), desc(articles.id))
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize),
      this.database.select({ value: count() }).from(articles).where(where),
    ]);
    const totalItems = total?.value ?? 0;
    return {
      data: items,
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / input.pageSize),
      },
    };
  }

  async create(userId: string, input: CreateArticleInput) {
    let url: URL;
    try {
      url = normalizeArticleUrl(input.url, this.allowNonStandardPorts);
    } catch (error) {
      if (error instanceof ExtractionError) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "The request could not be processed.",
          {
            url: error.message,
          },
        );
      }
      throw error;
    }
    const normalizedUrl = url.toString();

    const [existing] = await this.database
      .select()
      .from(articles)
      .where(
        and(
          eq(articles.userId, userId),
          eq(articles.normalizedUrl, normalizedUrl),
        ),
      )
      .limit(1);
    if (existing) return { article: existing, created: false };

    if (input.tagIds.length > 0) {
      const ownedTags = await this.database
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.userId, userId), inArray(tags.id, input.tagIds)));
      if (ownedTags.length !== input.tagIds.length) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "The request could not be processed.",
          {
            tagIds: "One or more tags do not exist.",
          },
        );
      }
    }

    try {
      const article = await this.database.transaction(async (transaction) => {
        const [created] = await transaction
          .insert(articles)
          .values({ userId, submittedUrl: input.url, normalizedUrl })
          .returning();
        if (!created) throw new Error("Article insert did not return a record");
        await transaction
          .insert(extractionJobs)
          .values({ articleId: created.id });
        if (input.tagIds.length > 0) {
          await transaction.insert(articleTags).values(
            input.tagIds.map((tagId) => ({
              articleId: created.id,
              tagId,
              userId,
            })),
          );
        }
        return created;
      });
      return { article, created: true };
    } catch (error) {
      if (databaseErrorCode(error) === "23505") {
        const [concurrent] = await this.database
          .select()
          .from(articles)
          .where(
            and(
              eq(articles.userId, userId),
              eq(articles.normalizedUrl, normalizedUrl),
            ),
          )
          .limit(1);
        if (concurrent) return { article: concurrent, created: false };
      }
      throw error;
    }
  }

  async get(userId: string, articleId: string) {
    const [article] = await this.database
      .select()
      .from(articles)
      .where(and(eq(articles.id, articleId), eq(articles.userId, userId)))
      .limit(1);
    if (!article)
      throw new AppError(
        404,
        "ARTICLE_NOT_FOUND",
        "The article was not found.",
      );
    return article;
  }

  async update(userId: string, articleId: string, input: UpdateArticleInput) {
    const [article] = await this.database
      .update(articles)
      .set({
        ...(input.isFavorite !== undefined && { isFavorite: input.isFavorite }),
        ...(input.isArchived !== undefined && { isArchived: input.isArchived }),
        ...(input.readingStatus && {
          readingStatus: input.readingStatus,
          readingProgress:
            input.readingStatus === "finished"
              ? 100
              : input.readingStatus === "unread"
                ? 0
                : sql`least(${articles.readingProgress}, 99)`,
          finishedAt:
            input.readingStatus === "finished"
              ? sql`coalesce(${articles.finishedAt}, now())`
              : null,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(articles.id, articleId), eq(articles.userId, userId)))
      .returning();
    if (!article)
      throw new AppError(
        404,
        "ARTICLE_NOT_FOUND",
        "The article was not found.",
      );
    return article;
  }

  async updateProgress(
    userId: string,
    articleId: string,
    input: UpdateProgressInput,
  ) {
    const [article] = await this.database
      .update(articles)
      .set({
        readingProgress: input.progress,
        readingStatus: input.progress === 100 ? "finished" : "reading",
        finishedAt:
          input.progress === 100
            ? sql`coalesce(${articles.finishedAt}, now())`
            : null,
        ...(input.anchor !== undefined && { readingAnchor: input.anchor }),
        updatedAt: new Date(),
      })
      .where(and(eq(articles.id, articleId), eq(articles.userId, userId)))
      .returning();
    if (!article)
      throw new AppError(
        404,
        "ARTICLE_NOT_FOUND",
        "The article was not found.",
      );
    return article;
  }

  async delete(userId: string, articleId: string) {
    const [article] = await this.database
      .delete(articles)
      .where(and(eq(articles.id, articleId), eq(articles.userId, userId)))
      .returning({ id: articles.id });
    if (!article)
      throw new AppError(
        404,
        "ARTICLE_NOT_FOUND",
        "The article was not found.",
      );
  }

  async retry(userId: string, articleId: string) {
    return this.database.transaction(async (transaction) => {
      const [article] = await transaction
        .select()
        .from(articles)
        .where(and(eq(articles.id, articleId), eq(articles.userId, userId)))
        .for("update")
        .limit(1);
      if (!article)
        throw new AppError(
          404,
          "ARTICLE_NOT_FOUND",
          "The article was not found.",
        );
      if (article.extractionStatus !== "failed") {
        throw new AppError(
          409,
          "ARTICLE_NOT_RETRYABLE",
          "Only failed extractions can be retried.",
        );
      }

      const [updated] = await transaction
        .update(articles)
        .set({
          extractionStatus: "pending",
          extractionErrorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(articles.id, article.id))
        .returning();
      await transaction
        .update(extractionJobs)
        .set({
          status: "pending",
          errorCode: null,
          scheduledAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(extractionJobs.articleId, article.id));
      if (!updated)
        throw new Error("Article retry update did not return a record");
      return updated;
    });
  }
}

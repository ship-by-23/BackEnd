import { and, eq, inArray } from "drizzle-orm";
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

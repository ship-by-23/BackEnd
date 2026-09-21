import type { Pool } from "pg";
import type { ExtractedArticle } from "./article-extractor.js";
import type { ExtractionErrorCode } from "./extraction.errors.js";

export type ClaimedExtractionJob = {
  id: string;
  articleId: string;
  submittedUrl: string;
  attempts: number;
};

export class ExtractionRepository {
  constructor(
    private readonly pool: Pool,
    private readonly workerId: string,
    private readonly staleLockMs: number,
  ) {}

  async claim(): Promise<ClaimedExtractionJob | null> {
    const result = await this.pool.query<{
      id: string;
      article_id: string;
      submitted_url: string;
      attempts: number;
    }>(
      `with claimable as (
        select jobs.id
        from extraction_jobs jobs
        where
          (jobs.status = 'pending' and jobs.scheduled_at <= now())
          or
          (jobs.status = 'processing' and jobs.locked_at < now() - ($1 * interval '1 millisecond'))
        order by jobs.scheduled_at, jobs.id
        for update skip locked
        limit 1
      ), claimed as (
        update extraction_jobs jobs
        set status = 'processing', attempts = jobs.attempts + 1, locked_at = now(),
            locked_by = $2, updated_at = now(), error_code = null
        from claimable
        where jobs.id = claimable.id
        returning jobs.id, jobs.article_id, jobs.attempts
      )
      update articles
      set extraction_status = 'processing', extraction_error_code = null, updated_at = now()
      from claimed
      where articles.id = claimed.article_id
      returning claimed.id, claimed.article_id, articles.submitted_url, claimed.attempts`,
      [this.staleLockMs, this.workerId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          articleId: row.article_id,
          submittedUrl: row.submitted_url,
          attempts: row.attempts,
        }
      : null;
  }

  async complete(
    job: ClaimedExtractionJob,
    article: ExtractedArticle,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const ownership = await client.query(
        "select id from extraction_jobs where id = $1 and locked_by = $2 and status = 'processing' for update",
        [job.id, this.workerId],
      );
      if (ownership.rowCount !== 1)
        throw new Error("Extraction job claim was lost");
      await client.query(
        `update articles
         set canonical_url = $1, title = $2, description = $3, site_name = $4,
             author = $5, published_at = $6, image_url = $7, content_html = $8,
             content_text = $9, word_count = $10, estimated_reading_minutes = $11,
             extraction_status = 'completed', extraction_error_code = null,
             search_vector =
               setweight(to_tsvector('simple', coalesce($2, '')), 'A') ||
               setweight(to_tsvector('simple', coalesce($3, '')), 'B') ||
               setweight(to_tsvector('simple', coalesce($9, '')), 'C'),
             updated_at = now()
         where id = $12`,
        [
          article.canonicalUrl,
          article.title,
          article.description,
          article.siteName,
          article.author,
          article.publishedAt,
          article.imageUrl,
          article.contentHtml,
          article.contentText,
          article.wordCount,
          article.estimatedReadingMinutes,
          job.articleId,
        ],
      );
      await client.query(
        `update extraction_jobs
         set status = 'completed', completed_at = now(), locked_at = null,
             locked_by = null, error_code = null, updated_at = now()
         where id = $1 and locked_by = $2`,
        [job.id, this.workerId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async fail(
    job: ClaimedExtractionJob,
    code: ExtractionErrorCode,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const ownership = await client.query(
        "select id from extraction_jobs where id = $1 and locked_by = $2 and status = 'processing' for update",
        [job.id, this.workerId],
      );
      if (ownership.rowCount !== 1)
        throw new Error("Extraction job claim was lost");
      await client.query(
        `update articles
         set extraction_status = 'failed', extraction_error_code = $1, updated_at = now()
         where id = $2`,
        [code, job.articleId],
      );
      await client.query(
        `update extraction_jobs
         set status = 'failed', error_code = $1, locked_at = null,
             locked_by = null, completed_at = now(), updated_at = now()
         where id = $2 and locked_by = $3`,
        [code, job.id, this.workerId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

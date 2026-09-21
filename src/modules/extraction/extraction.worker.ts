import type { Logger } from "pino";
import { extractArticle } from "./article-extractor.js";
import type { ArticleFetcher } from "./article-fetcher.js";
import { ExtractionError } from "./extraction.errors.js";
import type { ExtractionRepository } from "./extraction.repository.js";

export class ExtractionWorker {
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private processing: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: ExtractionRepository,
    private readonly fetcher: ArticleFetcher,
    private readonly logger: Logger,
    private readonly pollIntervalMs: number,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.processing;
  }

  async processNext(): Promise<boolean> {
    const job = await this.repository.claim();
    if (!job) return false;

    try {
      const page = await this.fetcher.fetch(new URL(job.submittedUrl));
      const article = extractArticle(page.html, page.finalUrl);
      await this.repository.complete(job, article);
      this.logger.info(
        { articleId: job.articleId, attempts: job.attempts },
        "Article extraction completed",
      );
    } catch (error) {
      const code =
        error instanceof ExtractionError ? error.code : "EXTRACTION_FAILED";
      await this.repository.fail(job, code);
      this.logger.warn(
        { articleId: job.articleId, code, attempts: job.attempts },
        "Article extraction failed",
      );
    }
    return true;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.processing = this.processNext()
        .catch((error: unknown) => {
          this.logger.error(
            { err: error },
            "Extraction worker iteration failed",
          );
          return false;
        })
        .then((processed) => {
          if (!this.stopped) this.schedule(processed ? 0 : this.pollIntervalMs);
        });
    }, delay);
    this.timer.unref();
  }
}

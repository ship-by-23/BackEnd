import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Pool } from "pg";
import { createApiRouter } from "./api.js";
import { createApp } from "./app.js";
import { parseEnvironment } from "./config/env.js";
import { createDatabase } from "./db/client.js";
import { createLogger } from "./lib/logger.js";
import { ArticleFetcher } from "./modules/extraction/article-fetcher.js";
import { ExtractionRepository } from "./modules/extraction/extraction.repository.js";
import { ExtractionWorker } from "./modules/extraction/extraction.worker.js";
import { createDestinationPolicy } from "./modules/extraction/url-policy.js";

export function createRuntime(
  scheduleExtraction?: (worker: ExtractionWorker) => void,
) {
  const config = parseEnvironment(process.env);
  const logger = createLogger(config);
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_MAX_CONNECTIONS,
  });
  const database = createDatabase(pool);
  const extractionWorker = new ExtractionWorker(
    new ExtractionRepository(
      pool,
      `${hostname()}-${randomUUID()}`,
      config.EXTRACTION_STALE_LOCK_MS,
    ),
    new ArticleFetcher(config, createDestinationPolicy(database)),
    logger,
    config.EXTRACTION_POLL_INTERVAL_MS,
  );
  const app = createApp({
    config,
    logger,
    apiRouter: createApiRouter(
      database,
      config,
      scheduleExtraction
        ? () => scheduleExtraction(extractionWorker)
        : undefined,
    ),
    checkDatabase: async () => {
      await pool.query("select 1");
    },
  });

  return { app, config, logger, pool, extractionWorker };
}

import "dotenv/config";
import { attachDatabasePool, waitUntil } from "@vercel/functions";
import { createRuntime } from "../dist/runtime.js";

const { app, logger, pool } = createRuntime((worker) => {
  /** @param {unknown} error */
  const logError = (error) => {
    logger.error({ err: error }, "Request-scoped extraction failed");
  };
  waitUntil(worker.processNext().catch(logError));
});

attachDatabasePool(pool);

export default app;

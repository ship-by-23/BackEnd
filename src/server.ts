import "dotenv/config";
import { createServer } from "node:http";
import { createRuntime } from "./runtime.js";

const { app, config, logger, pool, extractionWorker } = createRuntime();
const server = createServer(app);

server.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "SimpanDulu API listening");
  extractionWorker.start();
});

let shuttingDown = false;

async function closeServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out");
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await Promise.all([closeServer(), extractionWorker.stop()]);
    await pool.end();
  } catch (error) {
    logger.error({ err: error }, "Graceful shutdown failed");
    process.exitCode = 1;
  } finally {
    clearTimeout(forceExit);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

import "dotenv/config";
import { createServer } from "node:http";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { parseEnvironment } from "./config/env.js";
import { createDatabase } from "./db/client.js";
import { createLogger } from "./lib/logger.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";

const config = parseEnvironment(process.env);
const logger = createLogger(config);
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_MAX_CONNECTIONS,
});

const database = createDatabase(pool);

const app = createApp({
  config,
  logger,
  apiRouter: createAuthRouter(database, config),
  checkDatabase: async () => {
    await pool.query("select 1");
  },
});
const server = createServer(app);

server.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "SimpanDulu API listening");
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
    await closeServer();
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

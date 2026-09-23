import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Express, type Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { AppConfig } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";

export type AppDependencies = {
  config: AppConfig;
  logger: Logger;
  checkDatabase: () => Promise<void>;
  apiRouter?: Router;
};

export function createApp({
  config,
  logger,
  checkDatabase,
  apiRouter,
}: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    pinoHttp({
      logger,
      wrapSerializers: false,
      serializers: {
        req: (request: {
          id?: string | number | object;
          method?: string;
          url?: string;
        }) => ({
          id: request.id,
          method: request.method,
          path: request.url?.split("?", 1)[0],
        }),
        res: (response: { statusCode?: number }) => ({
          statusCode: response.statusCode,
        }),
        err: (error: Error & { code?: string }) => ({
          type: error.name,
          code: error.code,
        }),
      },
      genReqId(request, response) {
        const incomingId = request.headers["x-request-id"];
        const requestId =
          typeof incomingId === "string" && incomingId.length <= 128
            ? incomingId
            : randomUUID();
        response.setHeader("x-request-id", requestId);
        return requestId;
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "100kb" }));

  app.get("/health/live", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/health/ready", async (_request, response) => {
    try {
      await checkDatabase();
      response.json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });

  if (apiRouter) app.use("/api/v1", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { apiReference } from "@scalar/express-api-reference";
import cors from "cors";
import express, {
  type Express,
  type Request,
  type Response,
  type Router,
} from "express";
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

  app.get("/openapi.yaml", (_request, response) => {
    response
      .type("application/yaml")
      .sendFile(
        fileURLToPath(new URL("../docs/openapi.yaml", import.meta.url)),
      );
  });

  app.get("/docs", (request, response, next) => {
    const nonce = randomBytes(16).toString("base64");
    response.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net`,
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    apiReference({
      url: "/openapi.yaml",
      cdn: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.71.0",
      nonce,
      withDefaultFonts: false,
    })(request as Request<never>, response as Response<string>, next);
  });

  if (apiRouter) app.use("/api/v1", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

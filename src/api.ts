import { Router } from "express";
import type { AppConfig } from "./config/env.js";
import type { Database } from "./db/client.js";
import { createArticleRouter } from "./modules/articles/article.routes.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { createOrganizationRouter } from "./modules/organization/organization.routes.js";

export function createApiRouter(database: Database, config: AppConfig): Router {
  const router = Router();
  router.use(createAuthRouter(database, config));
  router.use(createArticleRouter(database, config));
  router.use(createOrganizationRouter(database, config));
  return router;
}

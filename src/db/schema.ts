import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const userRole = pgEnum("user_role", ["user", "admin"]);
export const readingStatus = pgEnum("reading_status", [
  "unread",
  "reading",
  "finished",
]);
export const extractionStatus = pgEnum("extraction_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);
export const extractionErrorCode = pgEnum("extraction_error_code", [
  "URL_BLOCKED",
  "FETCH_TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "UNSUPPORTED_CONTENT",
  "EXTRACTION_FAILED",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    role: userRole("role").notNull().default("user"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique("users_normalized_email_unique").on(table.normalizedEmail),
    check(
      "users_email_normalized",
      sql`${table.normalizedEmail} = lower(trim(${table.email}))`,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull().defaultRandom(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedBySessionId: uuid("replaced_by_session_id").references(
      (): AnyPgColumn => sessions.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("sessions_refresh_token_hash_unique").on(table.refreshTokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_family_id_idx").on(table.familyId),
    index("sessions_active_expiry_idx")
      .on(table.userId, table.expiresAt)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export const articles = pgTable(
  "articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    submittedUrl: text("submitted_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    canonicalUrl: text("canonical_url"),
    title: text("title"),
    description: text("description"),
    siteName: text("site_name"),
    author: text("author"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    imageUrl: text("image_url"),
    contentHtml: text("content_html"),
    contentText: text("content_text"),
    wordCount: integer("word_count"),
    estimatedReadingMinutes: integer("estimated_reading_minutes"),
    readingStatus: readingStatus("reading_status").notNull().default("unread"),
    readingProgress: integer("reading_progress").notNull().default(0),
    readingAnchor: text("reading_anchor"),
    isFavorite: boolean("is_favorite").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    extractionStatus: extractionStatus("extraction_status")
      .notNull()
      .default("pending"),
    extractionErrorCode: extractionErrorCode("extraction_error_code"),
    searchVector: tsvector("search_vector")
      .notNull()
      .default(sql`''::tsvector`),
    ...timestamps,
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique("articles_id_user_id_unique").on(table.id, table.userId),
    unique("articles_user_normalized_url_unique").on(
      table.userId,
      table.normalizedUrl,
    ),
    uniqueIndex("articles_user_canonical_url_unique")
      .on(table.userId, table.canonicalUrl)
      .where(sql`${table.canonicalUrl} is not null`),
    index("articles_library_filter_idx").on(
      table.userId,
      table.isArchived,
      table.readingStatus,
      table.createdAt,
    ),
    index("articles_user_favorite_idx").on(table.userId, table.isFavorite),
    index("articles_search_vector_idx").using("gin", table.searchVector),
    check(
      "articles_reading_progress_range",
      sql`${table.readingProgress} between 0 and 100`,
    ),
    check(
      "articles_word_count_nonnegative",
      sql`${table.wordCount} is null or ${table.wordCount} >= 0`,
    ),
    check(
      "articles_reading_minutes_nonnegative",
      sql`${table.estimatedReadingMinutes} is null or ${table.estimatedReadingMinutes} >= 0`,
    ),
  ],
);

export const extractionJobs = pgTable(
  "extraction_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    status: extractionStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: extractionErrorCode("error_code"),
    ...timestamps,
  },
  (table) => [
    unique("extraction_jobs_article_id_unique").on(table.articleId),
    index("extraction_jobs_claim_idx").on(
      table.status,
      table.scheduledAt,
      table.lockedAt,
    ),
    check("extraction_jobs_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("tags_id_user_id_unique").on(table.id, table.userId),
    unique("tags_user_normalized_name_unique").on(
      table.userId,
      table.normalizedName,
    ),
    check(
      "tags_name_normalized",
      sql`${table.normalizedName} = lower(trim(${table.name}))`,
    ),
    index("tags_user_name_idx").on(table.userId, table.normalizedName),
  ],
);

export const articleTags = pgTable(
  "article_tags",
  {
    articleId: uuid("article_id").notNull(),
    tagId: uuid("tag_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.tagId] }),
    foreignKey({
      name: "article_tags_article_owner_fk",
      columns: [table.articleId, table.userId],
      foreignColumns: [articles.id, articles.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "article_tags_tag_owner_fk",
      columns: [table.tagId, table.userId],
      foreignColumns: [tags.id, tags.userId],
    }).onDelete("cascade"),
    index("article_tags_user_tag_idx").on(table.userId, table.tagId),
  ],
);

export const highlights = pgTable(
  "highlights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    articleId: uuid("article_id").notNull(),
    quote: text("quote").notNull(),
    prefix: text("prefix").notNull().default(""),
    suffix: text("suffix").notNull().default(""),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    note: text("note"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      name: "highlights_article_owner_fk",
      columns: [table.articleId, table.userId],
      foreignColumns: [articles.id, articles.userId],
    }).onDelete("cascade"),
    index("highlights_user_created_at_idx").on(table.userId, table.createdAt),
    index("highlights_article_id_idx").on(table.articleId),
    check(
      "highlights_offsets_valid",
      sql`(${table.startOffset} is null and ${table.endOffset} is null) or (${table.startOffset} >= 0 and ${table.endOffset} >= ${table.startOffset})`,
    ),
  ],
);

export const blockedDomains = pgTable(
  "blocked_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostname: text("hostname").notNull(),
    includeSubdomains: boolean("include_subdomains").notNull().default(true),
    reason: text("reason").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    unique("blocked_domains_hostname_unique").on(table.hostname),
    check(
      "blocked_domains_hostname_normalized",
      sql`${table.hostname} = lower(trim(${table.hostname}))`,
    ),
  ],
);

export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    blockedDomainId: uuid("blocked_domain_id"),
    hostname: text("hostname").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "admin_audit_logs_action_valid",
      sql`${table.action} in ('blocked_domain.created', 'blocked_domain.updated', 'blocked_domain.deleted')`,
    ),
    index("admin_audit_logs_actor_created_at_idx").on(
      table.actorUserId,
      table.createdAt,
    ),
  ],
);

CREATE TYPE "public"."extraction_error_code" AS ENUM('URL_BLOCKED', 'FETCH_TIMEOUT', 'RESPONSE_TOO_LARGE', 'UNSUPPORTED_CONTENT', 'EXTRACTION_FAILED');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reading_status" AS ENUM('unread', 'reading', 'finished');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "article_tags" (
	"article_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_tags_article_id_tag_id_pk" PRIMARY KEY("article_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"submitted_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"canonical_url" text,
	"title" text,
	"description" text,
	"site_name" text,
	"author" text,
	"published_at" timestamp with time zone,
	"image_url" text,
	"content_html" text,
	"content_text" text,
	"word_count" integer,
	"estimated_reading_minutes" integer,
	"reading_status" "reading_status" DEFAULT 'unread' NOT NULL,
	"reading_progress" integer DEFAULT 0 NOT NULL,
	"reading_anchor" text,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"extraction_status" "extraction_status" DEFAULT 'pending' NOT NULL,
	"extraction_error_code" "extraction_error_code",
	"search_vector" "tsvector" DEFAULT ''::tsvector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "articles_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "articles_user_normalized_url_unique" UNIQUE("user_id","normalized_url"),
	CONSTRAINT "articles_reading_progress_range" CHECK ("articles"."reading_progress" between 0 and 100),
	CONSTRAINT "articles_word_count_nonnegative" CHECK ("articles"."word_count" is null or "articles"."word_count" >= 0),
	CONSTRAINT "articles_reading_minutes_nonnegative" CHECK ("articles"."estimated_reading_minutes" is null or "articles"."estimated_reading_minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "blocked_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hostname" text NOT NULL,
	"include_subdomains" boolean DEFAULT true NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_domains_hostname_unique" UNIQUE("hostname"),
	CONSTRAINT "blocked_domains_hostname_normalized" CHECK ("blocked_domains"."hostname" = lower(trim("blocked_domains"."hostname")))
);
--> statement-breakpoint
CREATE TABLE "extraction_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"status" "extraction_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"completed_at" timestamp with time zone,
	"error_code" "extraction_error_code",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_jobs_article_id_unique" UNIQUE("article_id"),
	CONSTRAINT "extraction_jobs_attempts_nonnegative" CHECK ("extraction_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "highlights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"quote" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"suffix" text DEFAULT '' NOT NULL,
	"start_offset" integer,
	"end_offset" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "highlights_offsets_valid" CHECK (("highlights"."start_offset" is null and "highlights"."end_offset" is null) or ("highlights"."start_offset" >= 0 and "highlights"."end_offset" >= "highlights"."start_offset"))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_id_user_id_unique" UNIQUE("id","user_id"),
	CONSTRAINT "tags_user_normalized_name_unique" UNIQUE("user_id","normalized_name"),
	CONSTRAINT "tags_name_normalized" CHECK ("tags"."normalized_name" = lower(trim("tags"."name")))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_normalized_email_unique" UNIQUE("normalized_email"),
	CONSTRAINT "users_email_normalized" CHECK ("users"."normalized_email" = lower(trim("users"."email")))
);
--> statement-breakpoint
ALTER TABLE "article_tags" ADD CONSTRAINT "article_tags_article_owner_fk" FOREIGN KEY ("article_id","user_id") REFERENCES "public"."articles"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_tags" ADD CONSTRAINT "article_tags_tag_owner_fk" FOREIGN KEY ("tag_id","user_id") REFERENCES "public"."tags"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_domains" ADD CONSTRAINT "blocked_domains_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_article_owner_fk" FOREIGN KEY ("article_id","user_id") REFERENCES "public"."articles"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_replaced_by_session_id_sessions_id_fk" FOREIGN KEY ("replaced_by_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_tags_user_tag_idx" ON "article_tags" USING btree ("user_id","tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_user_canonical_url_unique" ON "articles" USING btree ("user_id","canonical_url") WHERE "articles"."canonical_url" is not null;--> statement-breakpoint
CREATE INDEX "articles_library_filter_idx" ON "articles" USING btree ("user_id","is_archived","reading_status","created_at");--> statement-breakpoint
CREATE INDEX "articles_user_favorite_idx" ON "articles" USING btree ("user_id","is_favorite");--> statement-breakpoint
CREATE INDEX "articles_search_vector_idx" ON "articles" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "extraction_jobs_claim_idx" ON "extraction_jobs" USING btree ("status","scheduled_at","locked_at");--> statement-breakpoint
CREATE INDEX "highlights_user_created_at_idx" ON "highlights" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "highlights_article_id_idx" ON "highlights" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_id_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sessions_active_expiry_idx" ON "sessions" USING btree ("user_id","expires_at") WHERE "sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "tags_user_name_idx" ON "tags" USING btree ("user_id","normalized_name");
import "dotenv/config";
import bcrypt from "bcrypt";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { z } from "zod";
import { createDatabase } from "./client.js";
import { articles, users } from "./schema.js";

const environment = z
  .object({
    NODE_ENV: z.enum(["development", "test"]),
    DATABASE_URL: z.string().min(1),
    DEMO_USER_PASSWORD: z.string().min(8).max(72),
  })
  .parse(process.env);

const demoUserId = "00000000-0000-4000-8000-000000000001";
const demoEmail = "demo@example.test";
const timestamp = new Date("2026-01-01T00:00:00.000Z");
const samples = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    url: "https://example.com/simpandulu-demo/study-notes",
    title: "Organizing study notes",
    description: "A short guide to keeping useful research close at hand.",
    text: "Good study notes capture the central idea in your own words. Add a source link, highlight useful passages, and return to them while reviewing.",
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    url: "https://example.com/simpandulu-demo/reading-habit",
    title: "Building a reading habit",
    description: "Practical ways to finish and revisit saved articles.",
    text: "Set aside a small reading window. Save articles that matter, track progress, and archive finished pieces so the library stays useful.",
  },
] as const;

const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 1 });
const database = createDatabase(pool);

try {
  const passwordHash = await bcrypt.hash(environment.DEMO_USER_PASSWORD, 12);
  await database.transaction(async (transaction) => {
    await transaction
      .insert(users)
      .values({
        id: demoUserId,
        email: demoEmail,
        normalizedEmail: demoEmail,
        passwordHash,
        name: "Demo Reader",
        role: "user",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoNothing({ target: users.id });

    for (const sample of samples) {
      await transaction
        .insert(articles)
        .values({
          id: sample.id,
          userId: demoUserId,
          submittedUrl: sample.url,
          normalizedUrl: sample.url,
          canonicalUrl: sample.url,
          title: sample.title,
          description: sample.description,
          siteName: "SimpanDulu Demo",
          contentHtml: `<p>${sample.text}</p>`,
          contentText: sample.text,
          wordCount: sample.text.split(/\s+/u).length,
          estimatedReadingMinutes: 1,
          extractionStatus: "completed",
          searchVector: sql`setweight(to_tsvector('simple', ${sample.title}), 'A') || setweight(to_tsvector('simple', ${sample.description}), 'B') || setweight(to_tsvector('simple', ${sample.text}), 'C')`,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .onConflictDoNothing({ target: articles.id });
    }
  });
  process.stdout.write(`Demo articles are ready for ${demoEmail}.\n`);
} finally {
  await pool.end();
}

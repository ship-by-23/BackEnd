import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import { users } from "./schema.js";

const seedEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test"]),
  DATABASE_URL: z.string().min(1),
  SEED_ADMIN_EMAIL: z.email(),
  SEED_ADMIN_PASSWORD_HASH: z
    .string()
    .regex(
      /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/,
      "Must be a complete bcrypt password hash",
    ),
  SEED_ADMIN_NAME: z.string().trim().min(1).default("SimpanDulu Admin"),
});

const environment = seedEnvironmentSchema.parse(process.env);
const normalizedEmail = environment.SEED_ADMIN_EMAIL.trim().toLowerCase();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const database = drizzle(pool);

try {
  await database
    .insert(users)
    .values({
      email: normalizedEmail,
      normalizedEmail,
      passwordHash: environment.SEED_ADMIN_PASSWORD_HASH,
      name: environment.SEED_ADMIN_NAME,
      role: "admin",
    })
    .onConflictDoNothing({ target: users.normalizedEmail });
} finally {
  await pool.end();
}

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { z } from "zod";

const environment = z
  .object({
    DATABASE_URL: z.string().min(1),
  })
  .parse(process.env);

const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 1 });

try {
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
} finally {
  await pool.end();
}

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Global singleton pool (survives HMR / route reloads in dev).
 * Works with Neon via the standard Postgres wire protocol + ?sslmode=require.
 */
const globalForDb = globalThis as unknown as { voxauraPool?: Pool };

export const pool =
  globalForDb.voxauraPool ??
  new Pool(
    process.env.DATABASE_URL
      ? {
          connectionString: process.env.DATABASE_URL,
          max: 5,
          ssl: process.env.DATABASE_URL.includes("sslmode=require")
            ? { rejectUnauthorized: false }
            : undefined,
        }
      : { max: 5 },
  );

if (process.env.NODE_ENV !== "production") {
  globalForDb.voxauraPool = pool;
}

export const db = drizzle(pool, { schema });
export { schema };

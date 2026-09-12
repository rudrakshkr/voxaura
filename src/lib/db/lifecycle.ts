import { pool } from "./client";

/** Close the shared pool — used by scripts (seed) after finishing. */
export async function closePool(): Promise<void> {
  await pool.end();
}

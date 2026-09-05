import pg from "pg";
import { config } from "./config.js";
export const db = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 12,
  connectionTimeoutMillis: 10000,
});
export async function transaction<T>(
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}

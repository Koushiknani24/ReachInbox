import { readFile } from "node:fs/promises";
import { db } from "./db.js";
export async function migrate() {
  await db.query(
    await readFile(
      new URL("../server/schema.sql", import.meta.url).pathname.replace(
        /^\/([A-Za-z]:)/,
        "$1",
      ),
      "utf8",
    ),
  );
}
// Bundles copy schema.sql into the server directory; entry point performs migration separately.
if (process.argv[1]?.endsWith("migrate.ts")) {
  await migrate();
  await db.end();
  console.log("Database schema ready");
}

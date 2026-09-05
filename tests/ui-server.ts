// Local-only browser harness. Production application contains no test-login endpoint.
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { randomUUID, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";
import express from "express";
const local = dotenv.parse(readFileSync(".env.local"));
const database = `outbox_ui_${Date.now()}`;
const admin = new pg.Pool({ connectionString: local.DATABASE_URL });
await admin.query(`CREATE DATABASE ${database}`);
await admin.end();
Object.assign(process.env, local, {
  DATABASE_URL: local.DATABASE_URL.replace(/\/outbox$/, "/" + database),
  REDIS_URL: local.REDIS_URL + "/14",
  ELASTICSEARCH_INDEX: database,
  SMTP_TRANSPORT: "test",
  RUN_WORKER: "true",
  PORT: "3101",
  APP_URL: "http://localhost:3173",
  MIN_SEND_DELAY_MS: "2000",
  MAX_EMAILS_PER_HOUR_PER_SENDER: "200",
  OPERATOR_EMAIL: "browser-test@example.com",
});
const { db } = await import("../server/db.js");
const { encrypt } = await import("../server/crypto.js");
const { redis } = await import("../server/queues.js");
await redis.flushdb();
await db.query(readFileSync("server/schema.sql", "utf8"));
const uid = randomUUID(),
  sid = randomUUID();
await db.query(
  "INSERT INTO users(id,google_sub,email,name) VALUES($1,$2,$3,$4)",
  [uid, uid, "browser-test@example.com", "Koushik Vulli"],
);
await db.query(
  "INSERT INTO session(sid,sess,expire) VALUES($1,$2,now()+interval '3 hours')",
  [
    sid,
    JSON.stringify({
      cookie: { originalMaxAge: 10800000, httpOnly: true, path: "/" },
      userId: uid,
    }),
  ],
);
for (let i = 0; i < 2; i++) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO sender_templates(id,name,email,credentials,default_order) VALUES($1,$2,$3,$4,$5)",
    [
      id,
      i === 0 ? "Primary sender" : "Outreach sender",
      `sender${i}@ethereal.email`,
      encrypt(JSON.stringify({ user: "test", pass: "test" })),
      i,
    ],
  );
}
const cookie = `outbox.sid=${encodeURIComponent(`s:${sid}.` + createHmac("sha256", local.SESSION_SECRET).update(sid).digest("base64").replace(/=+$/, ""))}`;
const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: process.env,
  stdio: "inherit",
});
const proxy = express();
proxy.use(express.raw({ type: () => true, limit: "3mb" }));
proxy.use(async (req, res) => {
  try {
    const headers: Record<string, string> = { cookie };
    if (req.get("content-type"))
      headers["content-type"] = req.get("content-type")!;
    if (req.get("idempotency-key"))
      headers["Idempotency-Key"] = req.get("idempotency-key")!;
    if (req.get("origin")) headers.origin = req.get("origin")!;
    const r = await fetch("http://localhost:3101" + req.originalUrl, {
      method: req.method,
      headers,
      ...(!["GET", "HEAD"].includes(req.method) ? { body: req.body } : {}),
      redirect: "manual",
    });
    res.status(r.status);
    for (const [k, v] of r.headers) {
      if (
        ![
          "transfer-encoding",
          "content-encoding",
          "content-length",
          "set-cookie",
        ].includes(k)
      )
        res.setHeader(k, v);
    }
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(503).send("Test server is starting.");
  }
});
const server = proxy.listen(3173, "127.0.0.1", () =>
  console.log(
    "Browser harness: http://localhost:3173 (isolated test data; no real SMTP)",
  ),
);
process.on("SIGTERM", async () => {
  child.kill();
  server.close();
  await redis.quit();
  await db.end();
  process.exit(0);
});

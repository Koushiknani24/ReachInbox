// Opt-in hosted API check with an ephemeral QA user/session. No emails are sent.
import { readFileSync } from "node:fs";
import { randomUUID, createHmac } from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";
import assert from "node:assert/strict";
if (process.env.LIVE_SENDER_CHECK !== "true")
  throw new Error("Set LIVE_SENDER_CHECK=true to run.");
const local = dotenv.parse(readFileSync(".env.local"));
const cloud = dotenv.parse(readFileSync(".secrets/cloud.env"));
const original = JSON.parse(readFileSync(".secrets/ethereal.json", "utf8"));
const pool = new pg.Pool({ connectionString: local.DATABASE_URL });
const uid = randomUUID(),
  sid = randomUUID();
const cookie = `outbox.sid=${encodeURIComponent(`s:${sid}.` + createHmac("sha256", cloud.SESSION_SECRET).update(sid).digest("base64").replace(/=+$/, ""))}`;
const call = async (route: string, method = "GET") => {
  const r = await fetch(cloud.APP_URL + route, {
    method,
    headers: { cookie, origin: cloud.APP_URL },
    redirect: "manual",
  });
  return { status: r.status, body: await r.json() };
};
try {
  await pool.query(
    "INSERT INTO users(id,google_sub,email,name) VALUES($1,$2,$3,$4)",
    [uid, `qa-${uid}`, `qa-${uid}@example.com`, "Temporary sender QA"],
  );
  await pool.query(
    "INSERT INTO session(sid,sess,expire) VALUES($1,$2,now()+interval '5 minutes')",
    [
      sid,
      JSON.stringify({
        cookie: {
          originalMaxAge: 300000,
          httpOnly: true,
          secure: true,
          path: "/",
        },
        userId: uid,
      }),
    ],
  );
  const loaded = await call("/api/senders");
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.length, 2);
  assert.equal(loaded.body[0].email, original.user);
  assert.equal(loaded.body[0].is_default, true);
  assert.ok(loaded.body.every((s: any) => !("credentials" in s)));
  console.log(
    "PASS new account automatically gets the original default sender without exposing credentials",
  );
  assert.equal(
    (await call("/api/senders/" + loaded.body[0].id, "DELETE")).status,
    403,
  );
  const id = loaded.body[1].id;
  assert.equal((await call("/api/senders/" + id, "DELETE")).status, 200);
  assert.equal((await call("/api/senders")).body.length, 1);
  assert.equal((await call("/api/senders")).body.length, 1);
  console.log("PASS removed sender stays removed after repeated loading");
  assert.equal((await call("/api/senders/provision", "POST")).status, 200);
  assert.equal((await call("/api/senders")).body[1].id, id);
  const foreign = await pool.query(
    "SELECT id FROM senders WHERE user_id<>$1 LIMIT 1",
    [uid],
  );
  if (foreign.rows.length)
    assert.equal(
      (await call("/api/senders/" + foreign.rows[0].id, "DELETE")).status,
      404,
    );
  assert.equal((await call("/health/ready")).status, 200);
  console.log(
    "PASS restore retains sender identity; foreign sender removal is blocked; service is healthy",
  );
} finally {
  await pool.query("DELETE FROM session WHERE sid=$1", [sid]);
  await pool.query("DELETE FROM senders WHERE user_id=$1", [uid]);
  await pool.query("DELETE FROM users WHERE id=$1", [uid]);
  await pool.end();
}

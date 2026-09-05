import dotenv from "dotenv";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";
import assert from "node:assert/strict";
const local = dotenv.parse(readFileSync(".env.local"));
const admin = new pg.Pool({ connectionString: local.DATABASE_URL });
const database = `outbox_test_${Date.now()}`;
await admin.query(`CREATE DATABASE ${database}`);
await admin.end();
Object.assign(process.env, local, {
  DATABASE_URL: local.DATABASE_URL.replace(/\/outbox$/, "/" + database),
  REDIS_URL: local.REDIS_URL + "/15",
  ELASTICSEARCH_INDEX: database,
  SMTP_TRANSPORT: "test",
  RUN_WORKER: "false",
  PORT: "3100",
  APP_URL: "http://localhost:3100",
  MIN_SEND_DELAY_MS: "200",
  MAX_EMAILS_PER_HOUR_PER_SENDER: "3",
  OPERATOR_EMAIL: "operator@example.com",
});
const { db } = await import("../server/db.js");
const { encrypt } = await import("../server/crypto.js");
const { emailQueue, indexQueue, slackQueue, queueOptions, redis } =
  await import("../server/queues.js");
const { startWorkers, deliver } = await import("../server/worker.js");
const { recover } = await import("../server/outbox.js");
const { search, index, indexEmail } = await import("../server/search.js");
const { Worker } = await import("bullmq");
// Only the isolated Redis logical database used by this test run is cleared.
await redis.flushdb();
await db.query(readFileSync("server/schema.sql", "utf8"));
const uid = randomUUID(),
  uid2 = randomUUID(),
  sid = randomUUID();
await db.query(
  "INSERT INTO users(id,google_sub,email,name) VALUES($1,$2,$3,$4),($5,$6,$7,$8)",
  [
    uid,
    uid,
    "operator@example.com",
    "Test operator",
    uid2,
    uid2,
    "other@example.com",
    "Other user",
  ],
);
await db.query(
  "INSERT INTO session(sid,sess,expire) VALUES($1,$2,now()+interval '1 hour')",
  [
    sid,
    JSON.stringify({
      cookie: { originalMaxAge: 3600000, httpOnly: true, path: "/" },
      userId: uid,
    }),
  ],
);
const signed =
  `s:${sid}.` +
  createHmac("sha256", local.SESSION_SECRET)
    .update(sid)
    .digest("base64")
    .replace(/=+$/, "");
const cookie = `outbox.sid=${encodeURIComponent(signed)}`;
for (let i = 0; i < 2; i++) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO sender_templates(id,name,email,credentials,default_order) VALUES($1,$2,$3,$4,$5)",
    [
      id,
      `Test sender ${i}`,
      `sender${i}@example.com`,
      encrypt(JSON.stringify({ user: "test", pass: "test" })),
      i,
    ],
  );
}
const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (b) => {
  logs += b.toString();
});
child.stderr.on("data", (b) => {
  logs += b.toString();
});
const wait = async (test: () => Promise<boolean>, ms = 15000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out waiting for assertion");
};
const results: { name: string; ok: boolean }[] = [];
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  results.push({ name, ok: true });
  console.log("PASS", name);
};
const call = async (
  route: string,
  options: RequestInit = {},
  authenticated = true,
) => {
  const r = await fetch("http://localhost:3100" + route, {
    ...options,
    headers: { ...(authenticated ? { cookie } : {}), ...options.headers },
  });
  let body: any;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
};
let stop: (() => Promise<void>) | undefined, extra: any;
try {
  await wait(async () => {
    try {
      return (await call("/health/live")).status === 200;
    } catch {
      return false;
    }
  });
  await test("health live and readiness", async () => {
    assert.equal((await call("/health/live")).status, 200);
    assert.equal((await call("/health/ready")).status, 200);
  });
  await test("all private APIs reject unauthenticated callers", async () => {
    for (const path of [
      "/api/me",
      "/api/senders",
      "/api/stats",
      "/api/emails",
      "/api/emails/" + randomUUID(),
      "/admin/queues",
    ])
      assert.equal((await call(path, {}, false)).status, 401);
  });
  await test("public configuration and authenticated profile", async () => {
    assert.equal((await call("/api/config", {}, false)).status, 200);
    assert.equal((await call("/api/me")).body.email, "operator@example.com");
  });
  await test("sender provisioning is persistent and idempotent", async () => {
    assert.equal(
      (await call("/api/senders/provision", { method: "POST" })).status,
      200,
    );
    assert.equal(
      (await call("/api/senders/provision", { method: "POST" })).body.created,
      false,
    );
    assert.equal((await call("/api/senders")).body.length, 2);
  });
  const senders = (await call("/api/senders")).body;
  await test("sender limit updates validate range and ownership", async () => {
    const change = (id: string, hourlyLimit: number) =>
      call("/api/senders/" + id, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hourlyLimit }),
      });
    assert.equal((await change(senders[0].id, 0)).status, 400);
    assert.equal((await change(randomUUID(), 2)).status, 404);
    assert.equal((await change(senders[0].id, 3)).status, 200);
  });
  await test("CSV upload preview and missing upload validation", async () => {
    const f = new FormData();
    f.append(
      "file",
      new Blob(["email\nfirst@example.com\nfirst@example.com\ninvalid@"], {
        type: "text/csv",
      }),
      "leads.csv",
    );
    const r = await call("/api/leads/preview", { method: "POST", body: f });
    assert.equal(r.body.valid, 1);
    assert.equal(r.body.duplicates, 1);
    assert.equal(r.body.invalid, 1);
    assert.equal(
      (await call("/api/leads/preview", { method: "POST" })).status,
      400,
    );
  });
  const payload = {
    senderId: senders[0].id,
    subject: "Integration searchable message",
    body: "Durable scheduler verification content",
    recipients: Array.from(
      { length: 5 },
      (_, i) => `recipient${i}@example.com`,
    ),
    startAt: new Date(Date.now() + 2000).toISOString(),
    delayMs: 200,
    hourlyLimit: 3,
  };
  const schedule = (body: any, key: string) =>
    call("/api/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
  await test("schedule validation and cross-origin protection", async () => {
    assert.equal(
      (await schedule({ ...payload, recipients: ["invalid"] }, randomUUID()))
        .status,
      400,
    );
    assert.equal(
      (await schedule({ ...payload, senderId: randomUUID() }, randomUUID()))
        .status,
      404,
    );
    assert.equal(
      (
        await call("/api/campaigns", {
          method: "POST",
          headers: {
            origin: "https://untrusted.example",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        })
      ).status,
      403,
    );
  });
  let campaignId = "";
  await test("concurrent duplicate requests create exactly one campaign", async () => {
    const key = randomUUID();
    const r = await Promise.all(
      Array.from({ length: 4 }, () => schedule(payload, key)),
    );
    assert.equal(r.filter((x) => x.status === 202).length, 1);
    assert.equal(r.filter((x) => x.status === 200).length, 3);
    campaignId = r[0].body.id;
    assert.equal(
      (await schedule({ ...payload, subject: "Changed" }, key)).status,
      409,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM emails WHERE campaign_id=$1",
          [campaignId],
        )
      ).rows[0].n,
      5,
    );
  });
  stop = await startWorkers();
  extra = new Worker("email-delivery", deliver, {
    ...queueOptions,
    concurrency: 1,
    lockDuration: 120000,
  });
  await test("two concurrent workers enforce a shared sender hourly cap", async () => {
    await wait(
      async () =>
        (
          await db.query(
            "SELECT count(*)::int n FROM emails WHERE campaign_id=$1 AND status='sent'",
            [campaignId],
          )
        ).rows[0].n === 3,
    );
    await new Promise((r) => setTimeout(r, 1800));
    const { rows } = await db.query(
      "SELECT status,count(*)::int n FROM emails WHERE campaign_id=$1 GROUP BY status",
      [campaignId],
    );
    assert.equal(rows.find((x) => x.status === "sent").n, 3);
    assert.equal(rows.find((x) => x.status === "scheduled").n, 2);
  });
  await test("send timestamps respect pacing and overflow remains delayed", async () => {
    const { rows } = await db.query(
      "SELECT claimed_at FROM emails WHERE campaign_id=$1 AND status='sent' ORDER BY claimed_at",
      [campaignId],
    );
    for (let i = 1; i < rows.length; i++)
      assert.ok(
        rows[i].claimed_at.getTime() - rows[i - 1].claimed_at.getTime() >= 190,
      );
    const pending = await db.query(
      "SELECT next_attempt_at FROM emails WHERE campaign_id=$1 AND status='scheduled'",
      [campaignId],
    );
    assert.ok(
      pending.rows.every(
        (x) => new Date(x.next_attempt_at).getTime() > Date.now() + 1000,
      ),
    );
  });
  await test("one threshold event and absent Slack is safely skipped", async () => {
    await wait(
      async () =>
        (
          await db.query("SELECT * FROM rate_events WHERE sender_id=$1", [
            senders[0].id,
          ])
        ).rows[0]?.state === "skipped",
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM rate_events WHERE sender_id=$1",
          [senders[0].id],
        )
      ).rows[0].n,
      1,
    );
  });
  await test("completed email replay never sends twice", async () => {
    const {
      rows: [e],
    } = await db.query(
      "SELECT * FROM emails WHERE campaign_id=$1 AND status='sent' LIMIT 1",
      [campaignId],
    );
    await emailQueue.add(
      "send",
      { id: e.id },
      { jobId: `replay-${randomUUID()}` },
    );
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(
      (await db.query("SELECT attempts FROM emails WHERE id=$1", [e.id]))
        .rows[0].attempts,
      1,
    );
  });
  await test("Elasticsearch indexes scheduled and sent content", async () => {
    await wait(async () => {
      await search.indices.refresh({ index });
      const r = await call("/api/emails?view=sent&q=searchable");
      return r.status === 200 && r.body.total === 3;
    });
    const r = await call("/api/emails?view=scheduled&q=searchable");
    assert.equal(r.body.total, 2);
  });
  await test("stale indexing does not regress terminal status", async () => {
    const {
      rows: [e],
    } = await db.query(
      "SELECT * FROM emails WHERE campaign_id=$1 AND status='sent' LIMIT 1",
      [campaignId],
    );
    await indexEmail(e.id);
    try {
      await search.index({
        index,
        id: e.id,
        version: 1,
        version_type: "external_gte",
        document: { status: "scheduled" },
      });
      assert.fail("Stale update accepted");
    } catch (e: any) {
      assert.equal(e.statusCode, 409);
    }
  });
  await test("lists, stats, detail, missing record, and queue dashboard", async () => {
    assert.equal((await call("/api/emails?view=sent")).body.total, 3);
    assert.equal((await call("/api/stats")).body.sent, 3);
    const id = (await call("/api/emails?view=sent")).body.items[0].id;
    assert.equal((await call("/api/emails/" + id)).status, 200);
    assert.equal((await call("/api/emails/" + randomUUID())).status, 404);
    assert.equal((await call("/api/absent")).status, 404);
    assert.equal((await call("/admin/queues/")).status, 200);
  });
  await test("foreign user cannot read mail or search results", async () => {
    await db.query("UPDATE session SET sess=$2 WHERE sid=$1", [
      sid,
      JSON.stringify({
        cookie: { originalMaxAge: 3600000, httpOnly: true, path: "/" },
        userId: uid2,
      }),
    ]);
    assert.equal(
      (await call("/api/emails?view=sent&q=searchable")).body.total,
      0,
    );
    assert.equal((await call("/admin/queues/")).status, 403);
    await db.query("UPDATE session SET sess=$2 WHERE sid=$1", [
      sid,
      JSON.stringify({
        cookie: { originalMaxAge: 3600000, httpOnly: true, path: "/" },
        userId: uid,
      }),
    ]);
  });
  await test("Slack connect redirects to real OAuth and rejects invalid callback", async () => {
    const r = await fetch("http://localhost:3100/auth/slack", {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(r.status, 302);
    assert.ok(
      r.headers
        .get("location")
        ?.startsWith("https://slack.com/oauth/v2/authorize"),
    );
    const bad = await fetch(
      "http://localhost:3100/auth/slack/callback?state=wrong&code=invalid",
      { headers: { cookie }, redirect: "manual" },
    );
    assert.ok(bad.headers.get("location")?.includes("slack_cancelled"));
    assert.equal(
      (await call("/api/integrations/slack", { method: "DELETE" })).status,
      200,
    );
  });
  await test("Google authorization redirects to real Google and rejects invalid state", async () => {
    const r = await fetch("http://localhost:3100/auth/google", {
      redirect: "manual",
    });
    assert.equal(r.status, 302);
    assert.ok(
      r.headers.get("location")?.startsWith("https://accounts.google.com/"),
    );
    const bad = await fetch(
      "http://localhost:3100/auth/google/callback?state=wrong&code=invalid",
      { redirect: "manual" },
    );
    assert.ok(bad.headers.get("location")?.includes("login_cancelled"));
  });
  await test("worker restart preserves future jobs and resumes delivery", async () => {
    await extra.close();
    await stop!();
    stop = undefined;
    const r = await schedule(
      {
        ...payload,
        senderId: senders[1].id,
        recipients: ["restart@example.com"],
        startAt: new Date(Date.now() + 1500).toISOString(),
      },
      randomUUID(),
    );
    assert.equal(r.status, 202);
    stop = await startWorkers();
    await wait(
      async () =>
        (
          await db.query("SELECT status FROM emails WHERE campaign_id=$1", [
            r.body.id,
          ])
        ).rows[0]?.status === "sent",
    );
  });
  await test("abandoned sending intent is quarantined instead of blindly resent", async () => {
    const {
      rows: [e],
    } = await db.query(
      "SELECT id FROM emails WHERE campaign_id=$1 AND status='scheduled' LIMIT 1",
      [campaignId],
    );
    await db.query(
      "UPDATE emails SET status='sending',claimed_at=now()-interval '10 minutes' WHERE id=$1",
      [e.id],
    );
    await recover();
    assert.equal(
      (await db.query("SELECT status FROM emails WHERE id=$1", [e.id])).rows[0]
        .status,
      "unknown",
    );
  });
  await test("1000-recipient burst persists without dropped records", async () => {
    const r = await schedule(
      {
        ...payload,
        startAt: new Date(Date.now() + 3600000).toISOString(),
        recipients: Array.from(
          { length: 1000 },
          (_, i) => `load${i}@example.com`,
        ),
      },
      randomUUID(),
    );
    assert.equal(r.status, 202);
    assert.equal(r.body.count, 1000);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM emails WHERE campaign_id=$1",
          [r.body.id],
        )
      ).rows[0].n,
      1000,
    );
  });
  await test("new accounts get the original sender automatically, with isolated records", async () => {
    await db.query("UPDATE session SET sess=$2 WHERE sid=$1", [
      sid,
      JSON.stringify({
        cookie: { originalMaxAge: 3600000, httpOnly: true, path: "/" },
        userId: uid2,
      }),
    ]);
    const listings = await Promise.all(
      Array.from({ length: 4 }, () => call("/api/senders")),
    );
    assert.ok(listings.every((r) => r.status === 200 && r.body.length === 2));
    const otherSenders = listings[0].body;
    assert.equal(otherSenders[0].email, senders[0].email);
    assert.equal(otherSenders[0].is_default, true);
    assert.notEqual(otherSenders[0].id, senders[0].id);
    assert.equal(otherSenders[0].credentials, undefined);
    assert.equal(
      (await call("/api/senders/" + senders[0].id, { method: "DELETE" }))
        .status,
      404,
    );
    const campaign = await schedule(
      {
        ...payload,
        senderId: otherSenders[0].id,
        recipients: ["shared-cap@example.com"],
        startAt: new Date(Date.now() + 500).toISOString(),
      },
      randomUUID(),
    );
    assert.equal(campaign.status, 202);
    // The earlier 1,000-recipient test leaves a large outbox backlog. Publish
    // this specific job immediately to test admission across users independently.
    const {
      rows: [sharedMail],
    } = await db.query("SELECT id FROM emails WHERE campaign_id=$1", [
      campaign.body.id,
    ]);
    await emailQueue.add(
      "send",
      { id: sharedMail.id },
      { jobId: `email-${sharedMail.id}` },
    );
    await wait(async () => {
      const r = await db.query(
        "SELECT reason FROM emails WHERE campaign_id=$1",
        [campaign.body.id],
      );
      return r.rows[0]?.reason === "Shared sender hourly limit reached";
    });
    assert.equal(
      (
        await db.query("SELECT attempts FROM emails WHERE campaign_id=$1", [
          campaign.body.id,
        ])
      ).rows[0].attempts,
      0,
    );
    await db.query("UPDATE session SET sess=$2 WHERE sid=$1", [
      sid,
      JSON.stringify({
        cookie: { originalMaxAge: 3600000, httpOnly: true, path: "/" },
        userId: uid,
      }),
    ]);
  });
  await test("removal stays account-local, preserves queued mail, and supports restore", async () => {
    assert.equal(
      (await call("/api/senders/" + senders[0].id, { method: "DELETE" }))
        .status,
      403,
    );
    await db.query("UPDATE senders SET is_hidden=true WHERE id=$1", [
      senders[0].id,
    ]);
    assert.equal((await call("/api/senders")).body[0].id, senders[0].id);
    const pendingBefore = (await call("/api/emails?view=scheduled")).body.total;
    assert.equal(
      (await call("/api/senders/" + senders[1].id, { method: "DELETE" }))
        .status,
      200,
    );
    assert.equal((await call("/api/senders")).body.length, 1);
    assert.equal((await call("/api/senders")).body.length, 1);
    assert.equal(
      (await call("/api/emails?view=scheduled")).body.total,
      pendingBefore,
    );
    assert.equal(
      (
        await schedule(
          {
            ...payload,
            senderId: senders[1].id,
            startAt: new Date(Date.now() + 60000).toISOString(),
          },
          randomUUID(),
        )
      ).status,
      404,
    );
    assert.equal(
      (await call("/api/senders/provision", { method: "POST" })).status,
      200,
    );
    assert.equal((await call("/api/senders")).body[0].id, senders[0].id);
    assert.equal((await call("/api/senders")).body[0].hour_count, 3);
  });
  await test("additional senders validate input, avoid duplicate races, and stay private", async () => {
    const add = (input: unknown) =>
      call("/api/senders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    assert.equal(
      (
        await add({
          name: "Invalid",
          email: "bad@example.com",
          password: "test",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          "/api/senders",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
          false,
        )
      ).status,
      401,
    );
    const payload = {
      name: "Additional sender",
      email: "extra-test@ethereal.email",
      password: "test-only-password",
    };
    const added = await Promise.all(
      Array.from({ length: 4 }, () => add(payload)),
    );
    assert.equal(added.filter((r) => r.status === 201).length, 1);
    assert.equal(added.filter((r) => r.status === 409).length, 3);
    const created = added.find((r) => r.status === 201)!.body;
    assert.equal(created.credentials, undefined);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM senders WHERE user_id=$1 AND email=$2",
          [uid2, payload.email],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await call("/api/senders/" + created.id, { method: "DELETE" })).status,
      200,
    );
    const restored = await add(payload);
    assert.equal(restored.status, 201);
    assert.equal(restored.body.id, created.id);
    assert.equal((await call("/api/senders")).body[0].id, senders[0].id);
  });
  await test("missing sender configuration returns an actionable safe error", async () => {
    await db.query("UPDATE sender_templates SET default_order=NULL");
    const r = await call("/api/senders/provision", { method: "POST" });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /default sender is not configured/);
    assert.ok(!r.body.error.includes("credentials"));
    for (let i = 0; i < 2; i++)
      await db.query(
        "UPDATE sender_templates SET default_order=$2 WHERE email=$1",
        [`sender${i}@example.com`, i],
      );
  });
  await test("logout invalidates the stored session", async () => {
    assert.equal((await call("/api/logout", { method: "POST" })).status, 200);
    assert.equal((await call("/api/me")).status, 401);
  });
  mkdirSync(".local", { recursive: true });
  writeFileSync(
    ".local/integration-results.json",
    JSON.stringify(
      { database, at: new Date().toISOString(), results },
      null,
      2,
    ),
  );
  console.log(`${results.length} integration scenarios passed`);
} catch (e) {
  console.error("INTEGRATION FAILURE", e);
  console.error(logs.slice(-2500));
  process.exitCode = 1;
} finally {
  child.kill();
  if (extra) await extra.close();
  if (stop) await stop();
  await Promise.all([
    emailQueue.close(),
    indexQueue.close(),
    slackQueue.close(),
  ]);
  await redis.quit();
  await db.end();
  process.exit(process.exitCode || 0);
}

// Opt-in live smoke test. Uses an expiring test session for an existing operator;
// it does not test the interactive Google consent flow or add a login endpoint.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID, createHmac } from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";
import assert from "node:assert/strict";
const recipients = process.env.LIVE_TEST_RECIPIENTS?.split(",").filter(Boolean);
if (!recipients?.length)
  throw new Error(
    "Set LIVE_TEST_RECIPIENTS explicitly to authorize the live test messages.",
  );
const local = dotenv.parse(readFileSync(".env.local"));
const cloud = dotenv.parse(readFileSync(".secrets/cloud.env"));
const pool = new pg.Pool({ connectionString: local.DATABASE_URL });
const sid = randomUUID(),
  results: string[] = [];
const cookie = `outbox.sid=${encodeURIComponent(`s:${sid}.` + createHmac("sha256", cloud.SESSION_SECRET).update(sid).digest("base64").replace(/=+$/, ""))}`;
const call = async (path: string, options: RequestInit = {}) =>
  fetch(cloud.APP_URL + path, {
    ...options,
    headers: { cookie, ...options.headers },
    redirect: "manual",
  });
const pass = (name: string) => {
  results.push(name);
  console.log("PASS", name);
};
try {
  const {
    rows: [user],
  } = await pool.query("SELECT id FROM users WHERE email=$1", [
    cloud.OPERATOR_EMAIL,
  ]);
  assert.ok(user, "Operator must complete real Google login first.");
  await pool.query(
    "INSERT INTO session(sid,sess,expire) VALUES($1,$2,now()+interval '15 minutes')",
    [
      sid,
      JSON.stringify({
        cookie: {
          originalMaxAge: 900000,
          httpOnly: true,
          secure: true,
          path: "/",
          sameSite: "lax",
        },
        userId: user.id,
      }),
    ],
  );
  assert.equal((await call("/health/ready")).status, 200);
  pass("Cloud Run readiness with PostgreSQL and Redis");
  const template = await call("/templates/recipients-template.csv");
  assert.equal(template.status, 200);
  assert.ok(template.headers.get("content-type")?.includes("text/csv"));
  const csv = await template.text();
  assert.ok(csv.startsWith("name,email"));
  pass("Hosted downloadable CSV");
  const file = new FormData();
  file.append(
    "file",
    new Blob([csv], { type: "text/csv" }),
    "recipients-template.csv",
  );
  const parsed = await (
    await call("/api/leads/preview", { method: "POST", body: file })
  ).json();
  assert.equal(parsed.valid, 2);
  assert.equal(parsed.invalid, 0);
  pass("Sample CSV uploads as two valid recipients");
  const auth = await call("/auth/slack");
  const authUrl = new URL(auth.headers.get("location")!);
  assert.equal(authUrl.searchParams.get("client_id"), cloud.SLACK_CLIENT_ID);
  if (cloud.SLACK_USE_DEFAULT_REDIRECT === "true") {
    assert.equal(authUrl.searchParams.has("redirect_uri"), false);
  } else {
    assert.equal(
      authUrl.searchParams.get("redirect_uri"),
      cloud.SLACK_CALLBACK_URL,
    );
  }
  pass("Deployed Slack OAuth client and callback match configuration");
  const senders = await (await call("/api/senders")).json();
  assert.equal(senders.length, 2);
  pass("Two persisted sender accounts");
  const marker = `Outbox live verification ${new Date().toISOString()}`;
  const submitted = await call("/api/campaigns", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": randomUUID(),
      origin: cloud.APP_URL,
    },
    body: JSON.stringify({
      senderId: senders[0].id,
      subject: marker,
      body: "This is an authorized assignment test of the deployed Outbox scheduler. Ethereal captures this message for preview.",
      recipients,
      startAt: new Date(Date.now() + 15000).toISOString(),
      delayMs: 2000,
      hourlyLimit: 100,
    }),
  });
  assert.equal(submitted.status, 202);
  const campaign = await submitted.json();
  pass("Live campaign accepted");
  const deadline = Date.now() + 90000;
  let sent: any[] = [];
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      "SELECT id,status,preview_url FROM emails WHERE campaign_id=$1",
      [campaign.id],
    );
    sent = rows;
    if (
      rows.length === recipients.length &&
      rows.every((x) => x.status === "sent")
    )
      break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.ok(
    sent.length === recipients.length && sent.every((x) => x.status === "sent"),
    "Live mail must finish successfully",
  );
  assert.ok(
    sent.every((x) =>
      x.preview_url?.startsWith("https://ethereal.email/message/"),
    ),
  );
  pass(`${sent.length} real Ethereal SMTP deliveries with preview URLs`);
  const detail = await (await call("/api/emails/" + sent[0].id)).json();
  assert.equal(detail.status, "sent");
  pass("Hosted sent-email details");
  let found = false;
  for (let i = 0; i < 15; i++) {
    const search = await (
      await call("/api/emails?view=sent&q=" + encodeURIComponent(marker))
    ).json();
    if (search.total === recipients.length) {
      found = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(found);
  pass("Live Elasticsearch finds the sent test batch");
  const preview = await fetch(sent[0].preview_url);
  assert.equal(preview.status, 200);
  pass("Ethereal preview page loads");
  assert.equal((await call("/admin/queues/")).status, 200);
  pass("Hosted operator queue dashboard");
  mkdirSync(".local", { recursive: true });
  writeFileSync(
    ".local/live-results.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        url: cloud.APP_URL,
        campaignId: campaign.id,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.query("DELETE FROM session WHERE sid=$1", [sid]);
  await pool.end();
}

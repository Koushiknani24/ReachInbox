import { Worker, DelayedError, Job } from "bullmq";
import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { db, transaction } from "./db.js";
import { decrypt } from "./crypto.js";
import { redis, queueOptions } from "./queues.js";
import { event, dispatchOnce, recover } from "./outbox.js";
import { ensureIndex, indexEmail } from "./search.js";
import { nextHour } from "./validation.js";

export async function deliver(job: Job, token?: string) {
  const admission = await transaction(async (c) => {
    const {
      rows: [initial],
    } = await c.query(
      "SELECT e.sender_id,e.campaign_id,s.template_id FROM emails e JOIN senders s ON s.id=e.sender_id WHERE e.id=$1",
      [job.data.id],
    );
    if (!initial) return { skip: true };
    // Serialize all accounts that use the same physical SMTP sender.
    await c.query("SELECT id FROM sender_templates WHERE id=$1 FOR UPDATE", [
      initial.template_id,
    ]);
    const {
      rows: [sender],
    } = await c.query("SELECT * FROM senders WHERE id=$1 FOR UPDATE", [
      initial.sender_id,
    ]);
    const {
      rows: [campaign],
    } = await c.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [
      initial.campaign_id,
    ]);
    const {
      rows: [mail],
    } = await c.query(
      "SELECT *,clock_timestamp() AS clock FROM emails WHERE id=$1 FOR UPDATE",
      [job.data.id],
    );
    if (mail.status !== "scheduled") return { skip: true };
    const now = new Date(mail.clock).getTime(),
      hour = Math.floor(now / 3600000) * 3600000;
    const senderCount =
      new Date(sender.hour_start).getTime() === hour ? sender.hour_count : 0;
    const campaignCount =
      new Date(campaign.hour_start).getTime() === hour
        ? campaign.hour_count
        : 0;
    const limit = Math.min(
      config.MAX_EMAILS_PER_HOUR_PER_SENDER,
      sender.hourly_limit,
    );
    const {
      rows: [shared],
    } = await c.query(
      "SELECT COALESCE(sum(hour_count) FILTER (WHERE hour_start=$2),0)::int AS hour_count,max(next_allowed_at) AS next_allowed_at FROM senders WHERE template_id=$1",
      [initial.template_id, new Date(hour)],
    );
    const {
      rows: [inflight],
    } = await c.query(
      "SELECT e.id FROM emails e JOIN senders s ON s.id=e.sender_id WHERE s.template_id=$1 AND e.status='sending' LIMIT 1",
      [initial.template_id],
    );
    let deferred = Math.max(
      new Date(mail.next_attempt_at).getTime(),
      new Date(sender.next_allowed_at).getTime(),
      new Date(shared.next_allowed_at).getTime(),
      new Date(campaign.next_allowed_at).getTime(),
    );
    let reason = "Waiting for sender spacing";
    if (inflight) deferred = Math.max(deferred, now + 2000);
    if (
      senderCount >= limit ||
      campaignCount >= campaign.hourly_limit ||
      shared.hour_count >= config.MAX_EMAILS_PER_HOUR_PER_SENDER
    ) {
      deferred = Math.max(deferred, nextHour(now));
      reason =
        shared.hour_count >= config.MAX_EMAILS_PER_HOUR_PER_SENDER
          ? "Shared sender hourly limit reached"
          : senderCount >= limit
            ? "Sender hourly limit reached"
            : "Campaign hourly limit reached";
    }
    if (deferred > now) {
      const {
        rows: [updated],
      } = await c.query(
        "UPDATE emails SET next_attempt_at=$2,reason=$3,version=version+1 WHERE id=$1 RETURNING version",
        [mail.id, new Date(deferred), reason],
      );
      await event(c, "index", mail.id, updated.version);
      return { deferred };
    }
    await c.query(
      "UPDATE senders SET hour_start=$2,hour_count=$3,next_allowed_at=$4 WHERE id=$1",
      [
        sender.id,
        new Date(hour),
        senderCount + 1,
        new Date(now + config.MIN_SEND_DELAY_MS),
      ],
    );
    await c.query(
      "UPDATE campaigns SET hour_start=$2,hour_count=$3,next_allowed_at=$4 WHERE id=$1",
      [
        campaign.id,
        new Date(hour),
        campaignCount + 1,
        new Date(now + Math.max(config.MIN_SEND_DELAY_MS, campaign.delay_ms)),
      ],
    );
    const {
      rows: [updated],
    } = await c.query(
      "UPDATE emails SET status='sending',reason=NULL,attempts=attempts+1,claimed_at=clock_timestamp(),version=version+1 WHERE id=$1 RETURNING version",
      [mail.id],
    );
    await event(c, "index", mail.id, updated.version);
    if (senderCount + 1 === limit || shared.hour_count + 1 === config.MAX_EMAILS_PER_HOUR_PER_SENDER) {
      const id = randomUUID();
      const result = await c.query(
        "INSERT INTO rate_events(id,user_id,sender_id,hour_start,limit_value) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
        [id, mail.user_id, sender.id, new Date(hour), senderCount + 1 === limit ? limit : config.MAX_EMAILS_PER_HOUR_PER_SENDER],
      );
      if (result.rowCount) await event(c, "slack", id);
    }
    return { mail, sender, delayMs: campaign.delay_ms };
  });
  if ("deferred" in admission && admission.deferred) {
    await job.moveToDelayed(admission.deferred, token);
    throw new DelayedError();
  }
  if (!("mail" in admission) || !admission.mail) return;
  const { mail, sender } = admission;
  let info: any;
  try {
    if (config.SMTP_TRANSPORT === "test") {
      info = {
        messageId: `<${mail.id}@outbox.test>`,
        accepted: [mail.recipient],
      };
    } else {
      const credentials = JSON.parse(decrypt(sender.credentials));
      const smtp = nodemailer.createTransport({
        host: credentials.host || "smtp.ethereal.email",
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: credentials.user, pass: credentials.pass },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
      });
      try {
        info = await smtp.sendMail({
          from: { name: sender.name, address: sender.email },
          to: mail.recipient,
          subject: mail.subject,
          text: mail.body,
          messageId: `<${mail.id}@outbox.scheduler>`,
        });
      } finally {
        smtp.close();
      }
    }
  } catch (error) {
    const e = error as {
      code?: string;
      command?: string;
      responseCode?: number;
    };
    const knownNotAccepted =
      !!e.responseCode ||
      ["EAUTH", "EDNS", "ECONNECTION"].includes(e.code || "") ||
      ["CONN", "EHLO", "AUTH", "MAIL FROM", "RCPT TO"].includes(
        e.command || "",
      );
    const retry =
      knownNotAccepted &&
      !(e.responseCode && e.responseCode >= 500) &&
      e.code !== "EAUTH" &&
      mail.attempts < 2;
    const state = retry ? "scheduled" : knownNotAccepted ? "failed" : "unknown";
    const delay = Date.now() + Math.min(60000, 5000 * 2 ** mail.attempts);
    await transaction(async (c) => {
      await c.query(
        "UPDATE senders SET next_allowed_at=GREATEST(next_allowed_at,clock_timestamp()+make_interval(secs=>$2)) WHERE id=$1",
        [sender.id, config.MIN_SEND_DELAY_MS / 1000],
      );
      const {
        rows: [u],
      } = await c.query(
        "UPDATE emails SET status=$2,next_attempt_at=$3,error=$4,version=version+1 WHERE id=$1 RETURNING version",
        [
          mail.id,
          state,
          new Date(delay),
          state === "unknown"
            ? "SMTP outcome uncertain. Check the Ethereal mailbox before taking action."
            : `SMTP ${e.responseCode || e.code || "failure"}`,
        ],
      );
      await event(c, "index", mail.id, u.version);
    });
    if (retry) {
      await job.moveToDelayed(delay, token);
      throw new DelayedError();
    }
    return;
  }
  // Never call SMTP again if persisting a successful response fails: the sending intent remains for review.
  await transaction(async (c) => {
    await c.query(
      "UPDATE senders SET next_allowed_at=GREATEST(next_allowed_at,clock_timestamp()+make_interval(secs=>$2)) WHERE id=$1",
      [sender.id, Math.max(config.MIN_SEND_DELAY_MS, admission.delayMs) / 1000],
    );
    const {
      rows: [u],
    } = await c.query(
      "UPDATE emails SET status='sent',sent_at=clock_timestamp(),message_id=$2,preview_url=$3,error=NULL,version=version+1 WHERE id=$1 RETURNING version",
      [
        mail.id,
        info.messageId,
        config.SMTP_TRANSPORT === "test"
          ? null
          : nodemailer.getTestMessageUrl(info) || null,
      ],
    );
    await event(c, "index", mail.id, u.version);
  });
}

async function notify(id: string) {
  const {
    rows: [e],
  } = await db.query(
    "SELECT r.*,s.email FROM rate_events r JOIN senders s ON s.id=r.sender_id WHERE r.id=$1",
    [id],
  );
  if (!e || e.state === "sent" || e.state === "skipped") return;
  const {
    rows: [connection],
  } = await db.query("SELECT * FROM slack_connections WHERE user_id=$1", [
    e.user_id,
  ]);
  if (!connection) {
    await db.query("UPDATE rate_events SET state='skipped' WHERE id=$1", [id]);
    return;
  }
  const { webhook } = JSON.parse(decrypt(connection.credentials));
  const result = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `Outbox · Hourly limit reached\nSender: ${e.email}\n${e.limit_value} send attempts used this hour. Remaining emails are safely scheduled for ${new Date(nextHour(new Date(e.hour_start).getTime())).toISOString()}.`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!result.ok) {
    await db.query(
      "UPDATE rate_events SET state='error',error=$2 WHERE id=$1",
      [id, `Slack HTTP ${result.status}`],
    );
    throw new Error(`Slack HTTP ${result.status}`);
  }
  await db.query(
    "UPDATE rate_events SET state='sent',notified_at=now(),error=NULL WHERE id=$1",
    [id],
  );
}

export async function startWorkers() {
  try {
    await ensureIndex();
  } catch {
    console.error("Search will initialize when Elasticsearch recovers");
  }
  await recover();
  const workers = [
    new Worker("email-delivery", deliver, {
      ...queueOptions,
      concurrency: config.WORKER_CONCURRENCY,
      lockDuration: 120000,
    }),
    new Worker(
      "email-search",
      async (job) => {
        await ensureIndex();
        await indexEmail(job.data.id);
      },
      { ...queueOptions, concurrency: 2 },
    ),
    new Worker("slack-notifications", (job) => notify(job.data.id), {
      ...queueOptions,
      concurrency: 1,
    }),
  ];
  for (const worker of workers) {
    worker.on("error", () => console.error("Queue connection error"));
    worker.on("failed", (job) =>
      console.error("Queue job failed", worker.name, job?.id),
    );
  }
  let stop = false,
    lastRecovery = Date.now();
  const dispatchLoop = (async () => {
    while (!stop) {
      try {
        await dispatchOnce();
        if (Date.now() - lastRecovery > 60000) {
          await recover();
          lastRecovery = Date.now();
        }
      } catch {
        console.error("Outbox dispatch will retry");
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return async () => {
    stop = true;
    await dispatchLoop;
    await Promise.all(workers.map((w) => w.close()));
  };
}
if (
  process.argv[1]?.endsWith("/worker.js") ||
  process.argv[1]?.endsWith("worker.ts")
) {
  const stop = await startWorkers();
  console.log("Email, search, and Slack workers ready");
  process.on("SIGTERM", async () => {
    await stop();
    await redis.quit();
    await db.end();
    process.exit(0);
  });
}

import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import multer from "multer";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import {
  provisionDefaultSenders,
  SenderSetupError,
  addSender,
} from "./senders.js";
import { config } from "./config.js";
import { db, transaction } from "./db.js";
import { encrypt, hash } from "./crypto.js";
import { emailQueue, indexQueue, slackQueue, redis } from "./queues.js";
import { campaignSchema, parseLeads, senderSchema } from "./validation.js";
import { event } from "./outbox.js";
import { search, index } from "./search.js";
import { startWorkers } from "./worker.js";

declare module "express-session" {
  interface SessionData {
    userId: string;
    oauthState?: string;
    slackState?: string;
  }
}
const app = express();
app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: [
          "'self'",
          "data:",
          "https://lh3.googleusercontent.com",
          "https://*.googleusercontent.com",
        ],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.NODE_ENV === "production" ? [] : null,
      },
    },
  }),
);
app.use(express.json({ limit: "2mb" }));
const PgStore = connectPgSimple(session);
app.use(
  session({
    store: new PgStore({ pool: db }),
    name: "outbox.sid",
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 86400000,
    },
  }),
);
const google = new OAuth2Client(
  config.GOOGLE_CLIENT_ID,
  config.GOOGLE_CLIENT_SECRET,
  config.GOOGLE_CALLBACK_URL || `${config.APP_URL}/auth/google/callback`,
);
function oauthReady() {
  return !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}
const user = async (req: express.Request) => {
  const {
    rows: [u],
  } = await db.query("SELECT id,name,email,avatar_url FROM users WHERE id=$1", [
    req.session.userId,
  ]);
  return u;
};
const requireUser: express.RequestHandler = (req, res, next) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Please sign in to continue." });
    return;
  }
  next();
};
const requireOperator: express.RequestHandler = async (req, res, next) => {
  const u = await user(req);
  if (!u || u.email.toLowerCase() !== config.OPERATOR_EMAIL?.toLowerCase()) {
    res.status(403).json({ error: "Operator access required." });
    return;
  }
  next();
};
function stateValid(actual: unknown, expected?: string) {
  return (
    typeof actual === "string" &&
    !!expected &&
    actual.length === expected.length &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}

app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
app.get("/health/ready", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    await redis.ping();
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});
app.get("/api/config", (_req, res) =>
  res.json({
    googleReady: oauthReady(),
    slackReady: !!(config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET),
    minimumDelay: config.MIN_SEND_DELAY_MS,
    maxHourlyLimit: config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    maxRecipients: config.MAX_RECIPIENTS,
  }),
);
app.get("/auth/google", (req, res) => {
  if (!oauthReady()) {
    res.redirect(`${config.APP_URL}/?error=google_setup`);
    return;
  }
  req.session.oauthState = randomBytes(24).toString("hex");
  const url = google.generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state: req.session.oauthState,
    prompt: "select_account",
  });
  req.session.save(() => res.redirect(url));
});
app.get("/auth/google/callback", async (req, res) => {
  if (
    !stateValid(req.query.state, req.session.oauthState) ||
    typeof req.query.code !== "string"
  ) {
    res.redirect(`${config.APP_URL}/?error=login_cancelled`);
    return;
  }
  delete req.session.oauthState;
  try {
    const { tokens } = await google.getToken(req.query.code);
    const ticket = await google.verifyIdToken({
      idToken: tokens.id_token!,
      audience: config.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    if (!p?.email || !p.email_verified) throw new Error("Unverified email");
    const {
      rows: [u],
    } = await db.query(
      "INSERT INTO users(id,google_sub,email,name,avatar_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,name=excluded.name,avatar_url=excluded.avatar_url RETURNING id",
      [randomUUID(), p.sub, p.email, p.name || p.email, p.picture],
    );
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((e) => (e ? reject(e) : resolve())),
    );
    req.session.userId = u.id;
    await new Promise<void>((resolve, reject) =>
      req.session.save((e) => (e ? reject(e) : resolve())),
    );
    res.redirect(config.APP_URL);
  } catch {
    res.redirect(`${config.APP_URL}/?error=login_failed`);
  }
});
app.use("/api", (req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.get("origin");
    if (origin && origin !== new URL(config.APP_URL).origin) {
      res.status(403).json({ error: "Request origin not allowed." });
      return;
    }
  }
  next();
});
app.post("/api/logout", requireUser, (req, res) =>
  req.session.destroy(() => {
    res.clearCookie("outbox.sid");
    res.json({ ok: true });
  }),
);
app.get("/api/me", requireUser, async (req, res) => {
  const u = await user(req);
  if (!u) {
    res.status(401).json({ error: "Session expired." });
    return;
  }
  const {
    rows: [slack],
  } = await db.query(
    "SELECT team_name,channel_name,connected_at FROM slack_connections WHERE user_id=$1",
    [u.id],
  );
  const {
    rows: [slackNotification],
  } = await db.query(
    "SELECT r.state,r.limit_value,r.notified_at,r.error,r.created_at,s.email AS sender_email FROM rate_events r JOIN senders s ON s.id=r.sender_id WHERE r.user_id=$1 ORDER BY r.created_at DESC LIMIT 1",
    [u.id],
  );
  res.json({
    ...u,
    operator: u.email.toLowerCase() === config.OPERATOR_EMAIL?.toLowerCase(),
    slack: slack || null,
    slack_notification: slackNotification || null,
  });
});
app.get("/api/senders", requireUser, async (req, res) => {
  await provisionDefaultSenders(req.session.userId!);
  res.json(
    (
      await db.query(
        "SELECT s.id,s.name,s.email,s.hourly_limit,s.hour_start,s.hour_count,(t.default_order=0) AS is_default FROM senders s JOIN sender_templates t ON t.id=s.template_id WHERE s.user_id=$1 AND NOT s.is_hidden ORDER BY t.default_order NULLS LAST,s.name,s.id",
        [req.session.userId],
      )
    ).rows,
  );
});
app.post("/api/senders", requireUser, async (req, res) => {
  const parsed = senderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  try {
    res.status(201).json(await addSender(req.session.userId!, parsed.data));
  } catch (error) {
    const e = error as {
      status?: number;
      message?: string;
      publicMessage?: string;
    };
    if (e.status) {
      res.status(e.status).json({ error: e.publicMessage || e.message });
      return;
    }
    console.error(
      "Add sender failed",
      (error as { code?: string }).code || "unknown",
    );
    res.status(503).json({
      error:
        "The sender could not be saved. Please retry. Your default sender is still available.",
    });
  }
});
app.patch("/api/senders/:id", requireUser, async (req, res) => {
  const limit = req.body.hourlyLimit;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > config.MAX_EMAILS_PER_HOUR_PER_SENDER
  ) {
    res.status(400).json({
      error: `Choose a limit between 1 and ${config.MAX_EMAILS_PER_HOUR_PER_SENDER}.`,
    });
    return;
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) {
    res.status(404).json({ error: "Sender not found." });
    return;
  }
  const result = await transaction(async (c) => {
    const {
      rows: [s],
    } = await c.query(
      "UPDATE senders SET hourly_limit=$3 WHERE id=$1 AND user_id=$2 RETURNING *",
      [req.params.id, req.session.userId, limit],
    );
    if (!s) return null;
    if (
      new Date(s.hour_start).getTime() ===
        Math.floor(Date.now() / 3600000) * 3600000 &&
      s.hour_count >= limit
    ) {
      const id = randomUUID();
      const inserted = await c.query(
        "INSERT INTO rate_events(id,user_id,sender_id,hour_start,limit_value) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
        [id, s.user_id, s.id, s.hour_start, limit],
      );
      if (inserted.rowCount) await event(c, "slack", id);
    }
    return { id: s.id, hourly_limit: s.hourly_limit };
  });
  if (!result) {
    res.status(404).json({ error: "Sender not found." });
    return;
  }
  res.json(result);
});
app.post("/api/senders/provision", requireUser, async (req, res) => {
  const result = await provisionDefaultSenders(req.session.userId!, true);
  res.json(result);
});
app.delete("/api/senders/:id", requireUser, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) {
    res.status(404).json({ error: "Sender not found." });
    return;
  }
  const result = await db.query(
    "UPDATE senders s SET is_hidden=true FROM sender_templates t WHERE s.template_id=t.id AND s.id=$1 AND s.user_id=$2 AND t.default_order IS DISTINCT FROM 0 RETURNING s.id",
    [req.params.id, req.session.userId],
  );
  if (!result.rowCount) {
    const original = await db.query(
      "SELECT s.id FROM senders s JOIN sender_templates t ON t.id=s.template_id WHERE s.id=$1 AND s.user_id=$2 AND t.default_order=0",
      [req.params.id, req.session.userId],
    );
    if (original.rowCount) {
      res.status(403).json({
        error:
          "The default sender cannot be removed. You can remove additional senders.",
      });
      return;
    }
    res.status(404).json({ error: "Sender not found." });
    return;
  }
  res.json({ ok: true });
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});
app.post(
  "/api/leads/preview",
  requireUser,
  upload.single("file"),
  (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Choose a CSV or text file." });
      return;
    }
    try {
      const parsed = parseLeads(req.file.buffer.toString("utf8"));
      if (parsed.valid > config.MAX_RECIPIENTS)
        throw new Error(
          `Maximum ${config.MAX_RECIPIENTS} recipients per upload.`,
        );
      res.json(parsed);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  },
);
app.post("/api/campaigns", requireUser, async (req, res) => {
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }
  const p = parsed.data,
    key = req.get("Idempotency-Key");
  if (!key || key.length > 100) {
    res.status(400).json({ error: "A valid Idempotency-Key is required." });
    return;
  }
  if (
    p.recipients.length > config.MAX_RECIPIENTS ||
    p.delayMs < config.MIN_SEND_DELAY_MS ||
    p.hourlyLimit > config.MAX_EMAILS_PER_HOUR_PER_SENDER
  ) {
    res
      .status(400)
      .json({ error: "Scheduling settings exceed configured limits." });
    return;
  }
  const fingerprint = hash(JSON.stringify(p));
  const result = await transaction(async (c) => {
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
      req.session.userId,
    ]);
    const {
      rows: [old],
    } = await c.query(
      "SELECT id,request_hash FROM campaigns WHERE user_id=$1 AND idempotency_key=$2",
      [req.session.userId, key],
    );
    if (old) {
      if (old.request_hash !== fingerprint)
        throw Object.assign(
          new Error(
            "This submission key was already used for a different email.",
          ),
          { status: 409 },
        );
      return { id: old.id, replayed: true };
    }
    if (new Date(p.startAt).getTime() < Date.now() - 60000)
      throw Object.assign(new Error("Choose a start time in the future."), {
        status: 400,
      });
    const {
      rows: [sender],
    } = await c.query(
      "SELECT id FROM senders WHERE id=$1 AND user_id=$2 AND NOT is_hidden",
      [p.senderId, req.session.userId],
    );
    if (!sender)
      throw Object.assign(new Error("Sender not found."), { status: 404 });
    const recipients = [...new Set(p.recipients)],
      id = randomUUID();
    await c.query(
      "INSERT INTO campaigns(id,user_id,sender_id,subject,body,start_at,delay_ms,hourly_limit,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        id,
        req.session.userId,
        p.senderId,
        p.subject,
        p.body,
        p.startAt,
        p.delayMs,
        p.hourlyLimit,
        key,
        fingerprint,
      ],
    );
    for (let offset = 0; offset < recipients.length; offset += 250) {
      const batch = recipients
        .slice(offset, offset + 250)
        .map((recipient, i) => ({
          id: randomUUID(),
          recipient,
          sequence: offset + i,
          at: new Date(
            new Date(p.startAt).getTime() + (offset + i) * p.delayMs,
          ).toISOString(),
        }));
      await c.query(
        "INSERT INTO emails(id,user_id,sender_id,campaign_id,recipient,sequence,subject,body,scheduled_at,next_attempt_at) SELECT x.id,$2,$3,$4,x.recipient,x.sequence,$5,$6,x.at,x.at FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,recipient text,sequence int,at timestamptz)",
        [
          JSON.stringify(batch),
          req.session.userId,
          p.senderId,
          id,
          p.subject,
          p.body,
        ],
      );
      await c.query(
        "INSERT INTO outbox(id,kind,aggregate_id) SELECT gen_random_uuid(),kind,x.id FROM jsonb_to_recordset($1::jsonb) AS x(id uuid) CROSS JOIN (VALUES('send'),('index')) AS kinds(kind)",
        [JSON.stringify(batch)],
      );
    }
    return { id, count: recipients.length, replayed: false };
  });
  res.status(result.replayed ? 200 : 202).json(result);
});
app.get("/api/stats", requireUser, async (req, res) => {
  const { rows } = await db.query(
    "SELECT status,count(*)::int count FROM emails WHERE user_id=$1 GROUP BY status",
    [req.session.userId],
  );
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  res.json({
    scheduled: (counts.scheduled || 0) + (counts.sending || 0),
    sent: counts.sent || 0,
    failed: (counts.failed || 0) + (counts.unknown || 0),
  });
});
app.get("/api/emails", requireUser, async (req, res) => {
  const statuses =
    req.query.view === "sent"
      ? ["sent", "failed", "unknown"]
      : ["scheduled", "sending"];
  const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1)),
    limit = 20;
  const query =
    typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";
  if (query) {
    try {
      const found = await search.search<{ user_id: string }>({
        index,
        from: (page - 1) * limit,
        size: limit,
        track_total_hits: true,
        query: {
          bool: {
            filter: [
              { term: { user_id: req.session.userId } },
              { terms: { status: statuses } },
            ],
            must: [
              {
                simple_query_string: {
                  query,
                  fields: ["subject^3", "recipient.text^2", "body"],
                  default_operator: "and",
                },
              },
            ],
          },
        },
        sort: [{ created_at: "desc" }],
      });
      const ids = found.hits.hits.map((h) => h._id!);
      const { rows } = await db.query(
        "SELECT e.*,s.name sender_name,s.email sender_email FROM emails e JOIN senders s ON s.id=e.sender_id WHERE e.user_id=$1 AND e.id=ANY($2::uuid[]) AND e.status=ANY($3) ORDER BY e.created_at DESC",
        [req.session.userId, ids, statuses],
      );
      res.json({
        items: rows,
        total:
          typeof found.hits.total === "object"
            ? found.hits.total.value
            : found.hits.total || 0,
        page,
        search: true,
      });
    } catch {
      res.status(503).json({
        error:
          "Search is temporarily unavailable. Clear the search to view your emails.",
      });
    }
    return;
  }
  const { rows } = await db.query(
    `SELECT e.*,s.name sender_name,s.email sender_email FROM emails e JOIN senders s ON s.id=e.sender_id WHERE e.user_id=$1 AND e.status=ANY($2) ORDER BY ${req.query.view === "sent" ? "e.sent_at DESC NULLS LAST" : "e.next_attempt_at ASC"},e.id LIMIT $3 OFFSET $4`,
    [req.session.userId, statuses, limit, (page - 1) * limit],
  );
  const {
    rows: [count],
  } = await db.query(
    "SELECT count(*)::int total FROM emails WHERE user_id=$1 AND status=ANY($2)",
    [req.session.userId, statuses],
  );
  res.json({ items: rows, total: count.total, page, search: false });
});
app.get("/api/emails/:id", requireUser, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) {
    res.status(404).json({ error: "Email not found." });
    return;
  }
  const {
    rows: [e],
  } = await db.query(
    "SELECT e.*,s.name sender_name,s.email sender_email FROM emails e JOIN senders s ON s.id=e.sender_id WHERE e.id=$1 AND e.user_id=$2",
    [req.params.id, req.session.userId],
  );
  if (!e) {
    res.status(404).json({ error: "Email not found." });
    return;
  }
  res.json(e);
});
// Slack permits omitting redirect_uri in both OAuth steps to use the first saved
// Redirect URL. Keep both steps consistent; state still binds the installation.
const slackRedirectFields: Record<string, string> =
  config.SLACK_USE_DEFAULT_REDIRECT === "true"
    ? {}
    : {
        redirect_uri:
          config.SLACK_CALLBACK_URL || `${config.APP_URL}/auth/slack/callback`,
      };
app.get("/auth/slack", requireUser, (req, res) => {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
    res.redirect(`${config.APP_URL}/?error=slack_setup`);
    return;
  }
  req.session.slackState = randomBytes(24).toString("hex");
  const params = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID,
    scope: "incoming-webhook",
    ...slackRedirectFields,
    state: req.session.slackState,
  });
  req.session.save(() =>
    res.redirect(`https://slack.com/oauth/v2/authorize?${params}`),
  );
});
app.get("/auth/slack/callback", requireUser, async (req, res) => {
  // Slack can return an OAuth error before issuing a code. Preserve the
  // actionable reason for the UI instead of showing a generic failure.
  if (typeof req.query.error === "string") {
    const error = req.query.error;
    const stateOk = stateValid(req.query.state, req.session.slackState);
    delete req.session.slackState;
    const uiError =
      error === "invalid_team_for_non_distributed_app"
        ? "slack_non_distributed"
        : stateOk
          ? "slack_failed"
          : "slack_cancelled";
    res.redirect(`${config.APP_URL}/?error=${uiError}`);
    return;
  }
  if (
    !stateValid(req.query.state, req.session.slackState) ||
    typeof req.query.code !== "string"
  ) {
    res.redirect(`${config.APP_URL}/?error=slack_cancelled`);
    return;
  }
  delete req.session.slackState;
  try {
    const r = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      body: new URLSearchParams({
        client_id: config.SLACK_CLIENT_ID!,
        client_secret: config.SLACK_CLIENT_SECRET!,
        code: req.query.code,
        ...slackRedirectFields,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await r.json()) as any;
    if (!data.ok || !data.incoming_webhook?.url)
      throw new Error("Slack connection unsuccessful");
    const credentials = encrypt(
      JSON.stringify({
        webhook: data.incoming_webhook.url,
        token: data.access_token,
      }),
    );
    await transaction(async (c) => {
      await c.query(
        "INSERT INTO slack_connections(user_id,team_id,team_name,channel_name,credentials,generation) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET team_id=excluded.team_id,team_name=excluded.team_name,channel_name=excluded.channel_name,credentials=excluded.credentials,generation=excluded.generation,connected_at=now()",
        [
          req.session.userId,
          data.team.id,
          data.team.name,
          data.incoming_webhook.channel,
          credentials,
          randomUUID(),
        ],
      );
      // If a threshold was reached before Slack was connected, publish those
      // pending notifications now. This makes connecting Slack recoverable.
      const { rows: pending } = await c.query(
        "UPDATE rate_events SET state='pending',error=NULL WHERE user_id=$1 AND state IN ('skipped','error') RETURNING id",
        [req.session.userId],
      );
      for (const item of pending) {
        const {
          rows: [last],
        } = await c.query(
          "SELECT COALESCE(MAX(version),0)::int + 1 AS version FROM outbox WHERE kind='slack' AND aggregate_id=$1",
          [item.id],
        );
        await event(c, "slack", item.id, last.version);
      }
    });
    res.redirect(`${config.APP_URL}/?connected=slack`);
  } catch {
    res.redirect(`${config.APP_URL}/?error=slack_failed`);
  }
});
app.delete("/api/integrations/slack", requireUser, async (req, res) => {
  await db.query("DELETE FROM slack_connections WHERE user_id=$1", [
    req.session.userId,
  ]);
  res.json({ ok: true });
});
const adapter = new ExpressAdapter();
adapter.setBasePath("/admin/queues");
createBullBoard({
  queues: [emailQueue, indexQueue, slackQueue].map(
    (q) => new BullMQAdapter(q, { readOnlyMode: true }),
  ),
  serverAdapter: adapter,
});
app.use("/admin/queues", requireUser, requireOperator, adapter.getRouter());
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Endpoint not found." }),
);
app.use(express.static(path.resolve("dist/client")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(path.resolve("dist/client/index.html")),
);
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
    if (status >= 500) console.error("Request failed", err.code || err.name);
    res.status(status).json({
      error:
        err instanceof SenderSetupError
          ? err.publicMessage
          : status < 500
            ? err.message
            : "Something went wrong. Please try again.",
    });
  },
);
await db.query(await readFile(path.resolve("server/schema.sql"), "utf8"));
const stopWorker = config.RUN_WORKER === "true" ? await startWorkers() : null;
const server = app.listen(config.PORT, "0.0.0.0", () =>
  console.log(`Outbox listening on ${config.PORT}`),
);
process.on("SIGTERM", async () => {
  server.close();
  if (stopWorker) await stopWorker();
  await Promise.all([
    emailQueue.close(),
    indexQueue.close(),
    slackQueue.close(),
  ]);
  await redis.quit();
  await db.end();
  process.exit(0);
});

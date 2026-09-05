import { randomUUID } from "node:crypto";
import type pg from "pg";
import { db, transaction } from "./db.js";
import { emailQueue, indexQueue, slackQueue, retention } from "./queues.js";
export async function event(
  c: pg.PoolClient,
  kind: string,
  id: string,
  version = 1,
) {
  await c.query(
    "INSERT INTO outbox(id,kind,aggregate_id,version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [randomUUID(), kind, id, version],
  );
}
export async function dispatchOnce() {
  return transaction(async (c) => {
    const { rows } = await c.query(
      "SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 100",
    );
    for (const e of rows) {
      const queue =
        e.kind === "send"
          ? emailQueue
          : e.kind === "index"
            ? indexQueue
            : slackQueue;
      let delay = 0;
      if (e.kind === "send") {
        const {
          rows: [mail],
        } = await c.query(
          "SELECT next_attempt_at,status FROM emails WHERE id=$1",
          [e.aggregate_id],
        );
        if (!mail || mail.status !== "scheduled") {
          await c.query("UPDATE outbox SET published_at=now() WHERE id=$1", [
            e.id,
          ]);
          continue;
        }
        delay = Math.max(
          0,
          new Date(mail.next_attempt_at).getTime() - Date.now(),
        );
      }
      await queue.add(
        e.kind,
        { id: e.aggregate_id },
        {
          jobId:
            e.kind === "send"
              ? `email-${e.aggregate_id}`
              : `${e.kind}-${e.aggregate_id}-${e.version}`,
          delay,
          attempts: e.kind === "send" ? 100 : 8,
          backoff: { type: "exponential", delay: 2000 },
          ...retention,
        },
      );
      await c.query("UPDATE outbox SET published_at=now() WHERE id=$1", [e.id]);
    }
    return rows.length;
  });
}
export async function recover() {
  await transaction(async (c) => {
    const { rows } = await c.query(
      "UPDATE emails SET status='unknown',error='Worker stopped during SMTP delivery. Review the Ethereal mailbox before retrying.',version=version+1 WHERE status='sending' AND claimed_at < now()-interval '3 minutes' RETURNING id,version",
    );
    for (const e of rows) await event(c, "index", e.id, e.version);
  });
  const { rows } = await db.query(
    "SELECT id,next_attempt_at FROM emails WHERE status='scheduled' ORDER BY next_attempt_at LIMIT 10000",
  );
  for (const e of rows) {
    const j = await emailQueue.getJob(`email-${e.id}`);
    if (!j)
      await emailQueue.add(
        "send",
        { id: e.id },
        {
          jobId: `email-${e.id}`,
          delay: Math.max(
            0,
            new Date(e.next_attempt_at).getTime() - Date.now(),
          ),
          attempts: 100,
          ...retention,
        },
      );
  }
}

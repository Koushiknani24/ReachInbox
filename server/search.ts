import { Client } from "@elastic/elasticsearch";
import { config, searchIndex } from "./config.js";
import { db } from "./db.js";
export const search = new Client({
  node: config.ELASTICSEARCH_URL,
  ...(config.ELASTICSEARCH_API_KEY
    ? { auth: { apiKey: config.ELASTICSEARCH_API_KEY } }
    : {}),
});
export const index = searchIndex;
export async function ensureIndex() {
  if (!(await search.indices.exists({ index })))
    await search.indices.create({
      index,
      mappings: {
        properties: {
          user_id: { type: "keyword" },
          sender_id: { type: "keyword" },
          recipient: { type: "keyword", fields: { text: { type: "text" } } },
          subject: { type: "text" },
          body: { type: "text" },
          status: { type: "keyword" },
          next_attempt_at: { type: "date" },
          sent_at: { type: "date" },
          created_at: { type: "date" },
        },
      },
    });
}
export async function indexEmail(id: string) {
  const {
    rows: [e],
  } = await db.query("SELECT * FROM emails WHERE id=$1", [id]);
  if (!e) return;
  await search.index({
    index,
    id,
    version: e.version,
    version_type: "external_gte",
    document: {
      user_id: e.user_id,
      sender_id: e.sender_id,
      recipient: e.recipient,
      subject: e.subject,
      body: e.body,
      status: e.status,
      next_attempt_at: e.next_attempt_at,
      sent_at: e.sent_at,
      created_at: e.created_at,
    },
  });
}

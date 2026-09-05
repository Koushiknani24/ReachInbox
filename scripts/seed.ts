import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { db, transaction } from "../server/db.js";
import { encrypt } from "../server/crypto.js";
const first = JSON.parse(await readFile(".secrets/ethereal.json", "utf8"));
const current = await db.query("SELECT id FROM sender_templates");
if (!current.rowCount) {
  const second = await nodemailer.createTestAccount();
  for (const [name, a] of [
    ["Lemuel Haag", first],
    [
      "Outreach sender",
      { host: second.smtp.host, user: second.user, pass: second.pass },
    ],
  ] as const) {
    const transport = nodemailer.createTransport({
      host: a.host,
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: a.user, pass: a.pass },
    });
    await transport.verify();
    transport.close();
    await db.query(
      "INSERT INTO sender_templates(id,name,email,credentials) VALUES($1,$2,$3,$4)",
      [randomUUID(), name, a.user, encrypt(JSON.stringify(a))],
    );
  }
  console.log("Two persistent Ethereal sender accounts verified and saved.");
} else console.log("Sender accounts already provisioned.");
await transaction(async (c) => {
  const original = await c.query(
    "UPDATE sender_templates SET default_order=0 WHERE email=$1 RETURNING id",
    [first.user],
  );
  if (!original.rowCount)
    throw new Error(
      "The original sender must be seeded before configuring defaults.",
    );
  await c.query(
    "UPDATE sender_templates SET default_order=1 WHERE id=(SELECT id FROM sender_templates WHERE email<>$1 ORDER BY name,id LIMIT 1)",
    [first.user],
  );
  await c.query(`INSERT INTO senders(id,user_id,template_id,name,email,credentials,hourly_limit)
    SELECT gen_random_uuid(),u.id,t.id,t.name,t.email,t.credentials,200 FROM users u CROSS JOIN sender_templates t
    WHERE t.default_order IS NOT NULL ON CONFLICT(user_id,template_id) DO NOTHING`);
});
console.log(
  "Original sender configured as the default for all existing and future accounts.",
);
await db.end();

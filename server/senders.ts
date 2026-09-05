import { transaction } from "./db.js";
import { config } from "./config.js";
import nodemailer from "nodemailer";
import { encrypt } from "./crypto.js";

export class SenderSetupError extends Error {
  status = 503;
  code = "SENDER_SETUP_UNAVAILABLE";
  publicMessage: string;
  constructor(message: string) {
    super(message);
    this.publicMessage = message;
  }
}

// User-owned sender records share only explicitly configured workspace defaults.
export async function provisionDefaultSenders(userId: string, restore = false) {
  try {
    return await transaction(async (c) => {
      await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
      const defaults = await c.query(
        "SELECT id FROM sender_templates WHERE default_order IS NOT NULL",
      );
      if (!defaults.rowCount)
        throw new SenderSetupError(
          "The default sender is not configured yet. Ask the workspace owner to finish sender setup, then retry.",
        );
      const result = await c.query(
        `INSERT INTO senders(id,user_id,template_id,name,email,credentials,hourly_limit)
         SELECT gen_random_uuid(),$1,id,name,email,credentials,$2 FROM sender_templates
         WHERE default_order IS NOT NULL
         ON CONFLICT(user_id,template_id) DO NOTHING RETURNING id`,
        [userId, config.MAX_EMAILS_PER_HOUR_PER_SENDER],
      );
      if (restore)
        await c.query(
          "UPDATE senders SET is_hidden=false WHERE user_id=$1 AND template_id IN (SELECT id FROM sender_templates WHERE default_order IS NOT NULL)",
          [userId],
        );
      // The original sender is permanent, including for accounts that hid it
      // before this rule was introduced. Keep its counters and record identity.
      await c.query(
        "UPDATE senders SET is_hidden=false WHERE user_id=$1 AND is_hidden AND template_id IN (SELECT id FROM sender_templates WHERE default_order=0)",
        [userId],
      );
      return { created: !!result.rowCount };
    });
  } catch (error) {
    if (error instanceof SenderSetupError) throw error;
    console.error(
      "Default sender setup failed",
      (error as { code?: string }).code || "unknown",
    );
    throw new SenderSetupError(
      "Your saved sender accounts could not be loaded. Retry sender setup in a moment. Existing scheduled emails are safe.",
    );
  }
}

export async function addSender(
  userId: string,
  input: { name: string; email: string; password: string },
) {
  if (config.SMTP_TRANSPORT !== "test") {
    const transport = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: input.email, pass: input.password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    try {
      await transport.verify();
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message =
        code === "EAUTH"
          ? "Ethereal rejected the email or password. Check both credentials and try again."
          : "Could not connect to Ethereal to verify this sender. Please try again shortly.";
      throw Object.assign(new Error(message), {
        status: code === "EAUTH" ? 400 : 503,
        publicMessage: message,
      });
    } finally {
      transport.close();
    }
  }
  return transaction(async (c) => {
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const {
      rows: [existing],
    } = await c.query(
      "SELECT id,is_hidden FROM senders WHERE user_id=$1 AND email=$2",
      [userId, input.email],
    );
    if (existing && !existing.is_hidden)
      throw Object.assign(
        new Error("This sender is already available in your account."),
        { status: 409 },
      );
    const {
      rows: [count],
    } = await c.query(
      "SELECT count(*)::int n FROM senders WHERE user_id=$1 AND NOT is_hidden",
      [userId],
    );
    if (count.n >= 10)
      throw Object.assign(
        new Error(
          "You can keep up to 10 senders. Remove an additional sender before adding another.",
        ),
        { status: 400 },
      );
    const credentials = encrypt(
      JSON.stringify({
        host: "smtp.ethereal.email",
        user: input.email,
        pass: input.password,
      }),
    );
    await c.query(
      "INSERT INTO sender_templates(id,name,email,credentials) VALUES(gen_random_uuid(),$1,$2,$3) ON CONFLICT(email) DO NOTHING",
      [input.name, input.email, credentials],
    );
    const {
      rows: [saved],
    } = await c.query(
      `INSERT INTO senders(id,user_id,template_id,name,email,credentials,hourly_limit)
      SELECT gen_random_uuid(),$1,id,$2,$3,$4,$5 FROM sender_templates WHERE email=$3
      ON CONFLICT(user_id,template_id) DO UPDATE SET is_hidden=false,name=excluded.name,credentials=excluded.credentials
      RETURNING id,name,email,hourly_limit`,
      [
        userId,
        input.name,
        input.email,
        credentials,
        config.MAX_EMAILS_PER_HOUR_PER_SENDER,
      ],
    );
    return saved;
  });
}

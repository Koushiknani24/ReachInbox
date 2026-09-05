import dotenv from "dotenv";
dotenv.config({ path: process.env.SECRET_ENV_FILE || ".env.local" });
dotenv.config();
import { z } from "zod";
const env = z
  .object({
    NODE_ENV: z.string().default("development"),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    ELASTICSEARCH_URL: z.string().default("http://localhost:9200"),
    ELASTICSEARCH_API_KEY: z.string().optional(),
    SESSION_SECRET: z.string().min(32),
    ENCRYPTION_KEY: z.string().length(64),
    APP_URL: z.string().url().default("http://localhost:5173"),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: z.string().optional(),
    SLACK_CLIENT_ID: z.string().optional(),
    SLACK_CLIENT_SECRET: z.string().optional(),
    SLACK_CALLBACK_URL: z.string().optional(),
    SLACK_USE_DEFAULT_REDIRECT: z.enum(["true", "false"]).default("false"),
    OPERATOR_EMAIL: z.string().email().optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    MIN_SEND_DELAY_MS: z.coerce.number().int().min(100).default(2000),
    MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce
      .number()
      .int()
      .positive()
      .default(200),
    MAX_RECIPIENTS: z.coerce.number().int().positive().default(10000),
    SMTP_TRANSPORT: z.enum(["ethereal", "test"]).default("ethereal"),
    RUN_WORKER: z.string().default("false"),
  })
  .parse(process.env);
if (env.NODE_ENV === "production" && env.SMTP_TRANSPORT === "test")
  throw new Error("Test transport cannot run in production");
export const config = env;
export const searchIndex = process.env.ELASTICSEARCH_INDEX || "outbox-emails";

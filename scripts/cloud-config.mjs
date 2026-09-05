import { readFileSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";
const local = dotenv.parse(readFileSync(".env.local"));
const url = process.argv[2];
if (!url || !url.startsWith("https://"))
  throw new Error("Pass a verified HTTPS application origin");
const cloud = {
  ...local,
  DATABASE_URL: local.DATABASE_URL.replace("127.0.0.1", "10.43.0.10"),
  REDIS_URL: local.REDIS_URL.replace("127.0.0.1", "10.43.0.10"),
  ELASTICSEARCH_URL: "http://10.43.0.10:9200",
  APP_URL: url,
  GOOGLE_CALLBACK_URL: `${url}/auth/google/callback`,
  SLACK_CALLBACK_URL: `${url}/auth/slack/callback`,
  SLACK_USE_DEFAULT_REDIRECT: "true",
  RUN_WORKER: "true",
};
writeFileSync(
  ".secrets/cloud.env",
  Object.entries(cloud)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
);
console.log("Cloud environment prepared privately.");

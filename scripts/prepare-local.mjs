import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
mkdirSync(".secrets", { recursive: true });
if (!existsSync(".secrets/infra.env"))
  writeFileSync(
    ".secrets/infra.env",
    `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}\nREDIS_PASSWORD=${randomBytes(24).toString("hex")}\n`,
  );
if (!existsSync(".env.local")) {
  const infra = Object.fromEntries(
    readFileSync(".secrets/infra.env", "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split("=")),
  );
  writeFileSync(
    ".env.local",
    `DATABASE_URL=postgresql://outbox:${infra.POSTGRES_PASSWORD}@127.0.0.1:5432/outbox\nREDIS_URL=redis://:${infra.REDIS_PASSWORD}@127.0.0.1:6379\nELASTICSEARCH_URL=http://127.0.0.1:9200\nSESSION_SECRET=${randomBytes(32).toString("hex")}\nENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nAPP_URL=http://localhost:5173\nOPERATOR_EMAIL=vullikoushik03@gmail.com\n`,
  );
}
const text = readFileSync("ethernal-mail-info.txt", "utf8");
const user = text.match(/Username\s*\r?\n([^\r\n]+)/)?.[1],
  pass = text.match(/Password\s*\r?\n([^\r\n]+)/)?.[1];
if (user && pass)
  writeFileSync(
    ".secrets/ethereal.json",
    JSON.stringify({ host: "smtp.ethereal.email", user, pass }),
  );
console.log("Private environment and SMTP configuration prepared.");

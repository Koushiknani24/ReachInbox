import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { config } from "./config.js";
export function encrypt(value: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(config.ENCRYPTION_KEY, "hex"),
      iv,
    );
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    data.toString("hex"),
  ].join(".");
}
export function decrypt(value: string) {
  const [iv, tag, data] = value.split(".");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.ENCRYPTION_KEY, "hex"),
    Buffer.from(iv, "hex"),
  );
  cipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    cipher.update(Buffer.from(data, "hex")),
    cipher.final(),
  ]).toString("utf8");
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

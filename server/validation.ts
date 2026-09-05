import { z } from "zod";
import { parse } from "csv-parse/sync";
export function parseLeads(text: string) {
  const candidates: string[] = [];
  let rows: string[][];
  try {
    rows = parse(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
  } catch {
    throw new Error(
      "This CSV could not be read. Check quotation marks and separators.",
    );
  }
  const header =
    rows[0]?.findIndex((cell) =>
      /^(email|email address|email_address|e-mail)$/i.test(cell),
    ) ?? -1;
  for (const [i, row] of rows.entries()) {
    if (header >= 0 && i === 0) continue;
    const cells = header >= 0 ? [row[header] || ""] : row;
    for (const cell of cells)
      for (const token of cell.split(/[;\s]+/))
        if (token && (header >= 0 || row.length === 1 || token.includes("@")))
          candidates.push(token.trim());
  }
  const seen = new Set<string>();
  let invalid = 0,
    duplicates = 0;
  for (const candidate of candidates) {
    const at = candidate.lastIndexOf("@");
    const value =
      candidate.slice(0, at) + "@" + candidate.slice(at + 1).toLowerCase();
    if (!z.string().email().safeParse(value).success) {
      invalid++;
      continue;
    }
    if (seen.has(value)) duplicates++;
    else seen.add(value);
  }
  return {
    recipients: [...seen],
    valid: seen.size,
    invalid,
    duplicates,
    detected: candidates.length,
  };
}
export const campaignSchema = z.object({
  senderId: z.string().uuid(),
  subject: z.string().trim().min(1).max(250),
  body: z.string().trim().min(1).max(100000),
  recipients: z.array(z.string().email()).min(1).max(10000),
  startAt: z.string().datetime({ offset: true }),
  delayMs: z.number().int().min(100).max(86400000),
  hourlyLimit: z.number().int().min(1).max(10000),
});
export const senderSchema = z.object({
  name: z.string().trim().min(1, "Enter a sender name.").max(80),
  email: z
    .string()
    .trim()
    .email("Enter a valid sender email.")
    .refine(
      (value) => value.toLowerCase().endsWith("@ethereal.email"),
      "Use an Ethereal email address for this test workspace.",
    ),
  password: z.string().min(1, "Enter the Ethereal account password.").max(256),
});
export function nextHour(now: number) {
  return Math.floor(now / 3600000) * 3600000 + 3600000;
}

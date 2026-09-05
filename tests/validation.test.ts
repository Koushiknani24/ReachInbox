import { describe, it, expect } from "vitest";
import { parseLeads, nextHour, campaignSchema } from "../server/validation.js";
describe("Lead imports", () => {
  it("parses BOM, CRLF, quoted columns and duplicate recipients", () => {
    const p = parseLeads(
      '\ufeffname,email\r\n"Doe, Jane",jane@EXAMPLE.com\r\nOther,jane@example.com\r\nBob,bob@example.com',
    );
    expect(p.recipients).toEqual(["jane@example.com", "bob@example.com"]);
    expect(p.duplicates).toBe(1);
  });
  it("counts malformed email addresses and ignores blank lines", () => {
    const p = parseLeads("bad@\n\nvalid@example.com;second@example.com");
    expect(p.valid).toBe(2);
    expect(p.invalid).toBe(1);
  });
  it("preserves local-part spelling", () => {
    expect(parseLeads("Jane@Example.com").recipients).toEqual([
      "Jane@example.com",
    ]);
  });
  it("rejects a broken quoted CSV", () =>
    expect(() =>
      parseLeads('name,email\n"broken,email@example.com'),
    ).toThrow());
  it("never invents recipients in an empty/header-only file", () =>
    expect(parseLeads("name,email").valid).toBe(0));
});
describe("Schedule input", () => {
  const payload = {
    senderId: "02df8177-ff51-43ac-a0b2-2964b02e4cd0",
    subject: "Hello",
    body: "A message",
    recipients: ["you@example.com"],
    startAt: "2026-09-05T12:00:00+05:30",
    delayMs: 2000,
    hourlyLimit: 3,
  };
  it("accepts an explicitly offset timestamp", () =>
    expect(campaignSchema.safeParse(payload).success).toBe(true));
  it("rejects invalid recipients", () =>
    expect(
      campaignSchema.safeParse({ ...payload, recipients: ["invalid"] }).success,
    ).toBe(false));
  it("rejects empty content and zero limits", () => {
    expect(campaignSchema.safeParse({ ...payload, body: "   " }).success).toBe(
      false,
    );
    expect(
      campaignSchema.safeParse({ ...payload, hourlyLimit: 0 }).success,
    ).toBe(false);
  });
  it("rejects a timezone-less timestamp", () =>
    expect(
      campaignSchema.safeParse({ ...payload, startAt: "2026-09-05T12:00:00" })
        .success,
    ).toBe(false));
  it("advances UTC windows exactly at the boundary", () => {
    expect(nextHour(Date.parse("2026-09-05T12:59:59.999Z"))).toBe(
      Date.parse("2026-09-05T13:00:00Z"),
    );
    expect(nextHour(Date.parse("2026-09-05T13:00:00Z"))).toBe(
      Date.parse("2026-09-05T14:00:00Z"),
    );
  });
});

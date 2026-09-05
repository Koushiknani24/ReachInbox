import { describe, it, expect, vi, afterEach } from "vitest";
import nodemailer from "nodemailer";
vi.mock("../server/config.js", () => ({
  config: { SMTP_TRANSPORT: "ethereal", ENCRYPTION_KEY: "0".repeat(64) },
}));
vi.mock("../server/db.js", () => ({ transaction: vi.fn() }));
import { addSender } from "../server/senders.js";
import { transaction } from "../server/db.js";
import { senderSchema } from "../server/validation.js";
afterEach(() => vi.restoreAllMocks());
describe("Additional sender validation", () => {
  it("rejects missing credentials and unsupported mail providers", () => {
    expect(
      senderSchema.safeParse({
        name: "Test",
        email: "test@gmail.com",
        password: "secret",
      }).success,
    ).toBe(false);
    expect(
      senderSchema.safeParse({
        name: "Test",
        email: "test@ethereal.email",
        password: "",
      }).success,
    ).toBe(false);
  });
  it.each([
    ["EAUTH", 400, "Ethereal rejected the email or password"],
    ["ETIMEDOUT", 503, "Could not connect to Ethereal"],
  ])(
    "reports %s safely without persisting an unverified sender",
    async (code, status, message) => {
      const close = vi.fn();
      vi.spyOn(nodemailer, "createTransport").mockReturnValue({
        verify: vi.fn().mockRejectedValue({ code }),
        close,
      } as any);
      await expect(
        addSender("test-user", {
          name: "Test",
          email: "test@ethereal.email",
          password: "never-return-this",
        }),
      ).rejects.toMatchObject({
        status,
        message: expect.stringContaining(message),
      });
      expect(close).toHaveBeenCalledOnce();
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});

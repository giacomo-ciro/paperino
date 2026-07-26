import nodemailer from "nodemailer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendDigestEmail, sendTestEmail } from "./email.js";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail })),
  },
}));

describe("sendDigestEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMail.mockResolvedValue({});
  });

  it("uses Gmail SMTP and sends the digest from the configured sender to recipient", async () => {
    await sendDigestEmail(
      {
        senderAddress: "sender@gmail.com",
        recipientAddress: "digest@example.com",
        appPassword: "abcdefghijklmnop",
      },
      "Paperino (Monday, 5 January 2026)",
      "<h1>Paperino</h1><p>A paper &amp; its abstract</p>",
    );

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: "sender@gmail.com",
        pass: "abcdefghijklmnop",
      },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: "sender@gmail.com",
      to: "digest@example.com",
      subject: "Paperino (Monday, 5 January 2026)",
      html: "<h1>Paperino</h1><p>A paper &amp; its abstract</p>",
      text: "Paperino\nA paper & its abstract",
    });
  });

  it("sends a setup test email to the configured recipient", async () => {
    await sendTestEmail({
      senderAddress: "sender@gmail.com",
      recipientAddress: "digest@example.com",
      appPassword: "abcdefghijklmnop",
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: "sender@gmail.com",
      to: "digest@example.com",
      subject: "Paperino email test",
      html: "<p>Your Paperino email setup works.</p><p>Return to the terminal to finish configuration.</p>",
      text: "Your Paperino email setup works.\nReturn to the terminal to finish configuration.",
    });
  });
});

import nodemailer from "nodemailer";
import type { EmailConfig } from "./types.js";

function plainText(html: string): string {
  return html
    .replace(/<\/(?:p|h[1-6]|li|div)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendEmail(
  email: EmailConfig,
  subject: string,
  html: string,
): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: email.senderAddress,
      pass: email.appPassword,
    },
  });

  await transporter.sendMail({
    from: email.senderAddress,
    to: email.recipientAddress,
    subject,
    html,
    text: plainText(html),
  });
}

/** Send a digest through Gmail's SMTP service using a Google app password. */
export async function sendDigestEmail(
  email: EmailConfig,
  subject: string,
  html: string,
): Promise<void> {
  await sendEmail(email, subject, html);
}

/** Confirm Gmail delivery while the setup wizard still has the entered credentials. */
export async function sendTestEmail(email: EmailConfig): Promise<void> {
  await sendEmail(
    email,
    "Paperino email test",
    "<p>Your Paperino email setup works.</p><p>Return to the terminal to finish configuration.</p>",
  );
}

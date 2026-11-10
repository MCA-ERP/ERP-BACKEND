import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { HttpError } from "./http-error";

/**
 * Email over SMTP, so it works with any provider (Amazon SES, Brevo, Zoho, Google Workspace, Microsoft 365...).
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE (true for port 465), SMTP_USER, SMTP_PASS
 */
export const emailConfigured = () => Boolean(process.env.SMTP_HOST);

let cached: { key: string; transport: Transporter } | null = null;

function transport(): Transporter {
  if (!emailConfigured()) throw new HttpError(503, "Email is not configured. Add the SMTP settings to the backend .env.");
  const port = Number(process.env.SMTP_PORT || 587);
  const key = [process.env.SMTP_HOST, port, process.env.SMTP_SECURE, process.env.SMTP_USER].join("|");
  if (!cached || cached.key !== key) {
    cached = {
      key,
      transport: nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE === "true",
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        // never let message content reach the filesystem or the network
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    };
  }
  return cached.transport;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  fromName?: string;
  fromAddress?: string;
  replyTo?: string;
}

/** Sends one email and returns the provider's message id. Throws with a readable message on failure. */
export async function sendEmail(mail: Mail): Promise<string> {
  const address = mail.fromAddress || process.env.MAIL_FROM || process.env.SMTP_USER;
  if (!address) throw new HttpError(503, "Set a sender address under Settings → Email & SMS (or MAIL_FROM in the backend .env).");
  try {
    const info = await transport().sendMail({
      from: { name: mail.fromName || "My Class Assist", address },
      to: mail.to,
      replyTo: mail.replyTo || undefined,
      subject: mail.subject.replace(/[\r\n]+/g, " ").slice(0, 250),
      text: mail.text,
      html: mail.html,
    });
    return String(info.messageId ?? "");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new Error(err instanceof Error ? err.message : "The email could not be sent.");
  }
}

/** Opens a connection to the mail server and signs in, without sending anything. */
export async function verifyEmail(): Promise<void> {
  try {
    await transport().verify();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new Error(err instanceof Error ? err.message.slice(0, 300) : "Could not reach the mail server.");
  }
}

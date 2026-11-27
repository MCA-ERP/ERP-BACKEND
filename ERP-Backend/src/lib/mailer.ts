import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { HttpError } from "./http-error";

/**
 * Email over Brevo HTTP API (BREVO_API_KEY, works on platforms that block SMTP ports like Render)
 * or SMTP (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS).
 */
export const emailConfigured = () => Boolean(process.env.BREVO_API_KEY || process.env.SMTP_HOST);

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

/** Sends one email via Brevo HTTP API (when BREVO_API_KEY is set) or SMTP. */
export async function sendEmail(mail: Mail): Promise<string> {
  const address = mail.fromAddress || process.env.MAIL_FROM || process.env.SMTP_USER;
  if (!address) throw new HttpError(503, "Set a sender address under Settings → Email & SMS (or MAIL_FROM in the backend .env).");
  const subject = mail.subject.replace(/[\r\n]+/g, " ").slice(0, 250);
  const senderName = mail.fromName || "My Class Assist";

  if (process.env.BREVO_API_KEY) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sender: { name: senderName, email: address },
          to: [{ email: mail.to }],
          ...(mail.replyTo ? { replyTo: { email: mail.replyTo } } : {}),
          subject,
          textContent: mail.text,
          ...(mail.html ? { htmlContent: mail.html } : {}),
        }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { messageId?: string; message?: string };
      if (!res.ok) throw new Error(body.message || `Brevo API answered ${res.status}.`);
      return String(body.messageId ?? "");
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new Error(err instanceof Error && err.name === "AbortError" ? "Email provider timed out." : err instanceof Error ? err.message : "The email could not be sent.");
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const info = await transport().sendMail({
      from: { name: senderName, address },
      to: mail.to,
      replyTo: mail.replyTo || undefined,
      subject,
      text: mail.text,
      html: mail.html,
    });
    return String(info.messageId ?? "");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new Error(err instanceof Error ? err.message : "The email could not be sent.");
  }
}

/** Opens a connection to the mail server (or verifies Brevo API key), without sending anything. */
export async function verifyEmail(): Promise<void> {
  if (process.env.BREVO_API_KEY) {
    const res = await fetch("https://api.brevo.com/v3/account", {
      headers: { "api-key": process.env.BREVO_API_KEY, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Brevo API verification failed (${res.status}).`);
    return;
  }
  try {
    await transport().verify();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new Error(err instanceof Error ? err.message.slice(0, 300) : "Could not reach the mail server.");
  }
}

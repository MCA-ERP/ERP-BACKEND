import { supabaseAdmin } from "../../../db/client";
import { appUrl, notifySchool } from "./messaging.service";
import { sendDueAnnouncements } from "../admin/communication.service";
import { runLifecycle } from "../admin/subscriptions.service";
import { runEscalations } from "../admin/support-mgmt.service";
import { flushTelemetry, pruneTelemetry } from "../../lib/telemetry";
import { runRetention } from "../admin/security-mgmt.service";

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
const inr2 = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface ReminderResult {
  trialEnding: number;
  renewals: number;
  overdue: number;
}

/**
 * Sends the reminders due today. Every message carries a dedupe key built from what it is about,
 * so running this twice (or on two servers) never sends the same reminder twice.
 */
export async function runReminders(): Promise<ReminderResult> {
  const result: ReminderResult = { trialEnding: 0, renewals: 0, overdue: 0 };

  // trial ends in 3 days or tomorrow
  const trials = (await supabaseAdmin.from("platform_school_overview").select("id, name, trial_ends_on").eq("status", "Trial").in("trial_ends_on", [day(3), day(1)])).data ?? [];
  for (const s of trials as { id: string; trial_ends_on: string }[]) {
    const r = await notifySchool("trial_ending", s.id, { date: fmt(s.trial_ends_on), link: `${appUrl()}/school/billing` }, { relatedType: "reminder", relatedId: s.id, dedupe: `trial_ending:${s.id}:${s.trial_ends_on}:${day() === s.trial_ends_on ? "d0" : s.trial_ends_on > day(2) ? "d3" : "d1"}` });
    result.trialEnding += r.queued;
  }

  // subscription renews in 7 days
  const renewing = (await supabaseAdmin.from("platform_school_overview").select("id, renews_on").eq("status", "Active").eq("renews_on", day(7))).data ?? [];
  for (const s of renewing as { id: string; renews_on: string }[]) {
    const r = await notifySchool("renewal_reminder", s.id, { date: fmt(s.renews_on) }, { relatedType: "reminder", relatedId: s.id, dedupe: `renewal:${s.id}:${s.renews_on}` });
    result.renewals += r.queued;
  }

  // invoices that were due 1, 7 or 14 days ago and are still unpaid
  const overdue = (await supabaseAdmin
    .from("platform_invoice_overview")
    .select("id, number, institution_id, due_on, balance_paise")
    .eq("status", "Overdue")
    .in("due_on", [day(-1), day(-7), day(-14)])).data ?? [];
  for (const i of overdue as { id: string; number: string; institution_id: string; due_on: string; balance_paise: number }[]) {
    const r = await notifySchool(
      "invoice_overdue", i.institution_id,
      { invoice_number: i.number, amount: inr2(i.balance_paise), date: fmt(i.due_on), link: `${appUrl()}/school/billing` },
      { relatedType: "invoice", relatedId: i.id, dedupe: `overdue:${i.id}:${i.due_on}` }
    );
    result.overdue += r.queued;
  }
  return result;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Runs the reminders shortly after start-up and then every six hours. Set DISABLE_SCHEDULER=true to turn it off. */
export function startScheduler(): () => void {
  if (process.env.DISABLE_SCHEDULER === "true") return () => undefined;
  const lifecycle = () =>
    runLifecycle().then(
      (r) => r.trialsExpired + r.lapsed + r.expired > 0 && console.log("Subscription lifecycle:", r),
      (err) => console.error("Subscription lifecycle failed:", err instanceof Error ? err.message : err)
    );
  const tick = () =>
    pruneTelemetry().catch(() => undefined).then(() => runRetention().then((r) => r.login_events + r.audit_logs > 0 && console.log("Old records removed:", r)).catch(() => undefined)).then(() => lifecycle()).then(() => runReminders()).then(
      (r) => r.trialEnding + r.renewals + r.overdue > 0 && console.log("Reminders queued:", r),
      (err) => console.error("Reminder run failed:", err instanceof Error ? err.message : err)
    );
  const escalate = () =>
    runEscalations().then(
      (n) => n > 0 && console.log("Tickets escalated: " + n),
      (err) => console.error("Escalation run failed:", err instanceof Error ? err.message : err)
    );
  const due = () =>
    flushTelemetry().then(() => escalate()).then(() => sendDueAnnouncements()).then(
      (n) => n > 0 && console.log("Scheduled announcements sent: " + n),
      (err) => console.error("Scheduled announcements failed:", err instanceof Error ? err.message : err)
    );
  const first = setTimeout(tick, 60_000);
  const repeat = setInterval(tick, SIX_HOURS);
  const minute = setInterval(due, 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(repeat);
    clearInterval(minute);
  };
}

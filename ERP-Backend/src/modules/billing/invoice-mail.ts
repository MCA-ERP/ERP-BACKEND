import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { sendEmail } from "../../lib/mailer";
import { getSetting } from "../admin/settings.service";
import { logEvent, type Actor } from "../admin/school-mgmt.service";

const rupees = (p: number) => "Rs " + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Emails an invoice (or a payment reminder for it) to the school's contact. The send is recorded in the school's history. */
export async function emailInvoice(id: string, reminder: boolean, actor: Actor) {
  const inv = check(await supabaseAdmin.from("platform_invoice_overview").select("id, number, institution_id, description, issue_date, due_on, total_paise, balance_paise, status").eq("id", id).maybeSingle()) as
    | { id: string; number: string; institution_id: string; description: string; issue_date: string; due_on: string; total_paise: number; balance_paise: number; status: string } | null;
  if (!inv) throw new HttpError(404, "Invoice not found.");
  if (inv.status === "Void") throw new HttpError(409, "This invoice was voided.");
  if (reminder && inv.balance_paise <= 0) throw new HttpError(409, "This invoice is already paid.");
  const school = check(await supabaseAdmin.from("institutions").select("name, contact_email").eq("id", inv.institution_id).maybeSingle()) as { name: string; contact_email: string | null } | null;
  if (!school?.contact_email) throw new HttpError(409, "This school has no contact email. Add one on its profile first.");
  const footer = await getSetting<string>("billing.invoice_footer", "");
  const text = reminder
    ? `Hello ${school.name},\n\nThis is a reminder that invoice ${inv.number} (${inv.description}) has ${rupees(inv.balance_paise)} outstanding, due on ${inv.due_on}.\n\nPlease sign in to pay it, or reply to this email if you need help.\n\n${footer}`
    : `Hello ${school.name},\n\nYour invoice ${inv.number} for ${inv.description} is ready.\nIssued: ${inv.issue_date}\nDue: ${inv.due_on}\nTotal (incl. GST): ${rupees(inv.total_paise)}\n\nSign in to view and pay it.\n\n${footer}`;
  await sendEmail({ to: school.contact_email, subject: reminder ? `Payment reminder: invoice ${inv.number}` : `Invoice ${inv.number}`, text });
  await logEvent(inv.institution_id, reminder ? "invoice_reminder" : "invoice_emailed", `${reminder ? "Payment reminder" : "Invoice"} ${inv.number} emailed to ${school.contact_email}`, actor);
  return { sent_to: school.contact_email };
}

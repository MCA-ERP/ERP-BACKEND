import { supabaseAdmin } from "../../../db/client";
import { HttpError } from "../../lib/http-error";
import { answerFromData } from "./assist-actions";
import { runAgent } from "./assist-agent";
import type { Caller } from "./assist-agent";
import type { AssistAction } from "./assist-actions";

/**
 * "Ask AI" for the Super Admin portal. The assistant answers from a small snapshot of live counts (no names, emails or
 * other personal details) and its knowledge of the portal. It never changes data: it points to the page that does.
 * Runs on Groq (GROQ_API_KEY) or, if that is not set, Anthropic (ANTHROPIC_API_KEY). ASSIST_MODEL overrides the model.
 */
const provider = (): "groq" | "anthropic" | null => (process.env.GROQ_API_KEY ? "groq" : process.env.ANTHROPIC_API_KEY ? "anthropic" : null);
const MODEL = () => process.env.ASSIST_MODEL || (provider() === "groq" ? "openai/gpt-oss-120b" : "claude-sonnet-5-5");
export const assistConfigured = () => provider() !== null;
const NOT_SET = "The AI assistant is not set up yet. Ask the platform team to add GROQ_API_KEY to the server.";

export interface ChatMessage { role: "user" | "assistant"; content: string }

const count = async (table: string, filter?: (q: any) => any): Promise<number | null> => { // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    let q: any = supabaseAdmin.from(table).select("*", { count: "exact", head: true }); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (filter) q = filter(q);
    const { count: n, error } = await q;
    return error ? null : (n ?? 0);
  } catch {
    return null;
  }
};

/** Counts only. Anything that fails to load is simply left out. */
async function snapshot(): Promise<string> {
  const [schools, active, trial, pending, accounts, openTickets, overdue] = await Promise.all([
    count("institutions", (q) => q.is("deleted_at", null)),
    count("institutions", (q) => q.is("deleted_at", null).eq("status", "Active")),
    count("institutions", (q) => q.is("deleted_at", null).eq("status", "Trial")),
    count("institutions", (q) => q.is("deleted_at", null).eq("status", "Pending")),
    count("user_profiles"),
    count("support_tickets", (q) => q.in("status", ["Open", "In progress"])),
    count("platform_invoice_overview", (q) => q.eq("status", "Overdue")),
  ]);
  const rows: [string, number | null][] = [
    ["Schools registered", schools], ["Active schools", active], ["Schools on trial", trial], ["Schools awaiting approval", pending],
    ["User accounts with a profile", accounts], ["Open support tickets", openTickets], ["Overdue invoices", overdue],
  ];
  return rows.filter(([, n]) => n !== null).map(([k, n]) => `- ${k}: ${n}`).join("\n");
}

const PORTAL_MAP = `Modules in the Super Admin portal: Dashboard (overview, school/user/subscription statistics, revenue, activity monitor, alerts), School Management (registration, directory, profile, configuration, campuses, admins, status, documents, history), Subscription Management (plans, features, list, renewals, upgrades and downgrades, trials, discounts, billing), Module Management, User Management, Role & Permissions, Payment Management (transactions, invoices, refunds, gateway, tax, revenue), Support Management, Reports & Analytics, Communication, Website / CMS, Integration Management, Security & Audit, System Settings.`;

// A small per-person limit so the assistant cannot be used to run up costs.
const recent = new Map<string, number[]>();
function limit(who: string) {
  const now = Date.now();
  const list = (recent.get(who) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 12) throw new HttpError(429, "You are asking quickly. Wait a moment and try again.");
  list.push(now);
  recent.set(who, list);
}

/** Sends one request to the model and returns its text. */
async function ask(system: string, messages: ChatMessage[], maxTokens: number): Promise<string> {
  const which = provider();
  if (!which) throw new HttpError(503, NOT_SET);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40_000);
  try {
    const res = which === "groq"
      ? await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, temperature: 0.3, ...(MODEL().includes("gpt-oss") ? { reasoning_effort: "low" } : {}), messages: [{ role: "system", content: system }, ...messages] }),
          signal: controller.signal,
        })
      : await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY as string, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, system, messages }),
          signal: controller.signal,
        });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("Assistant request failed:", which, res.status, detail.slice(0, 300));
      throw new HttpError(
        502,
        res.status === 401 || res.status === 403
          ? "The AI assistant's key was rejected. Ask the platform team to check the key on the server."
          : res.status === 429
            ? "The AI assistant is busy right now. Try again in a minute."
            : "The AI assistant could not answer right now. Try again in a moment.",
      );
    }
    if (which === "groq") {
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return (body.choices?.[0]?.message?.content ?? "").trim();
    }
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (body.content ?? []).filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n").trim();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "The AI assistant did not respond in time. Try again in a moment.");
  } finally {
    clearTimeout(timer);
  }
}

export const NOTICE_KINDS = ["Maintenance notice", "Release notes", "Policy update"] as const;

/** Drafts an announcement from the platform team to school administrators. The person reviews and sends it themselves. */
export async function draftNotice(points: string, kind: (typeof NOTICE_KINDS)[number], who: string): Promise<{ draft: string }> {
  if (!assistConfigured()) throw new HttpError(503, NOT_SET);
  limit(who);
  const system = "You write clear, friendly notices for the My Class Assist platform team to send to school administrators. Reply with the notice only, no preamble. Never invent facts, dates or numbers: use only what you are given.";
  const task = `Write a ${kind.toLowerCase()} from the My Class Assist platform team to school administrators, from these points:\n${points}\n\nInclude a title, a short summary, the details as bullets, what schools need to do (say "No action needed" if the points say so), and the support contact support@myclassassist.in. Keep every fact exactly as given.`;
  const draft = await ask(system, [{ role: "user", content: task }], 900);
  return { draft: draft || "I could not draft that. Try adding a bit more detail." };
}

export async function chat(messages: ChatMessage[], page: string | undefined, who: string, user: Caller = { permissions: [] }): Promise<{ reply: string; actions: AssistAction[] }> {
  limit(who);
  // plain lists, counts and exports come straight from the data: exact, instant, and they work without the AI key
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (last) {
    try {
      const exact = await answerFromData(last.content);
      if (exact) return exact;
    } catch (err) {
      console.error("Assistant data answer failed:", err instanceof Error ? err.message : err);
    }
  }
  const which = provider();
  if (!which) throw new HttpError(503, NOT_SET);

  const system = [
    "You are MCA Assist, the assistant inside the My Class Assist Super Admin portal, for the platform team that runs a multi-tenant school ERP. You know this portal and its data completely.",
    "You have read-only tools to look things up in the live database. For ANY question about schools, users, logins, subscriptions, invoices, payments, tickets, security, messages or settings, call the tools and answer from what they return. Never guess or invent a figure, name or date. If a lookup fails or returns nothing, say so plainly.",
    "Work like this: if unsure which table holds something, call list_tables; call describe_table before using a table for the first time; then query or group_count. You may make several lookups for one question.",
    "When the person asks to export, download or get a file, call query with export=true. When it helps them get somewhere, call open_page_link with an address from the portal map. You cannot change anything: for actions, say which page to open and what to click.",
    "Answer directly and briefly in plain language. Write **bold** around page names and menu paths, joined with arrows, like **Role & Permissions → Permissions**. Use short lines or simple lists; never markdown tables, pipes or headings. Amounts are Indian rupees (columns ending _paise are paise, divide by 100). Use dates like 12 Oct 2026. The person is platform staff, so names and emails from the data are fine to show.",
    "NEVER show ids or UUIDs: people do not know them. Use the names (the *_name fields); if only an id is available, look up its name first (roles, plans, schools, modules, user_profiles) or leave it out.",
    "Call tools only through the tool-calling mechanism. NEVER write a tool call, a function name or braces into your answer. NEVER invent page addresses: take them only from portal_guide.",
    "When someone asks how to open or find a page, answer in one line with the bold path (for example: Open **Role & Permissions → Permissions**.), call open_page_link once so they get a button, and add nothing else. No explanation of where it is.",
    page ? `The person is currently on: ${page}` : "",
    "For where things are in the portal, or what a page does, call portal_guide.",
    `Live counts right now:\n${await snapshot()}`,
  ].filter(Boolean).join("\n\n");

  try {
    const out = await runAgent({ provider: which, model: MODEL(), system, messages: messages.slice(-12), user });
    return { reply: tidy(out.text) || "I could not come up with an answer. Try asking in another way.", actions: out.actions };
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("Assistant failed:", status, err instanceof Error ? err.message.slice(0, 300) : err);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, status === 401 || status === 403 ? "The AI assistant's key was rejected. Ask the platform team to check the key on the server." : status === 429 ? "The AI assistant is busy right now. Try again in a minute." : "The AI assistant could not answer right now. Try again in a moment.");
  }
}

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A safety net on the model's text: no raw ids, no tool-call text, no markdown tables. Bold (**) is kept: the panel shows it. */
export function tidy(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*\|?\s*:?-{3,}/.test(l))
    .map((l) => (/^\s*\|.*\|\s*$/.test(l) ? l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" · ") : l))
    .join("\n")
    .replace(/`?open_page_link\([^)]*\)`?/g, "")
    .replace(UUID_IN_TEXT, "")
    .replace(/\(\s*\)/g, "")
    .replace(/`/g, "")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

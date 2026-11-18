import { supabaseAdmin } from "../../../db/client";
import type { AssistAction } from "./assist-actions";
import { PORTAL_MENU } from "./portal-map";

/** Read-only access for the assistant. Each table belongs to an area of the portal; a person only reaches the areas they can open. */
const AREAS: Record<string, { area: string; about: string }> = {
  institutions: { area: "schools", about: "Schools (raw rows)" },
  platform_school_overview: { area: "schools", about: "Schools with plan, status, students, renewal and trial dates, contact. Best table for school questions." },
  school_contacts: { area: "schools", about: "Extra contacts of a school" },
  school_applications: { area: "schools", about: "Sign-up requests from the website" },
  school_events: { area: "schools", about: "History of a school (status changes, edits)" },
  school_documents: { area: "schools", about: "Documents uploaded for a school" },
  campuses: { area: "schools", about: "Campuses of schools" },
  institution_modules: { area: "modules", about: "Which modules each school has switched on" },
  subscriptions: { area: "subscriptions", about: "A school's subscription: plan, status, renewal and trial dates" },
  plans: { area: "subscriptions", about: "Subscription plans and prices" },
  plan_modules: { area: "subscriptions", about: "Modules included in each plan" },
  subscription_requests: { area: "subscriptions", about: "Upgrade, downgrade and renewal requests" },
  coupons: { area: "subscriptions", about: "Discount coupons" },
  offers: { area: "subscriptions", about: "Offers" },
  school_pricing: { area: "subscriptions", about: "Custom prices per school" },
  platform_invoice_overview: { area: "payments", about: "Invoices with school name, totals, paid, balance and status (Issued, Partially paid, Overdue, Paid, Void). Amounts are in paise." },
  invoices: { area: "payments", about: "Invoices (raw rows)" },
  invoice_lines: { area: "payments", about: "Invoice lines" },
  payments: { area: "payments", about: "Payments received" },
  payment_orders: { area: "payments", about: "Online payment attempts" },
  refunds: { area: "payments", about: "Refunds" },
  refund_requests: { area: "payments", about: "Refund requests" },
  modules: { area: "modules", about: "The module catalogue" },
  module_bundles: { area: "modules", about: "Module bundles" },
  feature_flags: { area: "modules", about: "Feature flags" },
  module_releases: { area: "modules", about: "Module versions" },
  user_profiles: { area: "users", about: "Every account (platform team, school staff, parents, students)" },
  platform_user_counts: { area: "users", about: "Account counts per school and role" },
  roles: { area: "roles", about: "Roles" },
  permissions: { area: "roles", about: "Permissions" },
  role_permissions: { area: "roles", about: "Which permission each role has" },
  students: { area: "users", about: "Students (counts per school are usually what is wanted)" },
  guardians: { area: "users", about: "Parents and guardians" },
  support_tickets: { area: "support", about: "Support tickets" },
  ticket_messages: { area: "support", about: "Messages on tickets" },
  ticket_categories: { area: "support", about: "Ticket categories" },
  ticket_escalations: { area: "support", about: "Escalated tickets" },
  kb_items: { area: "support", about: "Knowledge base articles" },
  school_feedback: { area: "support", about: "Feedback from schools" },
  login_events: { area: "security", about: "Every sign-in attempt: email, success, reason, IP, time" },
  audit_logs: { area: "security", about: "Who did what and when across the portal" },
  user_sessions: { area: "security", about: "Signed-in sessions" },
  security_incidents: { area: "security", about: "Reported security incidents" },
  ip_blocklist: { area: "security", about: "Blocked IP addresses" },
  ip_allowlist: { area: "security", about: "Allowed IP addresses" },
  access_denied_events: { area: "security", about: "Blocked attempts to open pages without permission" },
  announcements: { area: "communication", about: "Announcements sent to schools" },
  message_log: { area: "communication", about: "Emails, SMS and WhatsApp messages sent, with status" },
  message_templates: { area: "communication", about: "Message templates" },
  cms_items: { area: "cms", about: "Website pages, blog posts, FAQs, banners, testimonials" },
  languages: { area: "settings", about: "App languages" },
  platform_releases: { area: "settings", about: "Platform releases" },
};

/** Columns never shown to the model, whatever the table. */
const HIDDEN = /(password|secret|token|hash|otp|api_key|signature|credential|old_data|new_data|payload|raw_body|user_agent)/i;
const NL = String.fromCharCode(10);
const IDENT = /^[a-z_][a-z0-9_]*$/;
const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "ilike", "in", "is_null", "not_null"] as const;
type Op = (typeof OPS)[number];
interface Filter { column: string; op: Op; value?: unknown }

export interface Caller { role?: string; permissions: string[] }
const canOpen = (u: Caller, area: string) => u.role === "SuperAdmin" || u.permissions.includes(`platform.${area}.view`);

const clip = (v: unknown, max = 9000) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + `…[cut: ${s.length - max} more characters; ask for fewer columns or rows]` : s; };
const strip = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => !HIDDEN.test(k)));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Which table gives a readable name for an id column. */
const LOOKUPS: Record<string, { table: string; label: (r: Record<string, unknown>) => string; cols: string }> = {
  role_id: { table: "roles", cols: "id, display_name, name", label: (r) => String(r.display_name ?? r.name ?? "") },
  institution_id: { table: "institutions", cols: "id, name", label: (r) => String(r.name ?? "") },
  school_id: { table: "institutions", cols: "id, name", label: (r) => String(r.name ?? "") },
  plan_id: { table: "plans", cols: "id, name", label: (r) => String(r.name ?? "") },
  module_id: { table: "modules", cols: "id, name", label: (r) => String(r.name ?? "") },
};
const PEOPLE = ["assigned_to", "raised_by", "user_profile_id", "profile_id", "created_by", "updated_by", "actor_id", "reviewed_by"];
const person = (r: Record<string, unknown>) => (String(r.first_name ?? "") + " " + String(r.last_name ?? "")).trim();

/** Swaps id columns for the names people know (role, school, plan, module, person) so the model never has to show an id. */
async function nameify(rows: Record<string, unknown>[], keepId: boolean): Promise<Record<string, unknown>[]> {
  if (!rows.length) return rows;
  const cols = Object.keys(rows[0]).filter((c) => c.endsWith("_id") || PEOPLE.includes(c));
  const names = new Map<string, Map<string, string>>();
  for (const c of cols) {
    const spec = LOOKUPS[c] ?? (PEOPLE.includes(c) ? { table: "user_profiles", cols: "id, first_name, last_name", label: person } : null);
    if (!spec) continue;
    const ids = [...new Set(rows.map((r) => r[c]).filter((v): v is string => typeof v === "string" && UUID.test(v)))].slice(0, 200);
    if (!ids.length) continue;
    const { data } = await supabaseAdmin.from(spec.table).select(spec.cols).in("id", ids);
    names.set(c, new Map(((data ?? []) as unknown as Record<string, unknown>[]).map((r) => [String(r.id), spec.label(r)])));
  }
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      const map = names.get(k);
      if (map && typeof v === "string") { out[k.replace(/_id$/, "") + "_name"] = map.get(v) ?? null; if (keepId) out[k] = v; continue; }
      if (!keepId && (k === "id" || k.endsWith("_id")) && typeof v === "string" && UUID.test(v)) continue; // an id nobody can read
      out[k] = v;
    }
    return out;
  });
}

export const TOOLS = [
  { name: "list_tables", description: "List the data tables you can read, with what each holds. Call this first when you are unsure where something lives.", parameters: { type: "object", properties: {} } },
  { name: "describe_table", description: "Show the column names of a table, with one sample row. Use before querying a table you have not used yet.", parameters: { type: "object", properties: { table: { type: "string" } }, required: ["table"] } },
  {
    name: "query",
    description: "Read rows from a table. Filters are ANDed. Set count_only to just count. Set export to true when the person wants the rows as a file (Excel/PDF/CSV): it attaches an export button with ALL matching rows (up to 5000). Money columns ending in _paise are paise: divide by 100 for rupees.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string" },
        columns: { type: "array", items: { type: "string" }, description: "Columns to return. Omit for all." },
        filters: { type: "array", items: { type: "object", properties: { column: { type: "string" }, op: { type: "string", enum: [...OPS] }, value: {} }, required: ["column", "op"] } },
        order_by: { type: "string" },
        ascending: { type: "boolean" },
        limit: { type: "integer", description: "Rows to return, at most 50." },
        count_only: { type: "boolean" },
        export: { type: "boolean" },
        export_label: { type: "string", description: "Short name for the export button, like 'Export schools in Telangana'." },
      },
      required: ["table"],
    },
  },
  {
    name: "group_count",
    description: "Count rows per value of one column (for example schools per state, tickets per status). Looks at up to 5000 rows.",
    parameters: { type: "object", properties: { table: { type: "string" }, column: { type: "string" }, filters: { type: "array", items: { type: "object", properties: { column: { type: "string" }, op: { type: "string", enum: [...OPS] }, value: {} }, required: ["column", "op"] } } }, required: ["table", "column"] },
  },
  { name: "portal_guide", description: "How the portal is organised: every module, submenu and page with its address. Call with a module name (like 'payments') for detail, or with no module for the list of modules. Use it to explain where something is or what a page does.", parameters: { type: "object", properties: { module: { type: "string" } } } },
  { name: "open_page_link", description: "Offer a button that opens a portal page. Use an address from the portal map, like /super-admin/payments/invoices.", parameters: { type: "object", properties: { href: { type: "string" }, label: { type: "string" } }, required: ["href", "label"] } },
] as const;

function applyFilters(q: any, filters: Filter[] | undefined) { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const f of filters ?? []) {
    if (!IDENT.test(f.column) || HIDDEN.test(f.column)) throw new Error(`Column '${f.column}' cannot be used.`);
    if (!OPS.includes(f.op)) throw new Error(`Unknown filter '${f.op}'.`);
    if (f.op === "is_null") q = q.is(f.column, null);
    else if (f.op === "not_null") q = q.not(f.column, "is", null);
    else if (f.op === "in") q = q.in(f.column, (Array.isArray(f.value) ? f.value : [f.value]).slice(0, 100));
    else if (f.op === "ilike") q = q.ilike(f.column, String(f.value));
    else q = q[f.op](f.column, f.value);
  }
  return q;
}

/** Runs one tool call. Returns the text for the model; exports and links go into `actions`. */
export async function runTool(name: string, input: Record<string, unknown>, user: Caller, actions: AssistAction[]): Promise<string> {
  try {
    if (name === "list_tables") {
      return clip(Object.entries(AREAS).filter(([, v]) => canOpen(user, v.area)).map(([t, v]) => `${t}: ${v.about}`));
    }
    if (name === "portal_guide") {
      const mod = String(input.module ?? "").toLowerCase().trim();
      const blocks = PORTAL_MENU.split(NL).reduce<string[][]>((acc, line) => { if (!line.startsWith(" ")) acc.push([line]); else acc[acc.length - 1]?.push(line); return acc; }, []);
      if (!mod) return blocks.map((x) => x[0]).join(NL);
      const hit = blocks.filter((x) => x[0].toLowerCase().includes(mod));
      return hit.length ? hit.map((x) => x.join(NL)).join(NL) : "No such module. Call portal_guide with no module for the list.";
    }
    if (name === "open_page_link") {
      const href = String(input.href ?? "");
      const known = new Set([...PORTAL_MENU.matchAll(/\(\/super-admin\/([a-z0-9-]+\/[a-z0-9-]+)\)/gi)].map((m) => m[1]));
      const path = href.split("?")[0].replace(/^\/super-admin\//, "");
      if (!known.has(path)) return "That address is not in the portal. Call portal_guide and use an address from it.";
      actions.push({ kind: "link", label: String(input.label ?? "Open page").slice(0, 60), href });
      return "Button added.";
    }
    const table = String(input.table ?? "");
    const meta = AREAS[table];
    if (!meta) return `No table named '${table}'. Call list_tables.`;
    if (!canOpen(user, meta.area)) return `This person cannot open the ${meta.area} area, so you cannot read ${table}. Say so politely.`;

    if (name === "describe_table") {
      const { data, error } = await supabaseAdmin.from(table).select("*").limit(1);
      if (error) return `Error: ${error.message}`;
      const row = (data ?? [])[0] as Record<string, unknown> | undefined;
      return row ? clip({ columns: Object.keys(strip(row)), sample: strip(row) }) : "The table is empty, so its columns cannot be listed.";
    }

    if (name === "group_count") {
      const column = String(input.column ?? "");
      if (!IDENT.test(column) || HIDDEN.test(column)) return "That column cannot be used.";
      const q = applyFilters(supabaseAdmin.from(table).select(column).limit(5000), input.filters as Filter[] | undefined);
      const { data, error } = await q;
      if (error) return `Error: ${error.message}`;
      const tally = new Map<string, number>();
      for (const r of (data ?? []) as unknown as Record<string, unknown>[]) { const k = String(r[column] ?? "(empty)"); tally.set(k, (tally.get(k) ?? 0) + 1); }
      let entries = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
      const named = await nameify(entries.map(([k]) => ({ [column]: k })), false);
      if (named.length && Object.keys(named[0]).some((k) => k.endsWith("_name"))) entries = entries.map(([k, n], i) => [String(Object.values(named[i])[0] ?? k), n] as [string, number]);
      return clip({ rows_looked_at: (data ?? []).length, counts: Object.fromEntries(entries) });
    }

    if (name === "query") {
      const filters = input.filters as Filter[] | undefined;
      const wanted = Array.isArray(input.columns) ? (input.columns as string[]).filter((c) => IDENT.test(c) && !HIDDEN.test(c)) : [];
      const select = wanted.length ? wanted.join(",") : "*";
      if (input.count_only === true) {
        const q = applyFilters(supabaseAdmin.from(table).select("*", { count: "exact", head: true }), filters);
        const { count, error } = await q;
        return error ? `Error: ${error.message}` : JSON.stringify({ count: count ?? 0 });
      }
      const exporting = input.export === true;
      const limit = exporting ? 5000 : Math.min(Math.max(Number(input.limit) || 20, 1), 50);
      let q = applyFilters(supabaseAdmin.from(table).select(select, { count: "exact" }), filters);
      if (typeof input.order_by === "string" && IDENT.test(input.order_by)) q = q.order(input.order_by, { ascending: input.ascending !== false });
      const { data, error, count } = await q.limit(limit);
      if (error) return `Error: ${error.message}. Call describe_table to check the column names.`;
      const stripped = ((data ?? []) as unknown as Record<string, unknown>[]).map(strip);
      const rows = await nameify(stripped, !exporting);
      if (exporting) {
        if (!rows.length) return "No rows match, so there is nothing to export.";
        const head = Object.keys(rows[0]);
        actions.push({ kind: "export", label: String(input.export_label ?? `Export ${table}`).slice(0, 60), name: table.replace(/_/g, "-"), head, rows: rows.map((r) => head.map((h) => (typeof r[h] === "object" && r[h] !== null ? JSON.stringify(r[h]) : (r[h] as string | number | null)))), auto: true });
        return clip({ exported_rows: rows.length, note: "An export window opens for the person. Tell them how many rows are in it.", first_rows: rows.slice(0, 5) });
      }
      return clip({ total_matching: count ?? rows.length, returned: rows.length, rows });
    }
    return `Unknown tool '${name}'.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : "the lookup failed"}`;
  }
}

// ═════════════ the model loop ═════════════
type Msg = { role: "user" | "assistant"; content: string };
interface Call { id: string; name: string; input: Record<string, unknown> }

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    // a per-minute token limit clears in seconds: wait it out once or twice instead of failing
    const m = res.status === 429 && attempt < 4 ? /try again in ([0-9.]+)(ms|s)/i.exec(text) : null;
    const waitMs = m ? Number(m[1]) * (m[2].toLowerCase() === "ms" ? 1 : 1000) : null;
    if (waitMs !== null && waitMs <= 25_000) { await new Promise((r) => setTimeout(r, Math.ceil(waitMs) + 500)); continue; }
    throw Object.assign(new Error(text), { status: res.status });
  }
}

/** Lets the model look things up (read-only) until it has an answer. Works with Groq or Anthropic. */
export async function runAgent(opts: { provider: "groq" | "anthropic"; model: string; system: string; messages: Msg[]; user: Caller }): Promise<{ text: string; actions: AssistAction[] }> {
  const actions: AssistAction[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    if (opts.provider === "groq") {
      const history: any[] = [{ role: "system", content: opts.system }, ...opts.messages]; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (let round = 0; round < 7; round++) {
        const body = await post("https://api.groq.com/openai/v1/chat/completions", { authorization: `Bearer ${process.env.GROQ_API_KEY}` }, {
          model: opts.model, max_tokens: 1400, temperature: 0.2, ...(opts.model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
          messages: history, tools: TOOLS.map((t) => ({ type: "function", function: t })), tool_choice: "auto",
        }, controller.signal);
        const msg = body.choices?.[0]?.message ?? {};
        const calls = (msg.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[];
        if (!calls.length) return { text: String(msg.content ?? "").trim(), actions };
        history.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
        for (const c of calls) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(c.function.arguments || "{}"); } catch { /* the tool reports the missing fields */ }
          history.push({ role: "tool", tool_call_id: c.id, content: await runTool(c.function.name, input, opts.user, actions) });
        }
      }
      return { text: "That took more steps than I can do in one go. Try asking for something narrower.", actions };
    }
    const history: any[] = opts.messages.map((m) => ({ role: m.role, content: m.content })); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let round = 0; round < 7; round++) {
      const body = await post("https://api.anthropic.com/v1/messages", { "x-api-key": process.env.ANTHROPIC_API_KEY as string, "anthropic-version": "2023-06-01" }, {
        model: opts.model, max_tokens: 1400, system: opts.system, messages: history, tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      }, controller.signal);
      const blocks = (body.content ?? []) as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      const calls: Call[] = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id as string, name: b.name as string, input: b.input ?? {} }));
      if (!calls.length) return { text: blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim(), actions };
      history.push({ role: "assistant", content: blocks });
      const results = [];
      for (const c of calls) results.push({ type: "tool_result", tool_use_id: c.id, content: await runTool(c.name, c.input, opts.user, actions) });
      history.push({ role: "user", content: results });
    }
    return { text: "That took more steps than I can do in one go. Try asking for something narrower.", actions };
  } finally {
    clearTimeout(timer);
  }
}

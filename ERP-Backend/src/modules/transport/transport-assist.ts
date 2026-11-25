import { supabaseAdmin } from "../../../db/client";
import { scopeRule } from "../../lib/assist-scope";
import { HttpError } from "../../lib/http-error";
import type { AssistAction } from "../admin/assist-actions";
import { runAgent } from "../admin/assist-agent";
import type { ChatMessage } from "../admin/assist.service";
import { MODEL, NOT_SET, limit, provider, tidy } from "../admin/assist.service";
import { allocations } from "../school/transport.service";
import * as p from "./transport-portal.service";

/**
 * The assistant inside the Transport portal. Its tools read the school's vehicles, routes, trips and riders (the school and
 * the person come from the signed-in account, never from the question), carry no phone numbers or fee amounts owed, and
 * change nothing.
 */
const trim = (v: unknown, max = 9000) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + "…[cut]" : s; };

const TOOLS = [
  { name: "transport_today", description: "Transport today: vehicles on the road, students on transport, trips done and delayed, each route's current trip and next stop, seats used, and everything needing attention.", parameters: { type: "object", properties: {} } },
  { name: "vehicle_list", description: "Vehicles with registration, model, seats, route, status and every document's expiry date.", parameters: { type: "object", properties: {} } },
  { name: "stops_and_trips", description: "Stops with timings and students per route, and recent trips.", parameters: { type: "object", properties: {} } },
  { name: "riders", description: "Students on transport: name, class, route and stop. Optional search by name, class, route or stop.", parameters: { type: "object", properties: { search: { type: "string" } } } },
  { name: "my_notifications", description: "What needs the transport manager's attention now.", parameters: { type: "object", properties: {} } },
  { name: "portal_guide", description: "Every page of the Transport portal with its address. Call it to explain where something is or to find an address for open_page_link.", parameters: { type: "object", properties: {} } },
  { name: "open_page_link", description: "Offer a button that opens a Transport portal page, using an address from portal_guide.", parameters: { type: "object", properties: { href: { type: "string" }, label: { type: "string" }, go: { type: "boolean", description: "true when the person asked to open the page" } }, required: ["href"] } },
] as const;

async function runTool(inst: string, me: string, name: string, input: Record<string, unknown>, actions: AssistAction[], guide: string): Promise<string> {
  try {
    if (name === "transport_today") return trim(await p.dashboard(inst));
    if (name === "vehicle_list") { const f = await p.fleet(inst); return trim({ vehicles: f.items.map((v) => ({ name: v.name, reg_no: v.reg_no, model: v.model, seats: v.seats, route: v.route, status: v.status, documents: f.docs.filter((d) => d.vehicle_id === v.id).map((d) => `${d.doc_type}: ${d.valid_until ?? "no date"} (${d.state})`) })) }); }
    if (name === "stops_and_trips") return trim(await p.network(inst));
    if (name === "riders") {
      const q = String(input.search ?? "").toLowerCase();
      const items = (await allocations(inst)).items.filter((x) => !q || `${x.student} ${x.class_label} ${x.route} ${x.stop}`.toLowerCase().includes(q));
      return trim({ count: items.length, students: items.slice(0, 60).map((x) => ({ name: x.student, class: x.class_label, route: x.route, stop: x.stop })) });
    }
    if (name === "my_notifications") return trim((await p.notifications(inst, me)).items.map((n) => ({ title: n.title, detail: n.note, unread: !n.read })));
    if (name === "portal_guide") return guide || "No page list was sent.";
    if (name === "open_page_link") {
      const href = String(input.href ?? "");
      if (!/^\/transport(\/[a-z0-9-]+){0,2}(\?[a-z0-9=&_-]*)?$/i.test(href) || !(guide.includes(`(${href.split("?")[0]})`) || href.split("?")[0] === "/transport")) return "That address is not in the portal. Call portal_guide and use an address from it.";
      actions.push({ kind: "link", label: String(input.label ?? "Open page").slice(0, 60), href, go: input.go === true });
      return "Button added.";
    }
    return `Unknown tool '${name}'.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : "the lookup failed"}`;
  }
}

export async function transportChat(messages: ChatMessage[], page: string | undefined, guide: string, inst: string, me: string, roleLabel: string): Promise<{ reply: string; actions: AssistAction[] }> {
  const which = provider();
  if (!which) throw new HttpError(503, NOT_SET);
  limit(me);
  const { data } = await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle();
  const school = (data as { name: string } | null)?.name ?? "the school";
  const system = [
    `You are MCA Assist, the assistant inside the Transport portal of ${school}, on the My Class Assist school ERP. You are talking to ${roleLabel || "the transport manager"}. You know this portal and the school's vehicles, crew, routes, trips and riders.`,
    "You have read-only tools for this school's transport records. For ANY question about vehicles, documents, drivers, routes, stops, students on the bus, trips or notifications, call the tools and answer from what they return. Never guess or invent a number, name or date.",
    "When someone asks to open or go to a page (in English, Hindi or Telugu), call portal_guide if you need the address, then open_page_link with go=true, and confirm in one short line. Do not say a page is open unless you called the tool. When someone asks how to find a page, answer in one line with the bold path and call open_page_link.",
    "Answer directly and briefly in plain language. Write **bold** around page names and menu paths, joined with arrows. Use short lines or simple lists; never markdown tables, pipes or headings, and never write HTML. Reply in the language the person wrote or spoke in (English, Hindi or Telugu); keep page names in English. Never show ids or UUIDs. Dates like 12 Oct 2026.",
    page ? `The person is currently on: ${page}` : "",
    scopeRule("Transport portal", "this school's vehicles, drivers, routes, stops, bus trips, bus attendance, riders and how to use the portal", "student marks, fees owed, payroll or salaries, admission decisions, the platform or other schools"),
  ].filter(Boolean).join("\n\n");
  try {
    const out = await runAgent({ provider: which, model: MODEL(), system, messages: messages.slice(-12), user: { permissions: [] }, tools: TOOLS as never, run: (n, i, ac) => runTool(inst, me, n, i, ac, guide) });
    return { reply: tidy(out.text) || "I could not come up with an answer. Try asking in another way.", actions: out.actions };
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("Transport assistant failed:", status, err instanceof Error ? err.message.slice(0, 300) : err);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, status === 401 || status === 403 ? "The AI assistant's key was rejected. Ask the platform team to check the key on the server." : status === 429 ? "The AI assistant is busy right now. Try again in a minute." : "The AI assistant could not answer right now. Try again in a moment.");
  }
}

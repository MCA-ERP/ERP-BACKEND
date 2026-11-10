import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { parsePage, safeSearch } from "../../lib/query";
import { PRIORITIES } from "./support.service";

type Actor = { profileId?: string; name: string };
const OPEN = ["Open", "In progress", "Waiting on school"];
const ACTIVE_TIMER = ["Open", "In progress"]; // the clock pauses while the school owes a reply

// ═════════════ categories ═════════════
export const categorySchema = z.object({
  name: z.string().trim().min(2).max(50),
  description: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
  subtopics: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  default_priority: z.enum(PRIORITIES).nullable().optional(),
  default_agent_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(1000).optional(),
});

export async function listCategories() {
  const [cats, tickets, agents] = await Promise.all([
    supabaseAdmin.from("ticket_categories").select("*").order("sort_order"),
    supabaseAdmin.from("support_tickets").select("category, status, created_at, resolved_at").limit(20000),
    listAgents(),
  ]);
  const rows = check(tickets) as { category: string; status: string; created_at: string; resolved_at: string | null }[];
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  return (check(cats) as { id: string; name: string; default_agent_id: string | null }[]).map((c) => {
    const mine = rows.filter((t) => t.category === c.name);
    const done = mine.filter((t) => t.resolved_at);
    const avg = done.length ? done.reduce((a, t) => a + (new Date(t.resolved_at!).getTime() - new Date(t.created_at).getTime()), 0) / done.length / 3_600_000 : null;
    return { ...c, default_agent_name: c.default_agent_id ? agentName.get(c.default_agent_id) ?? null : null, tickets: mine.length, open: mine.filter((t) => OPEN.includes(t.status)).length, avg_resolution_hours: avg === null ? null : Math.round(avg * 10) / 10 };
  });
}

async function assertAgent(id: string | null | undefined) {
  if (!id) return;
  const a = check(await supabaseAdmin.from("user_profiles").select("id, status, institution_id").eq("id", id).maybeSingle()) as { status: string; institution_id: string | null } | null;
  if (!a || a.institution_id || a.status !== "active") throw new HttpError(400, "Choose an active member of your platform team.");
}

export async function saveCategory(id: string | null, input: Partial<z.infer<typeof categorySchema>>) {
  await assertAgent(input.default_agent_id);
  const q = id ? supabaseAdmin.from("ticket_categories").update(input).eq("id", id) : supabaseAdmin.from("ticket_categories").insert(input);
  const res = await q.select().maybeSingle();
  if (res.error) {
    if (res.error.code === "23505") throw new HttpError(409, "A category with that name already exists.");
    throw new HttpError(500, res.error.message);
  }
  if (!res.data) throw new HttpError(404, "Category not found.");
  return res.data;
}

export async function activeCategories() {
  return check(await supabaseAdmin.from("ticket_categories").select("name, description, subtopics, default_priority").eq("is_active", true).order("sort_order"));
}

// ═════════════ agents & assignment ═════════════
export async function listAgents() {
  const rows = check(
    await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, roles:role_id(name)").is("institution_id", null).eq("status", "active").order("first_name")
  ) as unknown as { id: string; first_name: string; last_name: string; roles: { name: string } | null }[];
  return rows.map((r) => ({ id: r.id, name: `${r.first_name} ${r.last_name}`.trim(), role: r.roles?.name ?? "" }));
}

/** Who is on the team and how much each person has open. */
export async function workload() {
  const [agents, open] = await Promise.all([
    listAgents(),
    supabaseAdmin.from("support_tickets").select("assigned_to, priority").in("status", OPEN).limit(20000),
  ]);
  const t = check(open) as { assigned_to: string | null; priority: string }[];
  return {
    agents: agents.map((a) => ({ ...a, open: t.filter((x) => x.assigned_to === a.id).length, urgent: t.filter((x) => x.assigned_to === a.id && ["Urgent", "High"].includes(x.priority)).length })),
    unassigned: t.filter((x) => !x.assigned_to).length,
  };
}

export async function assignTickets(ticketIds: string[], agentId: string, actor: Actor) {
  await assertAgent(agentId);
  const rows = check(await supabaseAdmin.from("support_tickets").update({ assigned_to: agentId }).in("id", ticketIds).select("id")) as { id: string }[];
  await note(rows.map((r) => r.id), `Assigned by ${actor.name}`, actor);
  return { assigned: rows.length };
}

/** Moves open tickets from one agent to another (all of them, or the chosen ones). */
export async function reassignTickets(fromAgent: string, toAgent: string, ticketIds: string[] | undefined, actor: Actor) {
  if (fromAgent === toAgent) throw new HttpError(400, "Choose two different people.");
  await assertAgent(toAgent);
  let q = supabaseAdmin.from("support_tickets").update({ assigned_to: toAgent }).eq("assigned_to", fromAgent).in("status", OPEN);
  if (ticketIds?.length) q = q.in("id", ticketIds);
  const rows = check(await q.select("id")) as { id: string }[];
  await note(rows.map((r) => r.id), `Reassigned by ${actor.name}`, actor);
  return { moved: rows.length };
}

/** A line in the ticket's thread that only staff see. */
async function note(ticketIds: string[], body: string, actor: Actor) {
  if (!ticketIds.length) return;
  await supabaseAdmin.from("ticket_messages").insert(ticketIds.map((ticket_id) => ({ ticket_id, author_id: actor.profileId ?? null, author_name: actor.name, body, is_internal: true })));
}

/** Picks up a new ticket's category defaults: the agent to give it to. */
export async function categoryDefaults(name: string): Promise<{ default_agent_id: string | null; default_priority: string | null } | null> {
  return check(await supabaseAdmin.from("ticket_categories").select("default_agent_id, default_priority, is_active").eq("name", name).maybeSingle()) as never;
}

// ═════════════ SLA & escalations ═════════════
export async function getSla() {
  const rows = check(await supabaseAdmin.from("sla_policies").select("*")) as { priority: string; first_response_hours: number; resolution_hours: number }[];
  return PRIORITIES.slice().reverse().map((p) => rows.find((r) => r.priority === p)!).filter(Boolean);
}

export async function setSla(priority: string, first: number, resolution: number) {
  if (!(PRIORITIES as readonly string[]).includes(priority)) throw new HttpError(400, "Unknown priority.");
  if (resolution < first) throw new HttpError(400, "The fix time cannot be shorter than the reply time.");
  check(await supabaseAdmin.from("sla_policies").upsert({ priority, first_response_hours: first, resolution_hours: resolution }, { onConflict: "priority" }).select("priority"));
  return getSla();
}

const HOUR = 3_600_000;
export function slaFor(t: { created_at: string; priority: string; status: string; first_response_at: string | null; resolved_at: string | null }, policy: { first_response_hours: number; resolution_hours: number } | undefined, now = Date.now()) {
  if (!policy) return null;
  const created = new Date(t.created_at).getTime();
  const responseDue = created + policy.first_response_hours * HOUR;
  const resolutionDue = created + policy.resolution_hours * HOUR;
  const live = ACTIVE_TIMER.includes(t.status);
  return {
    first_response_due: new Date(responseDue).toISOString(),
    resolution_due: new Date(resolutionDue).toISOString(),
    response_breached: !t.first_response_at && live && now > responseDue,
    resolution_breached: live && now > resolutionDue,
    waiting_on_school: t.status === "Waiting on school",
  };
}

export async function ticketSla(ticket: { created_at: string; priority: string; status: string; first_response_at: string | null; resolved_at: string | null }) {
  const p = check(await supabaseAdmin.from("sla_policies").select("*").eq("priority", ticket.priority).maybeSingle()) as { first_response_hours: number; resolution_hours: number } | null;
  return slaFor(ticket, p ?? undefined);
}

const bump = (p: string) => PRIORITIES[Math.min(PRIORITIES.length - 1, PRIORITIES.indexOf(p as (typeof PRIORITIES)[number]) + 1)];

async function escalateOne(t: { id: string; priority: string }, reason: "response_overdue" | "resolution_overdue" | "manual", noteText: string | null, actor?: Actor): Promise<boolean> {
  const to = bump(t.priority);
  const ins = await supabaseAdmin.from("ticket_escalations").insert({ ticket_id: t.id, reason, from_priority: t.priority, to_priority: to, note: noteText, escalated_by: actor?.profileId ?? null, escalator_name: actor?.name ?? "System" });
  if (ins.error) {
    if (ins.error.code === "23505") return false; // already escalated for this reason
    throw new HttpError(500, ins.error.message);
  }
  const cur = check(await supabaseAdmin.from("support_tickets").select("escalation_level").eq("id", t.id).single()) as { escalation_level: number };
  await supabaseAdmin.from("support_tickets").update({ priority: to, escalation_level: cur.escalation_level + 1 }).eq("id", t.id);
  await supabaseAdmin.from("ticket_messages").insert({ ticket_id: t.id, author_id: actor?.profileId ?? null, author_name: actor?.name ?? "System", is_internal: true, body: `Escalated (${reason.replace("_", " ")}): priority ${t.priority} → ${to}.${noteText ? " " + noteText : ""}` });
  return true;
}

export async function escalateTicket(id: string, noteText: string, actor: Actor) {
  if (!noteText.trim()) throw new HttpError(400, "Say why this ticket is being escalated.");
  const t = check(await supabaseAdmin.from("support_tickets").select("id, priority, status").eq("id", id).maybeSingle()) as { id: string; priority: string; status: string } | null;
  if (!t) throw new HttpError(404, "Ticket not found.");
  if (!OPEN.includes(t.status)) throw new HttpError(409, "Only an open ticket can be escalated.");
  await escalateOne(t, "manual", noteText.trim(), actor);
  return { success: true };
}

/** Escalates tickets that have outlived their targets. Safe to run often: each breach escalates once. */
export async function runEscalations(): Promise<number> {
  const [policies, tickets] = await Promise.all([
    supabaseAdmin.from("sla_policies").select("*"),
    supabaseAdmin.from("support_tickets").select("id, priority, status, created_at, first_response_at, resolved_at").in("status", ACTIVE_TIMER).limit(5000),
  ]);
  const pol = new Map((check(policies) as { priority: string; first_response_hours: number; resolution_hours: number }[]).map((p) => [p.priority, p]));
  let n = 0;
  for (const t of check(tickets) as { id: string; priority: string; status: string; created_at: string; first_response_at: string | null; resolved_at: string | null }[]) {
    const sla = slaFor(t, pol.get(t.priority));
    if (!sla) continue;
    // one escalation per run per ticket, response breaches first
    if (sla.response_breached && (await escalateOne(t, "response_overdue", "No reply within the target time."))) n++;
    else if (sla.resolution_breached && (await escalateOne({ ...t }, "resolution_overdue", "Not resolved within the target time."))) n++;
  }
  return n;
}

export async function listEscalations(query: Record<string, unknown>) {
  const p = parsePage(query);
  const res = await supabaseAdmin
    .from("ticket_escalations")
    .select("id, reason, from_priority, to_priority, note, escalator_name, created_at, support_tickets:ticket_id(id, code, subject, status, institutions:institution_id(name))", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  const overdue = await overdueNow();
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize, overdue_now: overdue };
}

async function overdueNow(): Promise<number> {
  const [policies, tickets] = await Promise.all([
    supabaseAdmin.from("sla_policies").select("*"),
    supabaseAdmin.from("support_tickets").select("priority, status, created_at, first_response_at, resolved_at").in("status", ACTIVE_TIMER).limit(5000),
  ]);
  const pol = new Map((check(policies) as { priority: string; first_response_hours: number; resolution_hours: number }[]).map((p) => [p.priority, p]));
  return (check(tickets) as { priority: string; status: string; created_at: string; first_response_at: string | null; resolved_at: string | null }[]).filter((t) => {
    const s = slaFor(t, pol.get(t.priority));
    return !!s && (s.response_breached || s.resolution_breached);
  }).length;
}

// ═════════════ knowledge base ═════════════
export const kbSchema = z.object({
  type: z.enum(["article", "faq", "tutorial"]),
  title: z.string().trim().min(3, "Enter a title.").max(255),
  category: z.string().trim().max(50).nullable().optional().transform((v) => v || null),
  body: z.string().trim().min(3, "Write the content.").max(50_000),
  video_url: z.string().trim().url("Enter a full https:// address.").max(500).nullable().optional().or(z.literal("").transform(() => null)),
  status: z.enum(["draft", "published"]).optional(),
  sort_order: z.number().int().min(0).max(10_000).optional(),
});

export async function listKb(query: Record<string, unknown>, publishedOnly = false) {
  let q = supabaseAdmin.from("kb_items").select(publishedOnly ? "id, type, title, category, body, video_url, views, helpful_yes, helpful_no, published_at" : "*").order("sort_order").order("created_at", { ascending: false }).limit(300);
  if (["article", "faq", "tutorial"].includes(String(query.type))) q = q.eq("type", String(query.type));
  if (publishedOnly) q = q.eq("status", "published");
  else if (["draft", "published"].includes(String(query.status))) q = q.eq("status", String(query.status));
  const s = safeSearch(query.search);
  if (s) q = q.or(`title.ilike.%${s}%,body.ilike.%${s}%`);
  return check(await q);
}

export async function saveKb(id: string | null, input: Partial<z.infer<typeof kbSchema>>, actor: Actor) {
  const update: Record<string, unknown> = { ...input };
  if (input.status === "published") update.published_at = new Date().toISOString();
  if (!id) update.created_by = actor.profileId ?? null;
  const q = id ? supabaseAdmin.from("kb_items").update(update).eq("id", id) : supabaseAdmin.from("kb_items").insert(update);
  const row = check(await q.select().maybeSingle());
  if (!row) throw new HttpError(404, "Item not found.");
  return row;
}
export async function deleteKb(id: string) {
  check(await supabaseAdmin.from("kb_items").delete().eq("id", id).select("id"));
  return { success: true };
}
export async function viewKb(id: string) {
  const row = check(await supabaseAdmin.from("kb_items").select("id, views").eq("id", id).eq("status", "published").maybeSingle()) as { id: string; views: number } | null;
  if (!row) throw new HttpError(404, "Not found.");
  await supabaseAdmin.from("kb_items").update({ views: row.views + 1 }).eq("id", id);
  return { success: true };
}
export async function voteKb(id: string, helpful: boolean) {
  const row = check(await supabaseAdmin.from("kb_items").select("id, helpful_yes, helpful_no").eq("id", id).eq("status", "published").maybeSingle()) as { helpful_yes: number; helpful_no: number } | null;
  if (!row) throw new HttpError(404, "Not found.");
  await supabaseAdmin.from("kb_items").update(helpful ? { helpful_yes: row.helpful_yes + 1 } : { helpful_no: row.helpful_no + 1 }).eq("id", id);
  return { success: true };
}

// ═════════════ feedback ═════════════
export async function submitFeedback(institutionId: string, author: Actor, input: { rating: number; comment?: string | null; ticket_id?: string | null }) {
  if (input.ticket_id) {
    const t = check(await supabaseAdmin.from("support_tickets").select("id, status").eq("id", input.ticket_id).eq("institution_id", institutionId).maybeSingle()) as { status: string } | null;
    if (!t) throw new HttpError(404, "Ticket not found.");
    if (!["Resolved", "Closed"].includes(t.status)) throw new HttpError(409, "You can rate a ticket once it is resolved.");
  }
  const res = await supabaseAdmin.from("school_feedback").insert({ institution_id: institutionId, ticket_id: input.ticket_id ?? null, rating: input.rating, comment: input.comment?.trim() || null, submitted_by: author.profileId ?? null, submitter_name: author.name }).select("id").single();
  if (res.error) {
    if (res.error.code === "23505") throw new HttpError(409, "You have already rated this ticket.");
    throw new HttpError(500, res.error.message);
  }
  return res.data;
}

export async function listFeedback(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("school_feedback")
    .select("id, rating, comment, submitter_name, created_at, institutions:institution_id(name), support_tickets:ticket_id(code, subject)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  const max = Number(query.max_rating);
  if (Number.isInteger(max) && max >= 1 && max <= 5) q = q.lte("rating", max);
  const [res, all] = await Promise.all([q, supabaseAdmin.from("school_feedback").select("rating").limit(20000)]);
  const ratings = (check(all) as { rating: number }[]).map((r) => r.rating);
  return {
    items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize,
    summary: { count: ratings.length, average: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null, distribution: [5, 4, 3, 2, 1].map((s) => ({ stars: s, count: ratings.filter((r) => r === s).length })) },
  };
}

// ═════════════ feature requests ═════════════
export const FEATURE_STATUSES = ["new", "planned", "in_progress", "shipped", "declined"] as const;

export async function listFeatures(institutionId?: string) {
  const [reqs, votes] = await Promise.all([
    supabaseAdmin.from("feature_requests").select("id, title, description, status, response, submitter_name, created_at, institutions:institution_id(name)").order("created_at", { ascending: false }).limit(300),
    supabaseAdmin.from("feature_votes").select("request_id, institution_id").limit(50000),
  ]);
  const v = check(votes) as { request_id: string; institution_id: string }[];
  const items = (check(reqs) as { id: string }[]).map((r) => ({ ...r, votes: v.filter((x) => x.request_id === r.id).length, voted: institutionId ? v.some((x) => x.request_id === r.id && x.institution_id === institutionId) : undefined }));
  return items.sort((a, b) => b.votes - a.votes);
}

export async function createFeature(institutionId: string, author: Actor, input: { title: string; description?: string | null }) {
  const row = check(await supabaseAdmin.from("feature_requests").insert({ institution_id: institutionId, title: input.title, description: input.description?.trim() || null, submitter_name: author.name }).select("id").single()) as { id: string };
  // the school that asked counts as the first vote
  await supabaseAdmin.from("feature_votes").insert({ request_id: row.id, institution_id: institutionId });
  return row;
}

/** Votes if the school has not, takes the vote back if it has. */
export async function toggleVote(institutionId: string, requestId: string) {
  const exists = check(await supabaseAdmin.from("feature_requests").select("id").eq("id", requestId).maybeSingle());
  if (!exists) throw new HttpError(404, "Request not found.");
  const had = check(await supabaseAdmin.from("feature_votes").select("request_id").eq("request_id", requestId).eq("institution_id", institutionId).maybeSingle());
  if (had) await supabaseAdmin.from("feature_votes").delete().eq("request_id", requestId).eq("institution_id", institutionId);
  else await supabaseAdmin.from("feature_votes").insert({ request_id: requestId, institution_id: institutionId });
  return { voted: !had };
}

export async function updateFeature(id: string, patch: { status?: (typeof FEATURE_STATUSES)[number]; response?: string | null }) {
  const row = check(await supabaseAdmin.from("feature_requests").update(patch).eq("id", id).select("id").maybeSingle());
  if (!row) throw new HttpError(404, "Request not found.");
  return { success: true };
}

/** Adds the response and fix deadlines to ticket rows or a single ticket. */
export async function decorateSla<T extends { priority: string; status: string; created_at: string; first_response_at?: string | null; resolved_at?: string | null }>(items: T[]): Promise<(T & { sla: ReturnType<typeof slaFor> })[]> {
  const pol = new Map((check(await supabaseAdmin.from("sla_policies").select("*")) as { priority: string; first_response_hours: number; resolution_hours: number }[]).map((p) => [p.priority, p]));
  return items.map((t) => ({ ...t, sla: slaFor({ created_at: t.created_at, priority: t.priority, status: t.status, first_response_at: t.first_response_at ?? null, resolved_at: t.resolved_at ?? null }, pol.get(t.priority)) }));
}

export async function ticketEscalations(ticketId: string) {
  return check(await supabaseAdmin.from("ticket_escalations").select("id, reason, from_priority, to_priority, note, escalator_name, created_at").eq("ticket_id", ticketId).order("created_at", { ascending: false }));
}

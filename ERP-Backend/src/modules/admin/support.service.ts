import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { parsePage, safeSearch } from "../../lib/query";
import { emitEvent } from "../integrations/events";
import { notifySchoolSafely } from "../messaging/messaging.service";

export const PRIORITIES = ["Low", "Medium", "High", "Urgent"] as const;
export const STATUSES = ["Open", "In progress", "Waiting on school", "Resolved", "Closed"] as const;

// open = nobody has picked it up; pending = being worked on or waiting on the school
const GROUPS: Record<string, string[]> = {
  open: ["Open"],
  pending: ["In progress", "Waiting on school"],
  resolved: ["Resolved", "Closed"],
};

const TICKET_SELECT =
  "id, code, subject, category, subtopic, priority, status, raised_by_name, assigned_to, created_at, updated_at, resolved_at, first_response_at, escalation_level, " +
  "institution_id, institutions:institution_id(name, code), assignee:assigned_to(first_name, last_name)";

// ── platform staff ──────────────────────────────────────────
export async function listTickets(query: Record<string, unknown>) {
  const p = parsePage(query);
  const group = typeof query.group === "string" ? GROUPS[query.group] : undefined;

  const apply = (q: any) => {
    const search = safeSearch(query.search);
    if (search) q = q.or(`subject.ilike.%${search}%,code.ilike.%${search}%`);
    if (query.priority) q = q.eq("priority", String(query.priority));
    if (typeof query.category === "string" && query.category) q = q.eq("category", query.category);
    if (query.assigned === "none") q = q.is("assigned_to", null);
    else if (typeof query.assigned === "string" && /^[0-9a-f-]{36}$/i.test(query.assigned)) q = q.eq("assigned_to", query.assigned);
    return q;
  };

  let list = apply(supabaseAdmin.from("support_tickets").select(TICKET_SELECT, { count: "exact" }))
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (group) list = list.in("status", group);

  const countOf = (statuses?: string[]) => {
    let q = apply(supabaseAdmin.from("support_tickets").select("*", { count: "exact", head: true }));
    if (statuses) q = q.in("status", statuses);
    return q;
  };
  const [res, all, open, pending, resolved] = await Promise.all([list, countOf(), countOf(GROUPS.open), countOf(GROUPS.pending), countOf(GROUPS.resolved)]);

  return {
    items: check(res),
    total: res.count ?? 0,
    page: p.page,
    pageSize: p.pageSize,
    counts: { all: all.count ?? 0, open: open.count ?? 0, pending: pending.count ?? 0, resolved: resolved.count ?? 0 },
  };
}

export async function getTicket(id: string, includeInternal = true) {
  const ticket = check(await supabaseAdmin.from("support_tickets").select(TICKET_SELECT).eq("id", id).maybeSingle());
  if (!ticket) throw new HttpError(404, "Ticket not found.");
  let q = supabaseAdmin
    .from("ticket_messages")
    .select("id, author_name, body, is_internal, created_at")
    .eq("ticket_id", id)
    .order("created_at");
  if (!includeInternal) q = q.eq("is_internal", false);
  return { ticket, messages: check(await q) };
}

export async function updateTicket(id: string, patch: { status?: string; priority?: string; assigned_to?: string | null }) {
  const update: Record<string, unknown> = { ...patch };
  if (patch.status) update.resolved_at = ["Resolved", "Closed"].includes(patch.status) ? new Date().toISOString() : null;
  const data = check(await supabaseAdmin.from("support_tickets").update(update).eq("id", id).select("id").maybeSingle());
  if (!data) throw new HttpError(404, "Ticket not found.");
  return getTicket(id);
}

export async function addStaffMessage(id: string, author: { profileId?: string; name: string }, body: string, internal: boolean) {
  const exists = check(await supabaseAdmin.from("support_tickets").select("id, status, first_response_at").eq("id", id).maybeSingle()) as { status: string; first_response_at: string | null } | null;
  if (!exists) throw new HttpError(404, "Ticket not found.");
  // the first public reply from staff stops the response clock
  if (!internal && !exists.first_response_at) await supabaseAdmin.from("support_tickets").update({ first_response_at: new Date().toISOString() }).eq("id", id);
  check(
    await supabaseAdmin
      .from("ticket_messages")
      .insert({ ticket_id: id, author_id: author.profileId ?? null, author_name: author.name, body, is_internal: internal })
      .select("id")
      .single()
  );
  // a public reply from staff means the next move is the school's
  if (!internal && exists.status === "Open") {
    await supabaseAdmin.from("support_tickets").update({ status: "Waiting on school" }).eq("id", id);
  }
  if (!internal) void emailTicketReply(id, body);
  return getTicket(id);
}

/** Tell the person who raised a ticket that support replied. Internal notes never come here. */
async function emailTicketReply(ticketId: string, message: string) {
  const t = (await supabaseAdmin
    .from("support_tickets")
    .select("code, subject, institution_id, raised:raised_by(first_name, email)")
    .eq("id", ticketId)
    .maybeSingle()).data as unknown as { code: string; subject: string; institution_id: string | null; raised: { first_name: string; email: string } | null } | null;
  if (!t?.institution_id || !t.raised?.email) return;
  notifySchoolSafely(
    "ticket_reply", t.institution_id, { ticket_code: t.code, ticket_subject: t.subject, message },
    { onlyEmail: { email: t.raised.email, name: t.raised.first_name }, relatedType: "ticket", relatedId: ticketId, channels: ["email"] }
  );
}

export async function listAgents() {
  const rows = check(
    await supabaseAdmin
      .from("user_profiles")
      .select("id, first_name, last_name, roles:role_id(name)")
      .is("institution_id", null)
      .eq("status", "active")
      .order("first_name")
  ) as unknown as { id: string; first_name: string; last_name: string; roles: { name: string } | null }[];
  return rows.map((r) => ({ id: r.id, name: `${r.first_name} ${r.last_name}`.trim(), role: r.roles?.name ?? "" }));
}

// ── schools raise and follow their own tickets ──────────────
export async function listSchoolTickets(institutionId: string) {
  return check(
    await supabaseAdmin
      .from("support_tickets")
      .select("id, code, subject, category, priority, status, created_at, updated_at")
      .eq("institution_id", institutionId)
      .order("created_at", { ascending: false })
      .limit(100)
  );
}

export async function createSchoolTicket(
  institutionId: string,
  author: { profileId?: string; name: string },
  input: { subject: string; category: string; subtopic?: string; priority?: string; body: string }
) {
  // the category decides the default priority and who the ticket goes to
  const cat = check(await supabaseAdmin.from("ticket_categories").select("name, is_active, default_agent_id, default_priority").eq("name", input.category).maybeSingle()) as
    | { is_active: boolean; default_agent_id: string | null; default_priority: string | null } | null;
  if (cat && !cat.is_active) throw new HttpError(400, "That category is no longer used. Choose another.");
  const priority = input.priority ?? cat?.default_priority ?? "Medium";
  const ticket = check(
    await supabaseAdmin
      .from("support_tickets")
      .insert({
        institution_id: institutionId,
        subject: input.subject,
        category: input.category,
        subtopic: input.subtopic ?? null,
        priority,
        assigned_to: cat?.default_agent_id ?? null,
        raised_by: author.profileId ?? null,
        raised_by_name: author.name,
      })
      .select("id")
      .single()
  ) as { id: string };

  const msg = await supabaseAdmin
    .from("ticket_messages")
    .insert({ ticket_id: ticket.id, author_id: author.profileId ?? null, author_name: author.name, body: input.body });
  if (msg.error) {
    await supabaseAdmin.from("support_tickets").delete().eq("id", ticket.id);
    throw new HttpError(500, msg.error.message);
  }
  emitEvent("ticket.created", { id: ticket.id, school_id: institutionId, subject: input.subject, priority });
  return getSchoolTicket(institutionId, ticket.id);
}

async function assertOwned(institutionId: string, id: string) {
  const row = check(await supabaseAdmin.from("support_tickets").select("id").eq("id", id).eq("institution_id", institutionId).maybeSingle());
  if (!row) throw new HttpError(404, "Ticket not found.");
}

export async function getSchoolTicket(institutionId: string, id: string) {
  await assertOwned(institutionId, id);
  return getTicket(id, false);
}

export async function addSchoolMessage(institutionId: string, id: string, author: { profileId?: string; name: string }, body: string) {
  await assertOwned(institutionId, id);
  check(
    await supabaseAdmin
      .from("ticket_messages")
      .insert({ ticket_id: id, author_id: author.profileId ?? null, author_name: author.name, body, is_internal: false })
      .select("id")
      .single()
  );
  // a reply reopens a ticket that was waiting on the school or already resolved
  await supabaseAdmin
    .from("support_tickets")
    .update({ status: "Open", resolved_at: null })
    .eq("id", id)
    .in("status", ["Waiting on school", "Resolved"]);
  return getTicket(id, false);
}

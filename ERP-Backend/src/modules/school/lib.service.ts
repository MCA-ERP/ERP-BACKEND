import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** Library: categories, publishers, authors and book copies. Titles and copies are counted from the books, never typed. */
const uid = z.string().uuid();
const lc = (s: string) => s.trim().toLowerCase();
type Book = { id: string; title: string; author: string; category: string; publisher: string; copies: number; available: number };
async function allBooks(inst: string) { return check(await supabaseAdmin.from("lib_books").select("id, title, author, category, publisher, copies, available").eq("institution_id", inst).limit(20000)) as Book[]; }
const dup = async (table: string, inst: string, col: string, v: string) => { if ((check(await supabaseAdmin.from(table).select("id").eq("institution_id", inst).ilike(col, v)) as unknown[]).length) throw new HttpError(409, "That already exists."); };
const toggle = async (table: string, inst: string, id: string, input: unknown) => {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from(table).update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
};

// ═════════════ categories ═════════════
export async function categories(inst: string) {
  const [c, b] = await Promise.all([supabaseAdmin.from("lib_categories").select("id, name, shelf, status").eq("institution_id", inst).order("name"), allBooks(inst)]);
  return { items: (check(c) as { id: string; name: string; shelf: string; status: string }[]).map((x) => { const bs = b.filter((y) => lc(y.category) === lc(x.name)); return { ...x, titles: bs.length, copies: bs.reduce((n, y) => n + y.copies, 0) }; }) };
}
export async function addCategory(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the category.").max(80), shelf: z.string().trim().max(30).optional() }).strict().parse(input);
  await dup("lib_categories", inst, "name", i.name);
  return check(await supabaseAdmin.from("lib_categories").insert({ institution_id: inst, name: i.name, shelf: i.shelf ?? "" }).select("id").single());
}
export const setCategory = (inst: string, id: string, input: unknown) => toggle("lib_categories", inst, id, input);
export async function categoriesFromBooks(inst: string) {
  const [have, b] = await Promise.all([categories(inst), allBooks(inst)]); const H = new Set(have.items.map((x) => lc(x.name)));
  const names = [...new Set(b.map((x) => x.category.trim()).filter((x) => x && !H.has(lc(x))))];
  if (names.length) check(await supabaseAdmin.from("lib_categories").insert(names.map((name) => ({ institution_id: inst, name }))).select("id")); return { added: names.length };
}

// ═════════════ publishers ═════════════
export async function publishers(inst: string) {
  const [p, b] = await Promise.all([supabaseAdmin.from("lib_publishers").select("id, name, city, contact, status").eq("institution_id", inst).order("name"), allBooks(inst)]);
  return { items: (check(p) as { id: string; name: string; city: string; contact: string; status: string }[]).map((x) => ({ ...x, titles: b.filter((y) => lc(y.publisher) === lc(x.name)).length })) };
}
export async function addPublisher(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the publisher.").max(80), city: z.string().trim().max(60).optional(), contact: z.string().trim().max(60).optional() }).strict().parse(input);
  await dup("lib_publishers", inst, "name", i.name);
  return check(await supabaseAdmin.from("lib_publishers").insert({ institution_id: inst, name: i.name, city: i.city ?? "", contact: i.contact ?? "" }).select("id").single());
}
export const setPublisher = (inst: string, id: string, input: unknown) => toggle("lib_publishers", inst, id, input);
export async function publishersFromBooks(inst: string) {
  const [have, b] = await Promise.all([publishers(inst), allBooks(inst)]); const H = new Set(have.items.map((x) => lc(x.name)));
  const names = [...new Set(b.map((x) => x.publisher.trim()).filter((x) => x && !H.has(lc(x))))];
  if (names.length) check(await supabaseAdmin.from("lib_publishers").insert(names.map((name) => ({ institution_id: inst, name }))).select("id")); return { added: names.length };
}

// ═════════════ authors ═════════════
export async function authors(inst: string) {
  const [a, b] = await Promise.all([supabaseAdmin.from("lib_authors").select("id, name, status").eq("institution_id", inst).order("name"), allBooks(inst)]);
  return { items: (check(a) as { id: string; name: string; status: string }[]).map((x) => { const bs = b.filter((y) => lc(y.author) === lc(x.name)); const top = [...bs].sort((p, q) => (q.copies - q.available) - (p.copies - p.available))[0]; return { ...x, titles: bs.length, most_issued: top && top.copies - top.available > 0 ? top.title : "—" }; }) };
}
export async function addAuthor(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the author.").max(120) }).strict().parse(input);
  await dup("lib_authors", inst, "name", i.name);
  return check(await supabaseAdmin.from("lib_authors").insert({ institution_id: inst, name: i.name }).select("id").single());
}
export const setAuthor = (inst: string, id: string, input: unknown) => toggle("lib_authors", inst, id, input);
export async function authorsFromBooks(inst: string) {
  const [have, b] = await Promise.all([authors(inst), allBooks(inst)]); const H = new Set(have.items.map((x) => lc(x.name)));
  const names = [...new Set(b.map((x) => x.author.trim()).filter((x) => x && !H.has(lc(x))))];
  if (names.length) check(await supabaseAdmin.from("lib_authors").insert(names.map((name) => ({ institution_id: inst, name }))).select("id")); return { added: names.length };
}

// ═════════════ copies ═════════════
async function syncBook(bookId: string) {
  const c = check(await supabaseAdmin.from("lib_copies").select("status").eq("book_id", bookId)) as { status: string }[];
  check(await supabaseAdmin.from("lib_books").update({ copies: c.length, available: c.filter((x) => x.status === "Available").length }).eq("id", bookId).select("id"));
}
export async function copies(inst: string) {
  const [c, b] = await Promise.all([supabaseAdmin.from("lib_copies").select("id, book_id, accession_no, barcode, shelf, call_no, status").eq("institution_id", inst).limit(20000), allBooks(inst)]);
  return { books: b.map((x) => ({ id: x.id, title: x.title })), items: (check(c) as { id: string; book_id: string; accession_no: string; barcode: string; shelf: string; call_no: string; status: string }[]).map((x) => ({ ...x, title: b.find((y) => y.id === x.book_id)?.title ?? "" })).sort((p, q) => Number(q.accession_no) - Number(p.accession_no)) };
}
export async function addCopies(inst: string, input: unknown) {
  const i = z.object({ book_id: uid, count: z.number().int().min(1).max(100), shelf: z.string().trim().max(30).optional(), call_no: z.string().trim().max(40).optional() }).strict().parse(input);
  if (!check(await supabaseAdmin.from("lib_books").select("id").eq("id", i.book_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Book not found.");
  const have = check(await supabaseAdmin.from("lib_copies").select("status").eq("book_id", i.book_id)) as { status: string }[];
  const b = check(await supabaseAdmin.from("lib_books").select("copies, available").eq("id", i.book_id).single()) as { copies: number; available: number };
  // copies already counted on the book but never given an accession number are kept, so the total only grows
  const rows = check(await supabaseAdmin.from("lib_copies").insert(Array.from({ length: i.count }, () => ({ institution_id: inst, book_id: i.book_id, shelf: i.shelf ?? "", call_no: i.call_no ?? "" }))).select("id, accession_no")) as { id: string; accession_no: string }[];
  for (const r of rows) check(await supabaseAdmin.from("lib_copies").update({ barcode: `BG${r.accession_no}` }).eq("id", r.id).eq("institution_id", inst).select("id"));
  check(await supabaseAdmin.from("lib_books").update({ copies: Math.max(b.copies, have.length) + i.count, available: Math.min(Math.max(b.copies, have.length) + i.count, b.available + i.count) }).eq("id", i.book_id).eq("institution_id", inst).select("id"));
  return { added: rows.length, first: rows[0]?.accession_no };
}
export async function setCopy(inst: string, id: string, input: unknown) {
  const i = z.object({ status: z.enum(["Available", "Issued"]).optional(), shelf: z.string().trim().max(30).optional(), call_no: z.string().trim().max(40).optional() }).strict().parse(input);
  const c = check(await supabaseAdmin.from("lib_copies").select("id, book_id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; book_id: string; status: string } | null; if (!c) throw new HttpError(404, "Not found.");
  check(await supabaseAdmin.from("lib_copies").update(i).eq("id", id).eq("institution_id", inst).select("id"));
  if (i.status && i.status !== c.status) { const b = check(await supabaseAdmin.from("lib_books").select("copies, available").eq("id", c.book_id).single()) as { copies: number; available: number }; check(await supabaseAdmin.from("lib_books").update({ available: Math.max(0, Math.min(b.copies, b.available + (i.status === "Issued" ? -1 : 1))) }).eq("id", c.book_id).eq("institution_id", inst).select("id")); }
  return { ok: true };
}
void syncBook;

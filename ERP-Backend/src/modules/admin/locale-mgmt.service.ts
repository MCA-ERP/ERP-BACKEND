import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getSetting } from "./settings.service";

/** The states and union territories a school can pick at sign-up. */
export const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh",
  "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland",
  "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
] as const;

/** Every state, how many schools are in it, and whether it is offered at sign-up. A state with schools cannot be switched off. */
export async function listStates() {
  const rows = check(await supabaseAdmin.from("institutions").select("state").not("state", "is", null).limit(10000)) as { state: string | null }[];
  const counts = new Map<string, number>();
  for (const r of rows) if (r.state) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const enabled = await getSetting<string[] | null>("regional.states", null);
  const names = [...new Set<string>([...INDIAN_STATES, ...counts.keys()])].sort((a, b) => a.localeCompare(b));
  return names.map((name) => {
    const schools = counts.get(name) ?? 0;
    return { name, schools, enabled: schools > 0 || !enabled || enabled.includes(name), locked: schools > 0 };
  });
}

// ═════════════ languages ═════════════
interface LangRow { code: string; name: string; status: "active" | "draft"; is_default: boolean; sort_order: number }

export async function listLanguages() {
  const [langs, keys, done] = await Promise.all([
    supabaseAdmin.from("languages").select("code, name, status, is_default, sort_order").order("sort_order").limit(100),
    supabaseAdmin.from("translation_keys").select("*", { count: "exact", head: true }),
    supabaseAdmin.from("translations").select("language_code").limit(50000),
  ]);
  const total = keys.count ?? 0;
  const per = new Map<string, number>();
  for (const r of (done.data ?? []) as { language_code: string }[]) per.set(r.language_code, (per.get(r.language_code) ?? 0) + 1);
  return ((langs.data ?? []) as LangRow[]).map((l) => ({ ...l, translated: l.is_default ? 100 : total ? Math.round(((per.get(l.code) ?? 0) / total) * 100) : 0 }));
}

export async function addLanguage(input: { name: string; code: string }) {
  const code = input.code.toLowerCase();
  const exists = check(await supabaseAdmin.from("languages").select("code").or(`code.eq.${code},name.ilike.${input.name.replace(/[,()%]/g, "")}`).limit(1)) as unknown[];
  if (exists.length) throw new HttpError(409, "That language is already in the list.");
  const last = check(await supabaseAdmin.from("languages").select("sort_order").order("sort_order", { ascending: false }).limit(1)) as { sort_order: number }[];
  return check(await supabaseAdmin.from("languages").insert({ code, name: input.name, status: "draft", sort_order: (last[0]?.sort_order ?? 0) + 1 }).select("code, name, status, is_default").single());
}

export async function setLanguageStatus(code: string, status: "active" | "draft") {
  const row = check(await supabaseAdmin.from("languages").select("is_default").eq("code", code).maybeSingle()) as { is_default: boolean } | null;
  if (!row) throw new HttpError(404, "Language not found.");
  if (row.is_default && status === "draft") throw new HttpError(400, "The default language stays published.");
  return check(await supabaseAdmin.from("languages").update({ status }).eq("code", code).select("code, name, status, is_default").single());
}

export async function listTranslations() {
  const [langs, keys, values] = await Promise.all([
    supabaseAdmin.from("languages").select("code, name").eq("status", "active").eq("is_default", false).order("sort_order"),
    supabaseAdmin.from("translation_keys").select("key, english").order("sort_order"),
    supabaseAdmin.from("translations").select("key, language_code, value").limit(50000),
  ]);
  const map: Record<string, Record<string, string>> = {};
  for (const v of (values.data ?? []) as { key: string; language_code: string; value: string }[]) (map[v.key] ??= {})[v.language_code] = v.value;
  return { languages: langs.data ?? [], keys: ((keys.data ?? []) as { key: string; english: string }[]).map((k) => ({ ...k, values: map[k.key] ?? {} })) };
}

/** Saves the phrases as typed. A phrase left empty is removed, so the language shows it as missing. */
export async function saveTranslations(values: Record<string, Record<string, string>>) {
  const upserts: { key: string; language_code: string; value: string; updated_at: string }[] = [];
  const removals: { key: string; code: string }[] = [];
  for (const [key, byLang] of Object.entries(values)) {
    for (const [code, raw] of Object.entries(byLang)) {
      const value = raw.trim();
      if (value) upserts.push({ key, language_code: code, value, updated_at: new Date().toISOString() });
      else removals.push({ key, code });
    }
  }
  if (upserts.length) check(await supabaseAdmin.from("translations").upsert(upserts, { onConflict: "key,language_code" }).select("key"));
  for (const r of removals) check(await supabaseAdmin.from("translations").delete().eq("key", r.key).eq("language_code", r.code).select("key"));
  return { saved: upserts.length, cleared: removals.length };
}

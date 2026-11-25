import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/**
 * The area around each campus where staff can check in from the mobile app, and the check-in rules.
 * A school that never saved rules keeps the earlier behaviour: only the radius is checked.
 */
export const WINDOWS = ["6:30 – 8:15 am", "6:30 – 9:00 am", "6:00 – 10:00 am", "Any time"] as const;
const WINDOW_MINUTES: Record<(typeof WINDOWS)[number], [number, number] | null> = { "6:30 – 8:15 am": [390, 495], "6:30 – 9:00 am": [390, 540], "6:00 – 10:00 am": [360, 600], "Any time": null };

export interface GeoRules { window: (typeof WINDOWS)[number]; selfie: boolean; field_anywhere: boolean; block_mock: boolean; home_online_days: boolean }
export const DEFAULT_RULES: GeoRules = { window: "6:30 – 8:15 am", selfie: true, field_anywhere: true, block_mock: true, home_online_days: false };

const rulesSchema = z.object({ window: z.enum(WINDOWS), selfie: z.boolean(), field_anywhere: z.boolean(), block_mock: z.boolean(), home_online_days: z.boolean() }).strict();

/** The rules the school saved, or null when it never did (or the columns are not there yet). */
export async function savedRules(inst: string): Promise<GeoRules | null> {
  const { data, error } = await supabaseAdmin.from("att_settings").select("geo_rules").eq("institution_id", inst).maybeSingle();
  if (error) return null;
  const parsed = rulesSchema.safeParse((data as { geo_rules: unknown } | null)?.geo_rules);
  return parsed.success ? parsed.data : null;
}

/** Whether an app check-in at this time of day ("HH:MM") is inside the saved window. */
export function inWindow(rules: GeoRules | null, hhmm: string): boolean {
  const w = rules ? WINDOW_MINUTES[rules.window] : null;
  if (!w) return true;
  const at = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return at >= w[0] && at <= w[1];
}

/** Drivers and attendants work away from the campus. */
export const isFieldStaff = (designation: string) => /driver|attendant|cleaner|conductor/i.test(designation);

interface Campus { id: string; name: string; latitude: number | null; longitude: number | null; geofence_m: number; geofence_covers: string | null }

export async function geoSettings(inst: string) {
  const [c, s, rules] = await Promise.all([
    supabaseAdmin.from("campuses").select("id, name, latitude, longitude, geofence_m, geofence_covers").eq("institution_id", inst).order("is_main", { ascending: false }).order("name"),
    supabaseAdmin.from("att_settings").select("late_after").eq("institution_id", inst).maybeSingle(),
    savedRules(inst),
  ]);
  return {
    windows: WINDOWS,
    campuses: (check(c) as unknown as Campus[]).map((x) => ({ id: x.id, name: x.name, latitude: x.latitude === null ? null : Number(x.latitude), longitude: x.longitude === null ? null : Number(x.longitude), radius_m: x.geofence_m, covers: x.geofence_covers ?? "" })),
    late_after: ((check(s) as { late_after: string } | null)?.late_after ?? "08:15").slice(0, 5),
    rules: rules ?? DEFAULT_RULES,
    saved: !!rules,
  };
}

export async function saveGeoSettings(inst: string, input: unknown) {
  const i = z.object({
    campuses: z.array(z.object({ id: z.string().uuid(), radius_m: z.number().int().min(20, "The radius is at least 20 metres.").max(5000, "The radius is at most 5,000 metres."), covers: z.string().trim().max(160), latitude: z.number().min(-90).max(90).nullable(), longitude: z.number().min(-180).max(180).nullable() }).strict()).max(50),
    late_after: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 08:00."),
    rules: rulesSchema,
  }).strict().parse(input);
  if (i.campuses.some((c) => (c.latitude === null) !== (c.longitude === null))) throw new HttpError(400, "Give both the latitude and the longitude, or neither.");
  // late-after is also part of the timetable's attendance rules: keep the two the same
  const cur = check(await supabaseAdmin.from("att_settings").select("config").eq("institution_id", inst).maybeSingle()) as { config: Record<string, unknown> | null } | null;
  const config = cur?.config && "late_after" in cur.config ? { ...cur.config, late_after: i.late_after } : cur?.config;
  check(await supabaseAdmin.from("att_settings").upsert({ institution_id: inst, late_after: i.late_after, geo_rules: i.rules, ...(config ? { config } : {}) }, { onConflict: "institution_id" }).select("institution_id"));
  for (const c of i.campuses) {
    const r = check(await supabaseAdmin.from("campuses").update({ geofence_m: c.radius_m, geofence_covers: c.covers || null, latitude: c.latitude, longitude: c.longitude }).eq("id", c.id).eq("institution_id", inst).select("id")) as unknown[];
    if (!r.length) throw new HttpError(404, "Campus not found.");
  }
  return geoSettings(inst);
}

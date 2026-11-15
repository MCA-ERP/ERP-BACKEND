import { getSettings } from "../modules/admin/settings.service";

export interface MaintenanceState {
  active: boolean;
  message: string;
  /** When it is planned to end, if known. */
  ends_at: string | null;
  /** When a planned window starts, if it has not started yet. */
  upcoming_at: string | null;
}

/** Pure, so it is easy to test. Maintenance is on when switched on by hand, or while a planned window is running. */
export function maintenanceFrom(s: Record<string, unknown>, now = Date.now()): MaintenanceState {
  const time = (v: unknown) => (typeof v === "string" && v ? new Date(v).getTime() : NaN);
  const start = time(s["maintenance.starts_at"]);
  const end = time(s["maintenance.ends_at"]);
  const inWindow = !Number.isNaN(start) && !Number.isNaN(end) && now >= start && now < end;
  const manual = s["maintenance.enabled"] === true;
  const message = typeof s["maintenance.message"] === "string" && s["maintenance.message"] ? (s["maintenance.message"] as string) : "We are upgrading the platform and will be back shortly.";
  return {
    active: manual || inWindow,
    message,
    ends_at: inWindow ? new Date(end).toISOString() : manual && !Number.isNaN(end) && end > now ? new Date(end).toISOString() : null,
    upcoming_at: !manual && !Number.isNaN(start) && start > now ? new Date(start).toISOString() : null,
  };
}

export async function maintenanceState(): Promise<MaintenanceState> {
  return maintenanceFrom(await getSettings());
}

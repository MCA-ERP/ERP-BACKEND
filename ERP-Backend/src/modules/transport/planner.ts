/**
 * The route planner: groups homes into stops within walking distance, then builds routes that keep each bus within its
 * seats and the longest ride within the limit. Pure: no database. Distances are straight lines stretched by ROAD.
 */
export const ROAD = 1.25;
export const KMPH = 25;
export const STOP_MIN = 0.8;

export interface Point { lat: number; lng: number }
export interface Home extends Point { area: string }
export interface Stop extends Point { name: string; area: string; homes: number }
export interface PlanRoute { name: string; stops: (Stop & { minutes: number })[]; areas: string[]; students: number; km: number; ride: number }
export interface Plan { routes: PlanRoute[]; buses: number; km_day: number; longest: number; average: number }
export interface Rules { seats: number; longest: number; walk: number }

/** Straight-line distance in kilometres. */
export function km(a: Point, b: Point) {
  const r = Math.PI / 180; const dLat = (b.lat - a.lat) * r; const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const drive = (a: Point, b: Point) => (km(a, b) * ROAD * 60) / KMPH;

const common = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? ""; };

/** Homes within walking distance of each other share a stop; a stop never holds more children than one bus. */
export function makeStops(school: Point, homes: Home[], walkM: number, seats: number): Stop[] {
  const left = [...homes].sort((a, b) => km(school, b) - km(school, a));
  const stops: Stop[] = [];
  while (left.length) {
    const seed = left.shift()!;
    const near = [seed];
    for (let i = 0; i < left.length && near.length < seats; i++) if (km(seed, left[i]) * 1000 <= walkM) near.push(...left.splice(i--, 1));
    const area = common(near.map((h) => h.area));
    const nth = stops.filter((s) => s.area === area).length + 1;
    stops.push({ lat: near.reduce((n, h) => n + h.lat, 0) / near.length, lng: near.reduce((n, h) => n + h.lng, 0) / near.length, area, name: area ? `${area} stop ${nth}` : `Stop ${stops.length + 1}`, homes: near.length });
  }
  return stops;
}

const rideOf = (school: Point, path: Stop[]) => path.reduce((t, s, i) => t + drive(s, path[i + 1] ?? school) + STOP_MIN, 0);

/** Start at the farthest stop left, then keep adding the nearest one while the seats and the ride allow it. */
export function plan(school: Point, homes: Home[], rules: Rules): Plan {
  const left = makeStops(school, homes, rules.walk, rules.seats).sort((a, b) => km(school, b) - km(school, a));
  const routes: PlanRoute[] = [];
  while (left.length) {
    const path = [left.shift()!];
    let seated = path[0].homes;
    for (;;) {
      const last = path[path.length - 1];
      const next = left.map((s, i) => ({ s, i, d: km(last, s) })).sort((a, b) => a.d - b.d)
        .find(({ s }) => seated + s.homes <= rules.seats && rideOf(school, [...path, s]) <= rules.longest);
      if (!next) break;
      path.push(next.s); seated += next.s.homes; left.splice(next.i, 1);
    }
    let t = 0;
    const timed = path.map((s, i) => { const at = Math.round(t); t += drive(s, path[i + 1] ?? school) + STOP_MIN; return { ...s, minutes: at }; });
    const dist = path.reduce((n, s, i) => n + km(s, path[i + 1] ?? school) * ROAD, 0);
    routes.push({ name: `New ${routes.length + 1}`, stops: timed, areas: [...new Set(path.map((s) => s.area).filter(Boolean))], students: seated, km: Math.round(dist * 10) / 10, ride: Math.round(t) });
  }
  const rides = routes.map((r) => r.ride);
  // two trips a day, each there and back
  return { routes, buses: routes.length, km_day: Math.round(routes.reduce((n, r) => n + r.km * 4, 0)), longest: Math.max(0, ...rides), average: rides.length ? Math.round(rides.reduce((a, b) => a + b, 0) / rides.length) : 0 };
}

import { Env, tflJson, Prediction } from "./tfl";
import routes from "./stokey-routes.json";
import data from "./stokey-stops.json";

// TfL publishes no coordinates for buses: `currentLocation` is always empty and
// the promised bus-location API was shelved in 2021. The only sanctioned live
// source is BODS SIRI-VM (operator TFLO), which needs its own API key.
//
// So we estimate. For a given bus we know, from /Vehicle/{ids}/Arrivals, its
// predicted arrival time at every stop still ahead of it. Take the next stop,
// work out how fast the bus is currently moving from the gap to the stop after
// that, and walk backwards along the route polyline by (time × speed).
//
// Accurate to roughly a block. Good enough to answer "has it passed me yet".

interface Route {
  poly: [number, number][]; // [lon, lat]
  stops: string[]; // naptan ids, in order
  idx: number[]; // which polyline vertex each stop sits on
}

const ROUTES = routes as unknown as Record<string, Route>;
const LONDON = data.london as Record<string, "in" | "out">;
const HOME: [number, number] = [data.home.lon, data.home.lat];

// The map pans, so pins are not clipped to a window. This only rejects a
// position the estimator could not plausibly have produced for a bus due here.
const MAX_PIN_KM = 12;

const FALLBACK_SPEED = 5.5; // m/s, ~20 km/h: an urban bus including dwell time
const FALLBACK_RAIL_SPEED = 14; // ~50 km/h: inner-suburban stopping service
const MIN_SPEED = 1.5;
const MAX_SPEED = 18;
const MAX_RAIL_SPEED = 40; // ~145 km/h

export interface Pin {
  line: string;
  dir: string;
  mode: "bus" | "rail";
  key: string; // matches the board row's data-key
  london: "in" | "out";
  to: string;
  lat: number;
  lon: number;
  bearing: number;
  etaMin: number; // at *our* stop, not its next stop
  /** When it reaches our stop. The pin counts down from this, as the rows do. */
  expected: string | null;
  stop: string;
  vehicleId: string;
  estimated: true;
}

/** What a caller must know about a vehicle before we can place it. */
export interface PinInput {
  vehicleId: string;
  etaMin: number;
  expected: string | null;
  to: string;
  stop: string;
  key: string;
  mode: "bus" | "rail";
  london: "in" | "out";
}

// A Weaver train could be on either branch; try both and take the one whose
// polyline actually contains the train's next two stations, in order.
const routeKeys = (line: string, dir: string) =>
  line === data.rail.line
    ? [`${line}|${dir}|enfield`, `${line}|${dir}|cheshunt`]
    : [`${line}|${dir}`];

function metres(a: [number, number], b: [number, number]): number {
  const R = 6371000, p = Math.PI / 180;
  const dLat = (b[1] - a[1]) * p, dLon = (b[0] - a[0]) * p;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a[1] * p) * Math.cos(b[1] * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Cumulative distance along each polyline. Computed once per isolate, not per request.
const cumCache = new Map<string, number[]>();
function cumulative(key: string): number[] {
  let c = cumCache.get(key);
  if (!c) {
    const { poly } = ROUTES[key];
    c = new Array(poly.length);
    c[0] = 0;
    for (let i = 1; i < poly.length; i++) c[i] = c[i - 1] + metres(poly[i - 1], poly[i]);
    cumCache.set(key, c);
  }
  return c;
}

function bearing(a: [number, number], b: [number, number]): number {
  const p = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * p) * Math.cos(b[1] * p);
  const x = Math.cos(a[1] * p) * Math.sin(b[1] * p)
    - Math.sin(a[1] * p) * Math.cos(b[1] * p) * Math.cos((b[0] - a[0]) * p);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Point at arc-length `s` metres along the route. */
function pointAt(key: string, s: number) {
  const { poly } = ROUTES[key];
  const c = cumulative(key);
  let lo = 0, hi = c.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid] <= s) lo = mid; else hi = mid;
  }
  const span = c[hi] - c[lo];
  const t = span > 0 ? Math.min(1, Math.max(0, (s - c[lo]) / span)) : 0;
  const a = poly[lo], b = poly[hi];
  return {
    lon: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    // Rounded: two identical vertices yield a bearing like 1.7e-15, which
    // serialises into CSS as "rotate(1.7e-15deg)".
    bearing: Math.round(bearing(a, b) * 10) / 10,
  };
}

const plausible = (lat: number, lon: number) =>
  metres([lon, lat], HOME) / 1000 <= MAX_PIN_KM;

/**
 * Place a vehicle from its own forward predictions. `preds` must be that one
 * vehicle's upcoming stops; the two soonest fix its position and speed.
 */
function place(preds: Prediction[], mode: "bus" | "rail") {
  if (preds.length < 2) return null;
  const [p0, p1] = preds;

  let key = "", i0 = -1, i1 = -1;
  for (const k of routeKeys(p0.lineName, p0.direction ?? "")) {
    const r = ROUTES[k];
    if (!r) continue;
    const a = r.stops.indexOf(p0.naptanId ?? "");
    if (a < 0) continue;
    const b = r.stops.indexOf(p1.naptanId ?? "", a + 1);
    if (b < 0) continue;
    key = k; i0 = a; i1 = b;
    break;
  }
  if (!key) return null;

  const route = ROUTES[key];
  const c = cumulative(key);
  const s0 = c[route.idx[i0]];
  const s1 = c[route.idx[i1]];

  const dt = p1.timeToStation - p0.timeToStation;
  const limit = mode === "rail" ? MAX_RAIL_SPEED : MAX_SPEED;
  const fallback = mode === "rail" ? FALLBACK_RAIL_SPEED : FALLBACK_SPEED;
  let speed = dt > 0 && s1 > s0 ? (s1 - s0) / dt : fallback;
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > limit) speed = fallback;

  const floor = i0 > 0 ? c[route.idx[i0 - 1]] : 0;
  const s = Math.min(s0, Math.max(floor, s0 - p0.timeToStation * speed));
  const at = pointAt(key, s);
  return plausible(at.lat, at.lon) ? at : null;
}

/** The board's nearest stop for each (line, direction) it shows. */
const STOP_FOR_PAIR: Record<string, string> = {};
for (const stop of data.stops) {
  for (const pair of stop.primary) STOP_FOR_PAIR[pair] = stop.id;
}

export interface FleetPin extends Omit<Pin, "etaMin" | "stop" | "to"> {
  /** Still due at the board's stop for this route; false once it has gone past. */
  serving: boolean;
  etaMin: number | null;
  to: string;
}

/**
 * Every vehicle currently running on the given lines, wherever it is on the
 * route — including ones that have already passed our stops. Used when the map
 * is opened full-screen or narrowed to a few lines, where a single pin per row
 * is too sparse to be useful.
 */
export async function lineVehicles(env: Env, lines: string[]): Promise<FleetPin[]> {
  if (!lines.length) return [];
  let preds: Prediction[];
  try {
    preds = await tflJson<Prediction[]>(`/Line/${lines.join(",")}/Arrivals`, env, {}, 20);
  } catch {
    return [];
  }

  const byVehicle = new Map<string, Prediction[]>();
  for (const p of preds) {
    if (!p.vehicleId) continue;
    if (!byVehicle.has(p.vehicleId)) byVehicle.set(p.vehicleId, []);
    byVehicle.get(p.vehicleId)!.push(p);
  }

  const pins: FleetPin[] = [];
  for (const [vehicleId, rows] of byVehicle) {
    rows.sort((a, b) => a.timeToStation - b.timeToStation);
    const at = place(rows, "bus");
    if (!at) continue;

    const p0 = rows[0];
    const pair = `${p0.lineName}|${p0.direction}`;
    const ourStop = STOP_FOR_PAIR[pair];
    // Still serving us only if our stop is still ahead of it.
    const due = ourStop ? rows.find((r) => r.naptanId === ourStop) : undefined;

    pins.push({
      line: p0.lineName,
      dir: p0.direction ?? "",
      mode: "bus",
      key: `bus|${pair}`,
      london: LONDON[pair] ?? "out",
      to: p0.destinationName ?? p0.towards ?? "—",
      lat: at.lat,
      lon: at.lon,
      bearing: at.bearing,
      serving: !!due,
      etaMin: due ? Math.max(0, Math.round(due.timeToStation / 60)) : null,
      expected: due?.expectedArrival ?? null,
      vehicleId,
      estimated: true,
    });
  }
  return pins;
}

// TfL rejects a path segment over 255 characters with a bare 400. A bus reg is
// 7 characters but a train id is 15, so a board with enough live vehicles used
// to blow the limit and lose *every* pin at once — how many, and therefore
// whether it broke, depended on the traffic.
const MAX_SEGMENT = 240;

function idChunks(ids: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [], len = 0;
  for (const id of ids) {
    const add = id.length + (cur.length ? 1 : 0);
    if (cur.length && len + add > MAX_SEGMENT) {
      out.push(cur);
      cur = []; len = 0;
    }
    cur.push(id);
    len += cur.length > 1 ? id.length + 1 : id.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** One pin per board row: the next vehicle due at our stop for that row. */
export async function vehiclePins(env: Env, next: PinInput[]): Promise<Pin[]> {
  const ids = [...new Set(next.map((n) => n.vehicleId).filter(Boolean))];
  if (!ids.length) return [];

  // Fetch in chunks; one failed chunk must not cost the others their pins.
  const chunks = await Promise.all(idChunks(ids).map((c) =>
    tflJson<Prediction[]>(`/Vehicle/${c.join(",")}/Arrivals`, env, {}, 15)
      .catch(() => [] as Prediction[])));
  const preds = chunks.flat();
  if (!preds.length) return [];

  const byVehicle = new Map<string, Prediction[]>();
  for (const p of preds) {
    if (!byVehicle.has(p.vehicleId!)) byVehicle.set(p.vehicleId!, []);
    byVehicle.get(p.vehicleId!)!.push(p);
  }

  const pins: Pin[] = [];
  for (const row of next) {
    const seen = byVehicle.get(row.vehicleId);
    if (!seen || seen.length < 2) continue;
    seen.sort((a, b) => a.timeToStation - b.timeToStation);

    const [p0, p1] = seen;

    // Resolve which route polyline this vehicle is actually on.
    let key = "", i0 = -1, i1 = -1;
    for (const k of routeKeys(p0.lineName, p0.direction ?? "")) {
      const r = ROUTES[k];
      if (!r) continue;
      const a = r.stops.indexOf(p0.naptanId ?? "");
      if (a < 0) continue;
      const b = r.stops.indexOf(p1.naptanId ?? "", a + 1);
      if (b < 0) continue;
      key = k; i0 = a; i1 = b;
      break;
    }
    if (!key) continue;

    const route = ROUTES[key];
    const c = cumulative(key);
    const s0 = c[route.idx[i0]];
    const s1 = c[route.idx[i1]];

    // Speed from the vehicle's own next leg. Nonsense values fall back.
    const dt = p1.timeToStation - p0.timeToStation;
    const limit = row.mode === "rail" ? MAX_RAIL_SPEED : MAX_SPEED;
    const fallback = row.mode === "rail" ? FALLBACK_RAIL_SPEED : FALLBACK_SPEED;
    let speed = dt > 0 && s1 > s0 ? (s1 - s0) / dt : fallback;
    if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > limit) speed = fallback;

    // Never place the vehicle behind the stop it has already left.
    const floor = i0 > 0 ? c[route.idx[i0 - 1]] : 0;
    const s = Math.min(s0, Math.max(floor, s0 - p0.timeToStation * speed));
    const at = pointAt(key, s);
    if (!plausible(at.lat, at.lon)) continue;

    pins.push({
      line: p0.lineName,
      dir: p0.direction ?? "",
      mode: row.mode,
      key: row.key,
      london: row.london,
      to: row.to,
      lat: at.lat,
      lon: at.lon,
      bearing: at.bearing,
      etaMin: row.etaMin,
      expected: row.expected,
      stop: row.stop,
      vehicleId: row.vehicleId,
      estimated: true,
    });
  }
  return pins;
}

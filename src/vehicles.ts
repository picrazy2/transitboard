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
const MIN_SPEED = 1.5;
const MAX_SPEED = 18;

export interface Pin {
  line: string;
  dir: string;
  london: "in" | "out";
  to: string;
  lat: number;
  lon: number;
  bearing: number;
  etaMin: number; // at *our* stop, not its next stop
  stop: string;
  vehicleId: string;
  estimated: true;
}

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

/** One pin per (line, direction): the next bus due at our stop for that row. */
export async function busPins(
  env: Env,
  next: { vehicleId: string; etaMin: number; to: string; stop: string }[],
): Promise<Pin[]> {
  const ids = [...new Set(next.map((n) => n.vehicleId).filter(Boolean))];
  if (!ids.length) return [];

  let preds: Prediction[];
  try {
    preds = await tflJson<Prediction[]>(`/Vehicle/${ids.join(",")}/Arrivals`, env, {}, 15);
  } catch {
    return []; // pins are a garnish; never fail the board over them
  }

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
    const key = `${p0.lineName}|${p0.direction}`;
    const route = ROUTES[key];
    if (!route) continue;

    const i0 = route.stops.indexOf(p0.naptanId ?? "");
    const i1 = route.stops.indexOf(p1.naptanId ?? "", i0 + 1);
    if (i0 < 0 || i1 < 0) continue;

    const c = cumulative(key);
    const s0 = c[route.idx[i0]];
    const s1 = c[route.idx[i1]];

    // Speed from the bus's own next leg. Nonsense values fall back to a constant.
    const dt = p1.timeToStation - p0.timeToStation;
    let speed = dt > 0 && s1 > s0 ? (s1 - s0) / dt : FALLBACK_SPEED;
    if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) speed = FALLBACK_SPEED;

    // Never place the bus behind the stop it has already left.
    const floor = i0 > 0 ? c[route.idx[i0 - 1]] : 0;
    const s = Math.min(s0, Math.max(floor, s0 - p0.timeToStation * speed));
    const at = pointAt(key, s);
    if (!plausible(at.lat, at.lon)) continue;

    pins.push({
      line: p0.lineName,
      dir: p0.direction ?? "",
      london: LONDON[key] ?? "out",
      to: row.to,
      lat: at.lat,
      lon: at.lon,
      bearing: at.bearing,
      etaMin: row.etaMin,
      stop: row.stop,
      vehicleId: row.vehicleId,
      estimated: true,
    });
  }
  return pins;
}

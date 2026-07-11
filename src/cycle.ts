import { Env, Prediction, arrivals, etaMin, tflJson } from "./tfl";
import { weather } from "./weather";
import data from "./cycle-stops.json";
import routes from "./cycle-routes.json";

// Cycle mode: trains only. Each station reports just the (line, direction) pairs
// it is the nearest cycle to — see tools/build-cycle-data.py. A live arrival is
// keyed by lineId + TfL direction; the station's `serve` map both filters it in
// and tells us whether it heads into or out of London.

export type Towards = "in" | "out";
// Per (lineId, TfL direction): the OSM spine polyline for this line (drawn on the
// map too) plus each stop snapped onto it with its offset in metres along the
// track. A live train is positioned *on this polyline*, so it is always on the
// drawn line. See tools/build-cycle-data.py.
interface RouteGeo {
  track: [number, number][];              // [lon,lat] vertices of the spine
  stops: [number, number, string, number][]; // [lon,lat,naptanId,offset_m]
}
const ROUTES = routes as unknown as Record<string, RouteGeo>;

export interface CycleRow {
  line: string;
  lineId: string;
  dir: string; // TfL inbound/outbound, for the route lookup
  london: Towards;
  to: string;
  station: string;
  stationId: string;
  cycMin: number;
  plat: string;
  etaMin: number;
  expected: string | null;
  vehicleId: string;
}

const cleanDest = (name?: string) =>
  (name ?? "—").replace(/\s+(Rail|Underground)?\s*Station$/i, "").replace(/^London /, "");

async function stationRows(env: Env, st: (typeof data.stations)[number]): Promise<CycleRow[]> {
  let preds: Prediction[];
  try {
    preds = await arrivals(st.id, env);
  } catch {
    return [];
  }
  const serve = st.serve as unknown as Record<string, Towards>;
  const names = st.lineNames as unknown as Record<string, string>;

  const rows: CycleRow[] = [];
  const seen = new Set<string>();
  for (const p of preds.slice().sort((a, b) => a.timeToStation - b.timeToStation)) {
    const lineId = p.lineId ?? "";
    const key = `${lineId}|${p.direction}`;
    const london = serve[key];
    if (!london) continue;
    const vk = p.vehicleId || `${key}|${p.expectedArrival}`;
    if (seen.has(vk)) continue;
    seen.add(vk);
    if (rows.length >= 12) break;
    rows.push({
      line: names[lineId] ?? p.lineName,
      lineId,
      dir: p.direction ?? "",
      london,
      to: cleanDest(p.destinationName),
      station: st.name,
      stationId: st.id,
      cycMin: st.cycMin,
      plat: p.platformName && p.platformName !== "Platform Unknown" ? p.platformName : "—",
      etaMin: etaMin(p),
      expected: p.expectedArrival ?? null,
      vehicleId: p.vehicleId ?? "",
    });
  }
  return rows;
}

// ---------- live position estimate ----------
function metres(a: [number, number], b: [number, number]) {
  const R = 6371000, p = Math.PI / 180;
  const h = Math.sin((b[1] - a[1]) * p / 2) ** 2
    + Math.cos(a[1] * p) * Math.cos(b[1] * p) * Math.sin((b[0] - a[0]) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a: [number, number], b: [number, number]) {
  const p = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * p) * Math.cos(b[1] * p);
  const x = Math.cos(a[1] * p) * Math.sin(b[1] * p)
    - Math.sin(a[1] * p) * Math.cos(b[1] * p) * Math.cos((b[0] - a[0]) * p);
  return Math.round(((Math.atan2(y, x) * 180 / Math.PI + 360) % 360) * 10) / 10;
}
const cumCache = new Map<string, number[]>();
function cumulative(key: string) {
  let c = cumCache.get(key);
  if (!c) {
    const t = ROUTES[key].track;
    c = [0];
    for (let i = 1; i < t.length; i++) c[i] = c[i - 1] + metres(t[i - 1], t[i]);
    cumCache.set(key, c);
  }
  return c;
}
/** The point `s` metres along the drawn spine, with the track's local bearing. */
function pointAt(key: string, s: number) {
  const t = ROUTES[key].track, c = cumulative(key);
  let lo = 0, hi = c.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
  const span = c[hi] - c[lo], f = span > 0 ? Math.min(1, Math.max(0, (s - c[lo]) / span)) : 0;
  const a = t[lo], b = t[hi];
  return { lon: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f, bearing: bearing(a, b) };
}

export interface Pin {
  line: string; lineId: string; london: Towards; to: string; station: string;
  lat: number; lon: number; bearing: number; etaMin: number; expected: string | null;
  vehicleId: string; estimated: true;
}

const MIN_SPEED = 3, MAX_SPEED = 45, FALLBACK_SPEED = 16; // m/s; rail runs faster than road

/** Place the next train per board row from its own forward predictions. */
async function trainPins(env: Env, rows: CycleRow[]): Promise<Pin[]> {
  // one train per (station,line,london) — the soonest, which the board shows
  const first = new Map<string, CycleRow>();
  for (const r of rows) {
    const k = `${r.stationId}|${r.lineId}|${r.london}`;
    if (r.vehicleId && !first.has(k)) first.set(k, r);
  }
  const wanted = [...first.values()];
  const ids = [...new Set(wanted.map((r) => r.vehicleId))];
  if (!ids.length) return [];

  // Tube set-numbers repeat across lines, so a /Vehicle response mixes lines;
  // we filter each vehicle's predictions to the row's own lineId.
  const preds = await Promise.all(ids.map((id) =>
    tflJson<Prediction[]>(`/Vehicle/${id}/Arrivals`, env, {}, 15).catch(() => [] as Prediction[])));
  const byId = new Map<string, Prediction[]>();
  ids.forEach((id, i) => byId.set(id, preds[i]));

  const pins: Pin[] = [];
  for (const r of wanted) {
    const key = `${r.lineId}|${r.dir}`;
    const route = ROUTES[key];
    if (!route) continue;
    const offOf = new Map(route.stops.map((s) => [s[2], s[3]] as const)); // naptan -> offset_m
    const seq = (byId.get(r.vehicleId) ?? [])
      .filter((p) => p.lineId === r.lineId && p.direction === r.dir && offOf.has(p.naptanId ?? ""))
      .sort((a, b) => a.timeToStation - b.timeToStation);
    if (seq.length < 2) continue;

    // Two predicted stops with increasing offset along the track give the speed;
    // back-project the train from the nearer one by its remaining time.
    let p0 = seq[0], p1 = seq[1], s0 = -1, s1 = -1;
    for (let a = 0; a < seq.length - 1 && s1 < 0; a++) {
      const oa = offOf.get(seq[a].naptanId ?? "")!;
      for (let b = a + 1; b < seq.length; b++) {
        const ob = offOf.get(seq[b].naptanId ?? "")!;
        if (ob > oa) { s0 = oa; s1 = ob; p0 = seq[a]; p1 = seq[b]; break; }
      }
    }
    if (s0 < 0 || s1 < 0) continue;

    const dt = p1.timeToStation - p0.timeToStation;
    let speed = dt > 0 && s1 > s0 ? (s1 - s0) / dt : FALLBACK_SPEED;
    if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) speed = FALLBACK_SPEED;
    const s = Math.min(s0, Math.max(0, s0 - p0.timeToStation * speed));
    const at = pointAt(key, s);

    pins.push({
      line: r.line, lineId: r.lineId, london: r.london, to: r.to, station: r.station,
      lat: at.lat, lon: at.lon, bearing: at.bearing, etaMin: r.etaMin, expected: r.expected,
      vehicleId: r.vehicleId, estimated: true,
    });
  }
  return pins;
}

// ---------- line status ----------
interface LineStatus { line: string; lineId: string; severity: string; reason: string; good: boolean; }
async function lineStatus(env: Env): Promise<LineStatus[]> {
  const ids = [...new Set(data.stations.flatMap((s) =>
    Object.keys(s.serve).map((k) => k.split("|")[0])))];
  if (!ids.length) return [];
  let raw: any[];
  try {
    raw = await tflJson<any[]>(`/Line/${ids.join(",")}/Status`, env, {}, 60);
  } catch {
    return [];
  }
  return raw.map((l) => {
    const st = (l.lineStatuses ?? [])
      .sort((a: any, b: any) => (a.statusSeverity ?? 10) - (b.statusSeverity ?? 10))[0] ?? {};
    return {
      line: l.name, lineId: l.id,
      severity: st.statusSeverityDescription ?? "Unknown",
      reason: (st.reason ?? "").replace(/^[A-Z ]+:\s*/, ""),
      good: (st.statusSeverity ?? 10) >= 10,
    };
  });
}

export async function cycleBoard(env: Env) {
  const [rowsPerStation, wx, status] = await Promise.all([
    Promise.all(data.stations.map((s) => stationRows(env, s))),
    weather(data.home.lat, data.home.lon).catch(() => null),
    lineStatus(env).catch(() => [] as LineStatus[]),
  ]);
  const rows = rowsPerStation.flat();
  const pins = await trainPins(env, rows).catch(() => [] as Pin[]);

  const soonest = (a: CycleRow, b: CycleRow) => {
    const ta = a.expected ? Date.parse(a.expected) : Date.now() + a.etaMin * 60000;
    const tb = b.expected ? Date.parse(b.expected) : Date.now() + b.etaMin * 60000;
    return ta - tb;
  };
  return {
    into: rows.filter((r) => r.london === "in").sort(soonest),
    out: rows.filter((r) => r.london === "out").sort(soonest),
    pins, status, weather: wx, cycMin: data.limitMin, ts: Math.floor(Date.now() / 1000),
  };
}

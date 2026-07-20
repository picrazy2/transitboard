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
  // National Rail (RTT) has a timetable, so it can be on time or late. Tube /
  // Overground live predictions carry no schedule, so these stay null there.
  scheduled?: string | null;
  delayMin?: number | null;
  cancelled?: boolean;
}

const cleanDest = (name?: string) =>
  (name ?? "—").replace(/\s+(Rail|Underground)?\s*Station$/i, "").replace(/^London /, "");

// ---------- National Rail via Realtime Trains (data.rtt.io) ----------
// RTT gives per-service realtime forecast times, the operator, and — via the
// service detail — every calling point's actual time, which is what positions an
// approaching train. See the rtt-api memory. The token is a long-life refresh
// token exchanged for a ~20-minute access token, cached per isolate.
const RTT_BASE = "https://data.rtt.io";
let rttTok: { token: string; exp: number } | null = null;

async function rttAccessToken(env: Env): Promise<string | null> {
  if (!env.RTT_TOKEN) return null;
  if (rttTok && rttTok.exp > Date.now() + 30000) return rttTok.token;
  const res = await fetch(`${RTT_BASE}/api/get_access_token`, { headers: { Authorization: `Bearer ${env.RTT_TOKEN}` } });
  if (!res.ok) return null;
  const d: any = await res.json();
  rttTok = { token: d.token, exp: Date.parse(d.validUntil) || Date.now() + 900000 };
  return d.token;
}
async function rttGet(path: string, env: Env, ttl = 20): Promise<any> {
  const at = await rttAccessToken(env);
  if (!at) throw new Error("no rtt token");
  const res = await fetch(`${RTT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${at}` }, cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`rtt ${res.status}`);
  return res.json();
}

/** Minutes until a "HH:MM" time read as Europe/London wall-clock, plus a UTC ISO. */
function londonEta(hhmm: string, nowMs: number): { min: number; iso: string } | null {
  const m = /(\d{2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(nowMs);
  const nh = +(parts.find((p) => p.type === "hour")?.value ?? "0");
  const nm = +(parts.find((p) => p.type === "minute")?.value ?? "0");
  let diff = (+m[1] * 60 + +m[2]) - (nh * 60 + nm);
  if (diff < -720) diff += 1440;
  diff = Math.max(0, diff);
  return { min: diff, iso: new Date(Math.floor(nowMs / 60000) * 60000 + diff * 60000).toISOString() };
}

async function rttRows(env: Env, st: (typeof data.stations)[number]): Promise<CycleRow[]> {
  let d: any;
  try {
    d = await rttGet(`/gb-nr/location?code=${st.crs}`, env);
  } catch {
    return [];
  }
  const opLines = st.opLines as Record<string, { lineId: string; name: string }>;
  const destDir = st.destDir as Record<string, Towards>;
  const nrServe = new Set(st.nrServe as string[]);
  const now = Date.now();
  const rows: CycleRow[] = [];
  for (const svc of (d.services ?? []) as any[]) {
    const meta = svc.scheduleMetadata ?? {};
    const op = opLines[meta.operator?.code ?? ""];
    if (!op) continue;
    const dep = svc.temporalData?.departure ?? {};
    if (dep.isCancelled) continue;
    const destName = svc.destination?.[0]?.location?.description ?? "";
    const london = destDir[destName];
    if (!london || !nrServe.has(`${op.lineId}|${london}`)) continue; // not a (line,dir) this station won
    const rt = dep.realtimeForecast ?? dep.scheduleAdvertised ?? "";
    const eta = londonEta(rt, now);
    if (!eta) continue;
    // Delay from schedule vs realtime (both London-naive, so the diff is tz-free);
    // scheduled as a UTC ISO the frontend can format, derived from the delay.
    const sched = dep.scheduleAdvertised as string | undefined;
    const delayMin = sched ? Math.round((Date.parse(rt) - Date.parse(sched)) / 60000) : null;
    const scheduled = delayMin != null ? new Date(Date.parse(eta.iso) - delayMin * 60000).toISOString() : null;
    const plat = svc.locationMetadata?.platform;
    rows.push({
      line: op.name, lineId: op.lineId, dir: "", london,
      to: cleanDest(destName), station: st.name, stationId: st.id, cycMin: st.cycMin,
      plat: (plat?.forecast ?? plat?.planned) || "—",
      etaMin: eta.min, expected: eta.iso, scheduled, delayMin, cancelled: false,
      // identity|date lets trainPins fetch the service detail to position it.
      vehicleId: `${meta.identity}|${meta.departureDate}`,
    });
  }
  return rows.sort((a, b) => a.etaMin - b.etaMin).slice(0, 12);
}

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
  line: string; lineId: string; london: Towards; to: string; station: string; stationId: string;
  lat: number; lon: number; bearing: number; etaMin: number; expected: string | null;
  vehicleId: string; estimated: true;
}

const MIN_SPEED = 3, MAX_SPEED = 45, FALLBACK_SPEED = 16; // m/s; rail runs faster than road

const MAX_PINS = 60; // positioning is cheap now (per-line fetch), so show plenty

/** Place every board train from its own forward predictions — one pin per vehicle. */
async function trainPins(env: Env, rows: CycleRow[]): Promise<Pin[]> {
  // one row per vehicle; only TfL lines have route geometry here (National Rail is
  // positioned separately from RTT), so skip anything without a route.
  const byVeh = new Map<string, CycleRow>();
  for (const r of rows) {
    if (!r.vehicleId || !ROUTES[`${r.lineId}|${r.dir}`]) continue;
    if (!byVeh.has(r.vehicleId)) byVeh.set(r.vehicleId, r);
  }
  const wanted = [...byVeh.values()].slice(0, MAX_PINS);
  if (!wanted.length) return [];

  // One /Line/{id}/Arrivals per line returns every vehicle's forward predictions in
  // a single call — far fewer subrequests than /Vehicle per train. Grouped by
  // vehicleId; the per-row filter below keeps each train to its own line + direction.
  const lines = [...new Set(wanted.map((r) => r.lineId))];
  const perLine = await Promise.all(lines.map((lid) =>
    tflJson<Prediction[]>(`/Line/${lid}/Arrivals`, env, {}, 15).catch(() => [] as Prediction[])));
  const byId = new Map<string, Prediction[]>();
  for (const p of perLine.flat()) {
    const id = p.vehicleId ?? "";
    if (!id) continue;
    (byId.get(id) ?? byId.set(id, []).get(id)!).push(p);
  }

  // Route + any branch variants for this line/direction ("weaver|outbound" plus
  // "weaver|outbound|chingford"), main spine first.
  const routeKeys = (lineId: string, dir: string) => {
    const base = `${lineId}|${dir}`;
    return Object.keys(ROUTES).filter((k) => k === base || k.startsWith(base + "|") ).sort();
  };

  const pins: Pin[] = [];
  for (const r of wanted) {
    // Pick the route (main or branch) whose stops the vehicle's predictions land on.
    let key = "", offOf = new Map<string, number>(), seq: Prediction[] = [];
    for (const k of routeKeys(r.lineId, r.dir)) {
      if (!ROUTES[k]?.stops) continue;
      const off = new Map(ROUTES[k].stops.map((s) => [s[2], s[3]] as const));
      const s = (byId.get(r.vehicleId) ?? [])
        .filter((p) => p.lineId === r.lineId && p.direction === r.dir && off.has(p.naptanId ?? ""))
        .sort((a, b) => a.timeToStation - b.timeToStation);
      if (s.length >= 2) { key = k; offOf = off; seq = s; break; }
    }
    if (!key) continue;

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
      line: r.line, lineId: r.lineId, london: r.london, to: r.to, station: r.station, stationId: r.stationId,
      lat: at.lat, lon: at.lon, bearing: at.bearing, etaMin: r.etaMin, expected: r.expected,
      vehicleId: r.vehicleId, estimated: true,
    });
  }
  return pins;
}

// ---------- National Rail pins (RTT service detail) ----------
// RTT times are Europe/London wall-clock without a zone; convert to real ms using
// London's current offset (constant across the short window we care about).
function londonOffsetMs(nowMs: number): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(nowMs);
  const lh = +(p.find((x) => x.type === "hour")?.value ?? "0"), lm = +(p.find((x) => x.type === "minute")?.value ?? "0");
  const u = new Date(nowMs);
  let diff = (lh * 60 + lm) - (u.getUTCHours() * 60 + u.getUTCMinutes());
  if (diff > 720) diff -= 1440; if (diff < -720) diff += 1440;
  return diff * 60000;
}

const NR_MAX_PINS = 16;

/** Position National Rail trains from their RTT calling-point actual/forecast times. */
async function nrPins(env: Env, rows: CycleRow[]): Promise<Pin[]> {
  // Positioning each NR train needs a per-service RTT call, so — unlike the tube —
  // only the soonest per (station, line, direction) is placed, to stay well under
  // the rate limit and the subrequest budget. (rows arrive soonest-first per station.)
  const first = new Map<string, CycleRow>();
  for (const r of rows) {
    if (!r.vehicleId.includes("|") || !(ROUTES as any)[r.lineId]?.crs) continue; // NR rows with geometry
    const k = `${r.stationId}|${r.lineId}|${r.london}`;
    if (!first.has(k)) first.set(k, r);
  }
  const wanted = [...first.values()].slice(0, NR_MAX_PINS);
  if (!wanted.length) return [];
  const now = Date.now(), off = londonOffsetMs(now);
  const ms = (iso?: string) => (iso ? Date.parse(iso + "Z") - off : NaN);

  const details = await Promise.all(wanted.map((r) => {
    const [identity, date] = r.vehicleId.split("|");
    return rttGet(`/gb-nr/service?identity=${identity}&departureDate=${date}`, env, 30).catch(() => null);
  }));
  const pins: Pin[] = [];
  for (let i = 0; i < wanted.length; i++) {
    const r = wanted[i], d: any = details[i];
    const locs = d?.service?.locations as any[] | undefined;
    const route = (ROUTES as any)[r.lineId] as { track: [number, number][]; crs: Record<string, number> };
    if (!locs || !route) continue;
    // (offset along track, real ms) for calling points we have geometry for
    const pts: { o: number; t: number }[] = [];
    for (const l of locs) {
      const crs = l.location?.shortCodes?.[0];
      const o = crs ? route.crs[crs] : undefined;
      if (o == null) continue;
      const td = l.temporalData ?? {};
      const time = td.departure ?? td.arrival ?? {};
      const t = ms(time.realtimeActual ?? time.realtimeForecast ?? time.scheduleAdvertised);
      if (Number.isFinite(t)) pts.push({ o, t });
    }
    if (pts.length < 2) continue;
    pts.sort((a, b) => a.t - b.t);
    let a = pts[0], b = pts[1];
    for (let k = 0; k < pts.length - 1; k++) if (pts[k].t <= now && pts[k + 1].t >= now) { a = pts[k]; b = pts[k + 1]; break; }
    const frac = b.t > a.t ? Math.min(1, Math.max(0, (now - a.t) / (b.t - a.t))) : 0;
    const at = pointAt(r.lineId, a.o + (b.o - a.o) * frac);
    pins.push({
      line: r.line, lineId: r.lineId, london: r.london, to: r.to, station: r.station, stationId: r.stationId,
      lat: at.lat, lon: at.lon, bearing: at.bearing, etaMin: r.etaMin, expected: r.expected,
      vehicleId: r.vehicleId, estimated: true,
    });
  }
  return pins;
}

// ---------- line status ----------
interface LineStatus { line: string; lineId: string; severity: string; reason: string; good: boolean; }
async function lineStatus(env: Env): Promise<LineStatus[]> {
  const ids = [...new Set(data.stations.flatMap((s) => [
    ...Object.keys(s.serve).map((k) => k.split("|")[0]),
    ...Object.values(s.opLines as Record<string, { lineId: string }>).map((o) => o.lineId),
  ]))];
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
    // A station may be TfL (serve), National Rail (nr), or both (Finsbury Park is
    // Piccadilly via TfL and Great Northern/Thameslink via RTT) — fetch each source.
    Promise.all(data.stations.map(async (s) => {
      const parts: Promise<CycleRow[]>[] = [];
      if (Object.keys(s.serve).length) parts.push(stationRows(env, s));
      if (s.nr) parts.push(rttRows(env, s));
      return (await Promise.all(parts)).flat();
    })),
    weather(data.home.lat, data.home.lon).catch(() => null),
    lineStatus(env).catch(() => [] as LineStatus[]),
  ]);
  const rows = rowsPerStation.flat();
  // Pins are best-effort: never let a slow fan-out hold up the board, but tell the
  // client if a pin pass timed out so it can flag that positions are incomplete.
  let pinsTimedOut = false;
  const withTimeout = (p: Promise<Pin[]>, ms: number): Promise<Pin[]> =>
    Promise.race([p.catch(() => [] as Pin[]),
      new Promise<Pin[]>((res) => setTimeout(() => { pinsTimedOut = true; res([]); }, ms))]);
  const [tflP, nrP] = await Promise.all([
    withTimeout(trainPins(env, rows), 15000),
    withTimeout(nrPins(env, rows), 9000),
  ]);
  const pins = [...tflP, ...nrP];

  const soonest = (a: CycleRow, b: CycleRow) => {
    const ta = a.expected ? Date.parse(a.expected) : Date.now() + a.etaMin * 60000;
    const tb = b.expected ? Date.parse(b.expected) : Date.now() + b.etaMin * 60000;
    return ta - tb;
  };
  return {
    into: rows.filter((r) => r.london === "in").sort(soonest),
    out: rows.filter((r) => r.london === "out").sort(soonest),
    pins, pinsTimedOut, status, weather: wx, cycMin: data.limitMin, ts: Math.floor(Date.now() / 1000),
  };
}

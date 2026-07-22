import { Env } from "./tfl";
import home from "./cycle-stops.json";
import spinesRail from "./cycle-routes.json";
import spinesBus from "./stokey-routes.json";

// lineId -> candidate polylines ([lat,lon]) from the board's own precise OSM
// geometry. TfL returns near-straight lines for Overground / National Rail and
// some bus legs, so we snap those onto the real track we already drew.
const LINE_SPINES: Record<string, [number, number][][]> = {};
for (const [k, v] of Object.entries(spinesRail as unknown as Record<string, { track?: number[][] }>)) {
  const lid = k.split("|")[0];
  (LINE_SPINES[lid] ??= []).push((v.track ?? []).map((p) => [p[1], p[0]] as [number, number]));
}
for (const [k, v] of Object.entries(spinesBus as unknown as Record<string, { poly?: number[][] }>)) {
  const lid = k.split("|")[0];
  (LINE_SPINES[lid] ??= []).push((v.poly ?? []).map((p) => [p[1], p[0]] as [number, number]));
}

function metresLL(a: [number, number], b: [number, number]) {
  const R = 6371000, p = Math.PI / 180;
  const dLat = (b[0] - a[0]) * p, dLon = (b[1] - a[1]) * p;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * p) * Math.cos(b[0] * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function cumul(poly: [number, number][]) { const c = [0]; for (let i = 1; i < poly.length; i++) c[i] = c[i - 1] + metresLL(poly[i - 1], poly[i]); return c; }
function projectLL(poly: [number, number][], cum: number[], pt: [number, number]) {
  let best = { perp: 1e18, arc: 0 };
  const kx = Math.cos(pt[0] * Math.PI / 180) * 111320, ky = 110540;
  for (let i = 0; i < poly.length - 1; i++) {
    const ax = poly[i][1], ay = poly[i][0], bx = poly[i + 1][1], by = poly[i + 1][0];
    const px = (pt[1] - ax) * kx, py = (pt[0] - ay) * ky, dx = (bx - ax) * kx, dy = (by - ay) * ky;
    const seg2 = dx * dx + dy * dy, t = seg2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / seg2)) : 0;
    const perp = Math.hypot(px - t * dx, py - t * dy);
    if (perp < best.perp) best = { perp, arc: cum[i] + t * Math.sqrt(seg2) };
  }
  return best;
}
function pointOnPoly(poly: [number, number][], cum: number[], arc: number): [number, number] {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= arc) lo = m; else hi = m; }
  const span = cum[hi] - cum[lo], t = span ? (arc - cum[lo]) / span : 0;
  return [poly[lo][0] + (poly[hi][0] - poly[lo][0]) * t, poly[lo][1] + (poly[hi][1] - poly[lo][1]) * t];
}
function sliceLL(poly: [number, number][], cum: number[], a: number, b: number): [number, number][] {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const pts: [number, number][] = [pointOnPoly(poly, cum, lo)];
  for (let i = 0; i < poly.length; i++) if (cum[i] > lo && cum[i] < hi) pts.push(poly[i]);
  pts.push(pointOnPoly(poly, cum, hi));
  return a > b ? pts.reverse() : pts;
}
// Replace a leg's path with the slice of a candidate polyline between its endpoints,
// if they sit close enough to it. Returns true if it snapped.
function snapToPolys(leg: JLeg, cands: [number, number][][], maxPerp: number): boolean {
  if (leg.path.length < 2) return false;
  const start = leg.path[0], end = leg.path[leg.path.length - 1];
  let best: { seg: [number, number][]; perp: number } | null = null;
  for (const poly of cands) {
    if (poly.length < 2) continue;
    const cum = cumul(poly);
    const a = projectLL(poly, cum, start), b = projectLL(poly, cum, end);
    if (Math.abs(a.arc - b.arc) < 100) continue;
    if (!best || a.perp + b.perp < best.perp) best = { seg: sliceLL(poly, cum, a.arc, b.arc), perp: a.perp + b.perp };
  }
  if (best && best.perp < maxPerp && best.seg.length >= 2) {
    leg.path = best.seg.map((p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
    return true;
  }
  return false;
}
// Sync pass: snap onto the board's own precise OSM spines (local lines + buses).
function enrichLeg(leg: JLeg) {
  if (leg.kind !== "transit" || !leg.lineId) return;
  const cands = LINE_SPINES[leg.lineId];
  if (cands) snapToPolys(leg, cands, 500);
}

// TfL's own line geometry (Route/Sequence), cached per isolate. Each lineString is a
// stringified GeoJSON coord array wrapped once: JSON.parse(s)[0] = [[lon,lat],…].
const tflGeomCache = new Map<string, [number, number][][]>();
async function tflLineGeometry(env: Env, lineId: string): Promise<[number, number][][]> {
  if (tflGeomCache.has(lineId)) return tflGeomCache.get(lineId)!;
  const polys: [number, number][][] = [];
  try {
    const qs = new URLSearchParams({ serviceTypes: "Regular", excludeCrowding: "true" });
    if (env.TFL_APP_KEY) qs.set("app_key", env.TFL_APP_KEY);
    const r = await fetch(`${TFL}/Line/${lineId}/Route/Sequence/outbound?${qs}`, {
      headers: { "User-Agent": UA, Accept: "application/json" }, cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (r.ok) {
      const d: any = await r.json();
      for (const ls of d.lineStrings ?? []) {
        try { const arr = JSON.parse(ls)[0]; if (Array.isArray(arr)) polys.push(arr.map((p: any) => [num(p[1]), num(p[0])] as [number, number])); } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }
  tflGeomCache.set(lineId, polys);
  return polys;
}
// Async pass: for lines with no local spine whose TfL leg geometry is bad — sparse
// (Heathrow Express: a straight line) or street-following (Elizabeth: 1000s of road
// points) — snap onto TfL's authoritative line track. Good tube geometry is left alone.
async function enrichWithTflGeometry(env: Env, options: JOption[]): Promise<void> {
  const need = new Map<string, JLeg[]>();
  for (const o of options) for (const l of o.legs) {
    if (l.kind !== "transit" || !l.lineId || LINE_SPINES[l.lineId]) continue;
    const stops = Math.max(1, l.stops.length);
    if (l.path.length < 4 || l.path.length > 30 * stops)
      (need.get(l.lineId) ?? need.set(l.lineId, []).get(l.lineId)!).push(l);
  }
  if (!need.size) return;
  await Promise.all([...need].map(async ([lid, legs]) => {
    const polys = await tflLineGeometry(env, lid);
    if (polys.length) for (const l of legs) snapToPolys(l, polys, 900);
  }));
}

// Journey planning is TfL's Journey Planner (free, London-complete, native
// multimodal). Origin is always home; the destination is searched. Two modes:
//   walk  -> walk access legs (<=15 min) + public transport, plus a full-walk option
//   cycle -> cycle to a station (LeaveAtStation) + transit, plus a full-cycle option
// Geocoding is Photon (OSM, autocomplete, no key) with postcodes.io for UK postcodes.

const HOME = { lat: home.home.lat, lon: home.home.lon };
const UA = "transitboard/1.0 (+https://board.akguo.com)";
const TFL = "https://api.tfl.gov.uk";

const MODE_META: Record<string, { label: string; color: string; kind: string }> = {
  walking:         { label: "Walk",       color: "#8a93a5", kind: "walk" },
  "cycle":         { label: "Cycle",      color: "#20c05b", kind: "cycle" },
  "cycle-hire":    { label: "Cycle hire", color: "#20c05b", kind: "cycle" },
  bus:             { label: "Bus",        color: "#e1251b", kind: "transit" },
  "replacement-bus": { label: "Bus",      color: "#e1251b", kind: "transit" },
  tube:            { label: "Tube",       color: "#1f3fb0", kind: "transit" },
  overground:      { label: "Overground", color: "#ee7c0e", kind: "transit" },
  dlr:             { label: "DLR",        color: "#00afad", kind: "transit" },
  "elizabeth-line":{ label: "Elizabeth",  color: "#6950a1", kind: "transit" },
  "national-rail": { label: "Rail",       color: "#c81f2d", kind: "transit" },
  tram:            { label: "Tram",       color: "#5fb130", kind: "transit" },
  "river-bus":     { label: "River bus",  color: "#1c9cce", kind: "transit" },
};

export interface JLeg {
  mode: string;         // tfl mode name
  kind: string;         // walk | cycle | transit
  label: string;        // Walk / Cycle / Bus / Tube ...
  color: string;
  line: string | null;  // e.g. "73", "Victoria"
  lineId: string | null;
  duration: number;     // minutes
  from: string;
  to: string;
  fromId: string | null;  // boarding stop for live "see more" — bus wants individualStopId,
  fromAlt: string | null; // Overground/rail want the naptanId group; try both.
  dep: string | null;   // ISO
  arr: string | null;
  instruction: string;
  path: [number, number][]; // [lat,lon]
  stops: string[];      // intermediate stop names (transit legs)
}
export interface JOption {
  id: string;
  duration: number;         // total minutes
  dep: string | null;
  arr: string | null;
  walkMins: number;
  cycleMins: number;
  changes: number;          // number of transit legs - 1 (interchanges)
  kind: "full-walk" | "full-cycle" | "transit";
  summary: { label: string; color: string; line: string | null }[]; // one chip per leg
  legs: JLeg[];
}

const num = (s: any) => (typeof s === "number" ? s : parseFloat(s) || 0);

function parseLeg(l: any): JLeg {
  const mode = l.mode?.id ?? l.mode?.name ?? "walking";
  const meta = MODE_META[mode] ?? { label: l.mode?.name ?? mode, color: "#8a93a5", kind: "transit" };
  const ro = (l.routeOptions ?? [])[0] ?? {};
  const line = ro.name || (l.instruction?.summary?.match(/^(\d+|[A-Z]\d+)\b/)?.[1]) || null;
  let path: [number, number][] = [];
  try {
    const ls = l.path?.lineString ? JSON.parse(l.path.lineString) : [];
    path = ls.map((p: any) => [num(p[0]), num(p[1])] as [number, number]);
  } catch { path = []; }
  const stops = (l.path?.stopPoints ?? []).map((s: any) => s.name).filter(Boolean);
  return {
    mode, kind: meta.kind, label: meta.label, color: meta.color,
    line: meta.kind === "transit" ? line : null,
    lineId: ro.lineIdentifier?.id ?? null,
    duration: Math.round(num(l.duration)),
    from: l.departurePoint?.commonName ?? "",
    to: l.arrivalPoint?.commonName ?? "",
    // For live "see more" departures. Bus arrivals want individualStopId (490003307Q)
    // — its naptanId is the StopArea group (490G…) which /Arrivals rejects. Overground/
    // rail are the reverse: naptanId (910GDALS) works, individualStopId (9100DALS0) 404s.
    // So carry both and let the endpoint try each.
    fromId: l.departurePoint?.individualStopId ?? l.departurePoint?.naptanId ?? null,
    fromAlt: l.departurePoint?.naptanId && l.departurePoint?.naptanId !== l.departurePoint?.individualStopId
      ? l.departurePoint.naptanId : null,
    dep: l.departureTime ?? null,
    arr: l.arrivalTime ?? null,
    instruction: l.instruction?.summary ?? "",
    path, stops,
  };
}

function parseJourney(j: any, i: number): JOption {
  const legs: JLeg[] = (j.legs ?? []).map(parseLeg);
  legs.forEach(enrichLeg);   // snap sparse Overground/rail/bus legs onto real geometry
  const walkMins = legs.filter((l: JLeg) => l.kind === "walk").reduce((a: number, l: JLeg) => a + l.duration, 0);
  const cycleMins = legs.filter((l: JLeg) => l.kind === "cycle").reduce((a: number, l: JLeg) => a + l.duration, 0);
  const transitLegs = legs.filter((l: JLeg) => l.kind === "transit");
  const kind = transitLegs.length === 0
    ? (cycleMins > 0 ? "full-cycle" : "full-walk")
    : "transit";
  return {
    id: `opt${i}`,
    duration: Math.round(num(j.duration)),
    dep: j.startDateTime ?? null,
    arr: j.arrivalDateTime ?? null,
    walkMins, cycleMins,
    changes: Math.max(0, transitLegs.length - 1),
    kind,
    summary: legs.map((l: JLeg) => ({ label: l.line ?? l.label, color: l.color, line: l.line })),
    legs,
  };
}

// ---------- Stadia Maps (hosted Valhalla) for full walk / cycle ----------
// Elevation-aware bike routing and any-distance walking, which TfL can't do. Only
// used for the full-walk / full-cycle options; transit stays on TfL.
const SKEY = (env: Env) => (env as any).STADIA_KEY as string | undefined;

function decodePolyline(str: string, precision = 6): [number, number][] {
  let index = 0, lat = 0, lon = 0; const out: [number, number][] = []; const factor = Math.pow(10, precision);
  while (index < str.length) {
    let shift = 0, result = 0, byte: number;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

async function stadiaFull(env: Env, toLat: number, toLon: number, mode: "walk" | "cycle"): Promise<JOption | null> {
  const key = SKEY(env); if (!key) return null;
  const costing = mode === "cycle" ? "bicycle" : "pedestrian";
  const body: any = {
    locations: [{ lat: HOME.lat, lon: HOME.lon }, { lat: toLat, lon: toLon }],
    costing, directions_options: { units: "kilometers" },
  };
  if (costing === "bicycle") body.costing_options = { bicycle: { use_hills: 0.5, bicycle_type: "Hybrid" } };
  try {
    const r = await fetch(`https://api.stadiamaps.com/route/v1?api_key=${key}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const d: any = await r.json();
    const trip = d.trip; if (!trip?.legs?.length) return null;
    const path: [number, number][] = [];
    for (const leg of trip.legs) path.push(...decodePolyline(leg.shape, 6));
    const dur = Math.round(num(trip.summary?.time) / 60);
    const kmTxt = `${(num(trip.summary?.length)).toFixed(1)} km`;
    const jleg: JLeg = {
      mode: costing, kind: mode, label: mode === "cycle" ? "Cycle" : "Walk",
      color: mode === "cycle" ? "#20c05b" : "#8a93a5", line: null, lineId: null,
      duration: dur, from: "Home", to: "", fromId: null, fromAlt: null,
      dep: null, arr: null, instruction: kmTxt, path, stops: [],
    };
    return {
      id: mode === "cycle" ? "fullcycle" : "fullwalk", duration: dur, dep: null, arr: null,
      walkMins: mode === "cycle" ? 0 : dur, cycleMins: mode === "cycle" ? dur : 0, changes: 0,
      kind: mode === "cycle" ? "full-cycle" : "full-walk",
      summary: [{ label: jleg.label, color: jleg.color, line: null }], legs: [jleg],
    };
  } catch { return null; }
}

async function jp(env: Env, to: string, params: Record<string, string>): Promise<any[]> {
  const qs = new URLSearchParams(params);
  if (env.TFL_APP_KEY) qs.set("app_key", env.TFL_APP_KEY);
  const url = `${TFL}/Journey/JourneyResults/${HOME.lat},${HOME.lon}/to/${to}?${qs}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, cf: { cacheTtl: 30, cacheEverything: true } });
  if (!r.ok) return [];
  const body: any = await r.json().catch(() => ({}));
  return body.journeys ?? [];
}

const TRANSIT = "bus,tube,dlr,overground,elizabeth-line,national-rail,tram,river-bus";

export async function planJourney(env: Env, toLat: number, toLon: number, mode: "walk" | "cycle"): Promise<{ options: JOption[]; dest: { lat: number; lon: number } }> {
  const to = `${toLat},${toLon}`;
  // NB: alternativeCycle/alternativeWalking mean "alternative TO that mode" — they
  // swap the cycle/walk-access journeys out for others, so we do NOT want them.
  // LeaveAtStation already returns both cycle-to-station+transit and full-cycle.
  const raw = mode === "cycle"
    ? await jp(env, to, { mode: TRANSIT, cyclePreference: "LeaveAtStation" })
    : await jp(env, to, { mode: `walking,${TRANSIT}`, walkingSpeed: "Average", maxWalkingMinutes: "15" });

  let options = raw.map(parseJourney);

  // Full walk / cycle: prefer Stadia (Valhalla) — elevation-aware bike, any-distance
  // walk, detailed geometry — and drop TfL's version. Fall back to TfL if no key.
  const fullKind = mode === "cycle" ? "full-cycle" : "full-walk";
  const stadia = await stadiaFull(env, toLat, toLon, mode);
  if (stadia) {
    options = options.filter(o => o.kind !== fullKind).concat(stadia);
  } else if (!options.some(o => o.kind === fullKind)) {
    const full = (await jp(env, to, mode === "cycle" ? { mode: "cycle", cyclePreference: "AllTheWay" } : { mode: "walking" })).map(parseJourney);
    options = options.concat(full);   // TfL walking 404s for long walks -> empty, which is fine
  }

  // De-duplicate identical leg-signatures, keep soonest/shortest first.
  const seen = new Set<string>();
  options = options.filter(o => {
    const sig = o.legs.map(l => `${l.mode}:${l.duration}`).join("|");
    if (seen.has(sig)) return false; seen.add(sig); return true;
  }).sort((a, b) => a.duration - b.duration).slice(0, 6);

  await enrichWithTflGeometry(env, options);   // fix Elizabeth/Heathrow-style bad geometry
  return { options, dest: { lat: toLat, lon: toLon } };
}

// ---------- live departures for a leg ("see more") ----------
export interface Departure { etaMin: number; expected: string; to: string; live: boolean; }
async function arrivalsAt(env: Env, stopId: string, lineId: string): Promise<Departure[]> {
  if (!stopId) return [];
  const qs = new URLSearchParams();
  if (env.TFL_APP_KEY) qs.set("app_key", env.TFL_APP_KEY);
  try {
    const r = await fetch(`${TFL}/StopPoint/${encodeURIComponent(stopId)}/Arrivals?${qs}`, {
      headers: { "User-Agent": UA, Accept: "application/json" }, cf: { cacheTtl: 15, cacheEverything: true },
    });
    if (!r.ok) return [];
    const preds: any[] = await r.json();
    const seen = new Set<string>();
    return preds
      .filter(p => !lineId || p.lineId === lineId)
      .map(p => ({ etaMin: Math.max(0, Math.round(p.timeToStation / 60)), expected: p.expectedArrival, to: (p.destinationName ?? p.towards ?? "").replace(/\s+(Rail|Underground)?\s*Station$/i, ""), live: true }))
      .sort((a, b) => a.etaMin - b.etaMin)
      // Busy interchanges list the same service on several platforms; collapse rows
      // with the same destination and departure minute.
      .filter(d => { const k = `${d.to}|${Math.round(Date.parse(d.expected) / 60000)}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 12);   // extra so the client can centre the list on the journey's departure
  } catch { return []; }
}
const normName = (s: string) => String(s ?? "").toLowerCase()
  .replace(/\s+(rail|underground|dlr|bus)?\s*station$/i, "").replace(/[^a-z0-9]/g, "").trim();

// Full ordered stop names per branch route of a line. stopPointSequences are split
// into disjoint pieces, so use orderedLineRoutes (each a complete end-to-end branch)
// mapped through the naptanId->name table the sequences provide.
const seqCache = new Map<string, string[][]>();
async function lineSequences(env: Env, lineId: string): Promise<string[][]> {
  if (seqCache.has(lineId)) return seqCache.get(lineId)!;
  const seqs: string[][] = [];
  try {
    const qs = new URLSearchParams({ serviceTypes: "Regular", excludeCrowding: "true" });
    if (env.TFL_APP_KEY) qs.set("app_key", env.TFL_APP_KEY);
    const r = await fetch(`${TFL}/Line/${lineId}/Route/Sequence/outbound?${qs}`, {
      headers: { "User-Agent": UA, Accept: "application/json" }, cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (r.ok) {
      const d: any = await r.json();
      const name: Record<string, string> = {};
      for (const sp of d.stopPointSequences ?? []) for (const s of sp.stopPoint ?? []) name[s.id] = normName(s.name);
      for (const route of d.orderedLineRoutes ?? []) {
        const seq = (route.naptanIds ?? []).map((id: string) => name[id]).filter(Boolean);
        if (seq.length >= 2) seqs.push(seq);
      }
    }
  } catch { /* ignore */ }
  seqCache.set(lineId, seqs);
  return seqs;
}
// Keep a departure only if travelling to its destination from `f` passes through the
// leg's alighting stop `t` — i.e. it's going the same way. Drops opposite-direction
// and terminating-here services. Fails open when the stops can't be located.
function keepDir(seqs: string[][], f: string, t: string, d: string): boolean {
  if (d === f) return false;                       // terminates at the boarding stop
  let locatedFT = false;
  for (const seq of seqs) {
    const fi = seq.indexOf(f), ti = seq.indexOf(t);
    if (fi < 0 || ti < 0) continue;
    locatedFT = true;
    const di = seq.indexOf(d);
    if (di < 0) continue;
    if (fi < ti ? di >= ti : di <= ti) return true;   // destination is beyond t, same way
  }
  return !locatedFT;   // couldn't judge -> keep; located but never confirmed -> opposite -> drop
}

// Bus vs Overground/rail disagree on which stop-id form /Arrivals accepts, so try the
// primary then the alternate; then keep only same-direction departures.
export async function legDepartures(env: Env, stopId: string, lineId: string, altId = "", fromName = "", toName = ""): Promise<Departure[]> {
  let deps = await arrivalsAt(env, stopId, lineId);
  if (!deps.length && altId && altId !== stopId) deps = await arrivalsAt(env, altId, lineId);
  if (fromName && toName) {
    const seqs = await lineSequences(env, lineId);
    if (seqs.length) { const f = normName(fromName), t = normName(toName); deps = deps.filter(x => keepDir(seqs, f, t, normName(x.to))); }
  }
  return deps.slice(0, 12);
}

// ---------- geocoding ----------
// A search result. Google predictions carry a placeId (coords resolved on pick via
// placeDetails); Photon/postcodes carry coords directly. `type` drives the icon.
export interface Place { name: string; detail: string; type: string; lat?: number; lon?: number; placeId?: string; }

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const GKEY = (env: Env) => (env as any).GOOGLE_MAPS_KEY as string | undefined;

// Category -> icon key the frontend renders (Material icons).
function googleType(types: string[] = []): string {
  const s = types.join(",");
  if (/airport/.test(s)) return "airport";
  if (/transit_station|subway|train_station|light_rail|bus_station|bus_stop/.test(s)) return "station";
  if (/restaurant|cafe|bar|food|meal_|bakery/.test(s)) return "restaurant";
  if (/lodging/.test(s)) return "hotel";
  if (/store|shopping|supermarket|shop/.test(s)) return "store";
  if (/\bpark\b/.test(s)) return "park";
  if (/school|university/.test(s)) return "school";
  if (/street_address|route|premise|subpremise|intersection/.test(s)) return "address";
  return "place";
}
function photonType(p: any): string {
  const k = p.osm_key, v = p.osm_value;
  if (k === "railway" || k === "public_transport" || v === "station" || v === "bus_stop" || v === "aerodrome") return v === "aerodrome" ? "airport" : "station";
  if (k === "amenity" && /restaurant|cafe|bar|pub|fast_food/.test(v)) return "restaurant";
  if (v === "hotel" || v === "hostel") return "hotel";
  if (k === "shop") return "store";
  if (v === "park") return "park";
  if (k === "highway" || p.housenumber) return "address";
  return "place";
}

async function geocodeGoogle(env: Env, q: string, session?: string): Promise<Place[]> {
  const key = GKEY(env); if (!key) return [];
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
    u.searchParams.set("input", q);
    u.searchParams.set("key", key);
    u.searchParams.set("components", "country:gb");
    u.searchParams.set("location", `${HOME.lat},${HOME.lon}`);
    u.searchParams.set("radius", "40000");   // bias toward London
    if (session) u.searchParams.set("sessiontoken", session);
    const r = await fetch(u.toString());
    if (!r.ok) return [];
    const d: any = await r.json();
    return (d.predictions ?? []).slice(0, 7).map((p: any) => ({
      name: p.structured_formatting?.main_text ?? p.description,
      detail: p.structured_formatting?.secondary_text ?? "",
      placeId: p.place_id,
      type: googleType(p.types),
    }));
  } catch { return []; }
}

// Resolve a Google place_id to coordinates (called when the user picks a result).
export async function placeDetails(env: Env, placeId: string, session?: string): Promise<{ lat: number; lon: number; name: string } | null> {
  const key = GKEY(env); if (!key || !placeId) return null;
  try {
    const u = new URL("https://maps.googleapis.com/maps/api/place/details/json");
    u.searchParams.set("place_id", placeId);
    u.searchParams.set("key", key);
    u.searchParams.set("fields", "geometry/location,name");
    if (session) u.searchParams.set("sessiontoken", session);
    const r = await fetch(u.toString());
    if (!r.ok) return null;
    const d: any = await r.json();
    const loc = d.result?.geometry?.location;
    return loc ? { lat: loc.lat, lon: loc.lng, name: d.result?.name ?? "" } : null;
  } catch { return null; }
}

async function geocodePhoton(q: string): Promise<Place[]> {
  const out: Place[] = [];
  if (UK_POSTCODE.test(q)) {
    try {
      const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q.replace(/\s+/g, ""))}`);
      if (r.ok) {
        const d: any = await r.json();
        if (d.result) out.push({ name: d.result.postcode, detail: [d.result.admin_ward, d.result.admin_district].filter(Boolean).join(", "), lat: d.result.latitude, lon: d.result.longitude, type: "place" });
      }
    } catch { /* fall through */ }
  }
  try {
    const u = new URL("https://photon.komoot.io/api/");
    u.searchParams.set("q", q); u.searchParams.set("limit", "6");
    u.searchParams.set("lat", String(HOME.lat)); u.searchParams.set("lon", String(HOME.lon)); u.searchParams.set("lang", "en");
    const r = await fetch(u.toString(), { headers: { "User-Agent": UA } });
    if (r.ok) {
      const d: any = await r.json();
      for (const f of d.features ?? []) {
        const p = f.properties ?? {}, [lon, lat] = f.geometry?.coordinates ?? [];
        if (lat == null) continue;
        const name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || p.city || p.postcode || "—";
        const detail = [p.street && p.name !== p.street ? p.street : null, p.district, p.city, p.postcode].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(", ");
        out.push({ name, detail, lat, lon, type: photonType(p) });
      }
    }
  } catch { /* ignore */ }
  const seen = new Set<string>();
  return out.filter(p => { const k = `${p.lat!.toFixed(4)},${p.lon!.toFixed(4)}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 7);
}

export async function geocode(env: Env, q: string, session?: string): Promise<Place[]> {
  q = q.trim();
  if (q.length < 2) return [];
  const g = await geocodeGoogle(env, q, session);   // best quality + types when a key is set
  return g.length ? g : geocodePhoton(q);            // else free OSM fallback
}

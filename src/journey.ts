import { Env } from "./tfl";
import home from "./cycle-stops.json";

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
    dep: l.departureTime ?? null,
    arr: l.arrivalTime ?? null,
    instruction: l.instruction?.summary ?? "",
    path, stops,
  };
}

function parseJourney(j: any, i: number): JOption {
  const legs = (j.legs ?? []).map(parseLeg);
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

  // Guarantee a full option of the chosen kind.
  if (mode === "cycle" && !options.some(o => o.kind === "full-cycle")) {
    const full = (await jp(env, to, { mode: "cycle", cyclePreference: "AllTheWay" })).map(parseJourney);
    options = options.concat(full);
  }
  if (mode === "walk" && !options.some(o => o.kind === "full-walk")) {
    const full = (await jp(env, to, { mode: "walking" })).map(parseJourney);
    options = options.concat(full);   // 404s for long walks -> empty, which is fine
  }

  // De-duplicate identical leg-signatures, keep soonest/shortest first.
  const seen = new Set<string>();
  options = options.filter(o => {
    const sig = o.legs.map(l => `${l.mode}:${l.duration}`).join("|");
    if (seen.has(sig)) return false; seen.add(sig); return true;
  }).sort((a, b) => a.duration - b.duration).slice(0, 6);

  return { options, dest: { lat: toLat, lon: toLon } };
}

// ---------- geocoding ----------
export interface Place { name: string; detail: string; lat: number; lon: number; }

const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

export async function geocode(q: string): Promise<Place[]> {
  q = q.trim();
  if (q.length < 2) return [];
  const out: Place[] = [];

  if (UK_POSTCODE.test(q)) {
    try {
      const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q.replace(/\s+/g, ""))}`);
      if (r.ok) {
        const d: any = await r.json();
        if (d.result) out.push({ name: d.result.postcode, detail: [d.result.admin_ward, d.result.admin_district].filter(Boolean).join(", "), lat: d.result.latitude, lon: d.result.longitude });
      }
    } catch { /* fall through to Photon */ }
  }

  // Photon: OSM autocomplete, biased around home so local matches rank first.
  try {
    const u = new URL("https://photon.komoot.io/api/");
    u.searchParams.set("q", q);
    u.searchParams.set("limit", "6");
    u.searchParams.set("lat", String(HOME.lat));
    u.searchParams.set("lon", String(HOME.lon));
    u.searchParams.set("lang", "en");
    const r = await fetch(u.toString(), { headers: { "User-Agent": UA } });
    if (r.ok) {
      const d: any = await r.json();
      for (const f of d.features ?? []) {
        const p = f.properties ?? {}, [lon, lat] = f.geometry?.coordinates ?? [];
        if (lat == null) continue;
        const name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || p.city || p.postcode || "—";
        const detail = [p.street && p.name !== p.street ? p.street : null, p.district, p.city, p.postcode].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(", ");
        out.push({ name, detail, lat, lon });
      }
    }
  } catch { /* ignore */ }

  // Dedup by rounded coord.
  const seen = new Set<string>();
  return out.filter(p => { const k = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 7);
}

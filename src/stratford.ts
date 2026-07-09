import { Env, tflJson, Prediction, etaMin } from "./tfl";

// Ported from the old FastAPI app.py with behaviour unchanged: same stop list,
// same blocklists, same JSON shape. The frontend at public/stratford is
// untouched apart from the API base URL.

const TFL_STOPPOINTS = ["940GZZLUSTD", "940GZZDLSTD", "940GZZDLSIT", "910GSTFD"];
const DLR_STRATFORD_INTL = "940GZZDLSIT";
const DARWIN_STATIONS = ["SRA", "SFA"];
const DARWIN_BASE = "https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120";
const JUBILEE_JSON_URL = "https://nr.whoosh.media/stations/get/SRA";

// Jubilee comes from the Whoosh feed instead; Elizabeth line and Overground
// (Mildmay) come from Darwin. Blocked here so they can't arrive twice.
const blocked = (line?: string, mode?: string) => {
  const l = (line ?? "").trim().toLowerCase();
  const m = (mode ?? "").trim().toLowerCase();
  return l === "jubilee" || l === "elizabeth line" || m === "elizabeth-line" || m === "overground";
};

async function tflStop(stopId: string, env: Env) {
  const sid = stopId.trim().toUpperCase();
  // Stratford International DLR and the National Rail NaPTANs are deliberately
  // never fetched — everything they'd return is blocked or comes from Darwin.
  if (sid === DLR_STRATFORD_INTL || sid.startsWith("910G")) return { stopId, rows: [] };

  const data = await tflJson<Prediction[]>(`/StopPoint/${sid}/Arrivals`, env);
  const rows = data
    .sort((a, b) => a.timeToStation - b.timeToStation)
    .slice(0, 60)
    .filter((p) => !blocked(p.lineName, p.modeName))
    .map((p) => ({
      line: p.lineName,
      mode: p.modeName,
      platform: p.platformName || "—",
      to: p.destinationName || p.towards || "—",
      etaMin: etaMin(p),
      expected: p.expectedArrival ?? null,
      direction: p.direction,
      stopId: p.naptanId ?? "",
    }));
  return { stopId, rows };
}

async function darwinBoard(crs: string, env: Env) {
  const qs = new URLSearchParams({ numRows: "150", timeWindow: "120" });
  const res = await fetch(`${DARWIN_BASE}/GetDepartureBoard/${crs}?${qs}`, {
    headers: { "x-apikey": env.DARWIN_TOKEN! },
    cf: { cacheTtl: 20, cacheEverything: true },
  });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("darwin auth"), { soft: true });
  if (!res.ok) throw new Error(`darwin ${crs} -> ${res.status}`);
  const data: any = await res.json();

  const services = data.trainServices ?? data.GetStationBoardResult?.trainServices ?? [];
  const rows = services.slice(0, 150).map((svc: any) => {
    let dests = svc.destination ?? [];
    if (!Array.isArray(dests) && dests.location) dests = [].concat(dests.location);
    const to = dests.map((d: any) => d?.locationName ?? "").filter(Boolean).join(", ") || "—";
    return { to, plat: svc.platform || "—", sched: svc.std || "—", est: svc.etd || "—", operator: svc.operator || "" };
  });
  return { crs, rows };
}

async function rail(env: Env) {
  if (!env.DARWIN_TOKEN) return [];
  try {
    return await Promise.all(DARWIN_STATIONS.map((crs) => darwinBoard(crs, env)));
  } catch (e: any) {
    if (e?.soft) return [];
    throw e;
  }
}

async function jubilee() {
  const res = await fetch(JUBILEE_JSON_URL, {
    headers: { "User-Agent": "transitboard/1.0", Accept: "application/json" },
    cf: { cacheTtl: 5, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`jubilee -> ${res.status}`);
  const data: any = await res.json();
  const list = data?.arrOutput?.Interchange?.TFL ?? [];

  const now = Math.floor(Date.now() / 1000);
  return list
    .filter((i: any) => (i.operator ?? "").trim().toLowerCase() === "jubilee")
    .map((i: any) => {
      const ts = i.etd ?? i.std;
      if (typeof ts !== "number") return null;
      const expected = Math.floor(ts / 60) * 60; // feed is minute-precision
      return {
        svc: "jubilee",
        to: (i.destination ?? "").trim() || "—",
        plat: (i.platform ?? "").trim() || "—",
        etaMin: Math.max(0, Math.floor((expected - now) / 60)),
        expected,
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.expected - b.expected)
    .slice(0, 60);
}

export async function stratfordBoard(env: Env) {
  const [tfl, railRows, jub] = await Promise.all([
    Promise.all(TFL_STOPPOINTS.map((s) => tflStop(s, env))),
    rail(env),
    jubilee().catch(() => []),
  ]);
  return { tfl, rail: railRows, jubilee: jub, ts: Math.floor(Date.now() / 1000) };
}

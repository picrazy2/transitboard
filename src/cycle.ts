import { Env, arrivals, etaMin } from "./tfl";
import { weather } from "./weather";
import data from "./cycle-stops.json";

// Cycle mode: trains only. Each station reports just the (line, direction) pairs
// it is the nearest cycle to — see tools/build-cycle-data.py. A live arrival is
// keyed by lineId + TfL direction; the station's `serve` map both filters it in
// and tells us whether it heads into or out of London.

export type Towards = "in" | "out";

export interface CycleRow {
  line: string; // display name, e.g. "Victoria"
  lineId: string;
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
  let preds;
  try {
    preds = await arrivals(st.id, env);
  } catch {
    return []; // a dead station must not blank the board
  }
  const serve = st.serve as unknown as Record<string, Towards>;
  const names = st.lineNames as unknown as Record<string, string>;

  const rows: CycleRow[] = [];
  const seen = new Set<string>();   // one row per vehicle; TfL repeats predictions
  for (const p of preds.slice().sort((a, b) => a.timeToStation - b.timeToStation)) {
    const lineId = p.lineId ?? "";
    const key = `${lineId}|${p.direction}`;
    const london = serve[key];
    if (!london) continue; // not a (line, direction) this station is nearest for
    const vk = p.vehicleId || `${key}|${p.expectedArrival}`;
    if (seen.has(vk)) continue;
    seen.add(vk);
    if (rows.length >= 12) break;
    rows.push({
      line: names[lineId] ?? p.lineName,
      lineId,
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

export async function cycleBoard(env: Env) {
  const [rowsPerStation, wx] = await Promise.all([
    Promise.all(data.stations.map((s) => stationRows(env, s))),
    weather(data.home.lat, data.home.lon).catch(() => null),
  ]);
  const rows = rowsPerStation.flat();

  const soonest = (a: CycleRow, b: CycleRow) => {
    const ta = a.expected ? Date.parse(a.expected) : Date.now() + a.etaMin * 60000;
    const tb = b.expected ? Date.parse(b.expected) : Date.now() + b.etaMin * 60000;
    return ta - tb;
  };
  const into = rows.filter((r) => r.london === "in").sort(soonest);
  const outof = rows.filter((r) => r.london === "out").sort(soonest);

  return { into, out: outof, weather: wx, cycMin: data.limitMin, ts: Math.floor(Date.now() / 1000) };
}

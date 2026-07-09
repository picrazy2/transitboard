import { Env, ArrivalDeparture, arrivals, etaMin, tflJson } from "./tfl";
import { weather } from "./weather";
import { busPins, Pin } from "./vehicles";
import data from "./stokey-stops.json";

// Each stop only reports the (line, direction) pairs it is the *nearest* stop
// for. Without this the same bus shows up three times, once per nearby stop.
// See tools/build-stokey-data.py.

// "in" = towards central London, "out" = away from it. Derived per line in
// tools/build-stokey-data.py; TfL's own inbound/outbound does not mean this.
export type Towards = "in" | "out";

export interface BusRow {
  line: string;
  dir: string;
  to: string;
  towards: string;
  london: Towards;
  etaMin: number;
  expected: string | null;
  stopId: string;
  stop: string;
  letter: string;
  walkMin: number;
  vehicleId: string;
}

export interface RailRow {
  line: string;
  to: string;
  plat: string;
  london: Towards;
  etaMin: number;
  scheduled: string | null;
  expected: string | null;
  /** Minutes late, from scheduled vs estimated. Null when TfL gives no estimate. */
  delayMin: number | null;
  cancelled: boolean;
  status: string;
}

const LONDON = data.london as Record<string, Towards>;

async function buses(env: Env): Promise<BusRow[]> {
  const rows = await Promise.all(
    data.stops.map(async (stop) => {
      const want = new Set(stop.primary);
      let preds;
      try {
        preds = await arrivals(stop.id, env);
      } catch {
        return []; // one dead stop shouldn't blank the board
      }
      return preds
        .filter((p) => want.has(`${p.lineName}|${p.direction}`))
        .slice(0, 12)
        .map((p) => ({
          line: p.lineName,
          dir: p.direction ?? "",
          // The live destination beats the route terminus: the 67's terminus is
          // "Forest Road", which tells a rider nothing.
          to: p.destinationName ?? p.towards ?? "—",
          towards: (data.terminus as Record<string, string>)[`${p.lineName}|${p.direction}`] ?? "",
          london: LONDON[`${p.lineName}|${p.direction}`] ?? "out",
          etaMin: etaMin(p),
          expected: p.expectedArrival ?? null,
          stopId: stop.id,
          stop: stop.name,
          letter: stop.letter,
          walkMin: stop.walk_min,
          vehicleId: p.vehicleId ?? "",
        }));
    }),
  );
  return rows.flat().sort((a, b) => a.etaMin - b.etaMin);
}

/** The soonest departure per (line, direction) — one board row, one map pin. */
const nextPerRoute = (rows: BusRow[]) => {
  const first = new Map<string, BusRow>();
  for (const r of rows) {
    const k = `${r.line}|${r.dir}`;
    if (!first.has(k)) first.set(k, r);
  }
  return [...first.values()];
};

const mmssToMin = (s?: string) => {
  const m = /^(-?\d+):(\d{2})$/.exec(s ?? "");
  return m ? Math.max(0, parseInt(m[1], 10)) : null;
};

// Weaver is the one mode here with a published timetable: ArrivalDepartures
// gives scheduled vs estimated, so it is the only place a real delay exists.
// It carries no direction field, only a destination.
async function rail(env: Env): Promise<RailRow[]> {
  const rows = await tflJson<ArrivalDeparture[]>(
    `/StopPoint/${data.rail.naptan}/ArrivalDepartures`, env, { lineIds: data.rail.lineId },
  );

  return rows
    .map((r) => {
      const sched = r.scheduledTimeOfDeparture ?? null;
      const est = r.estimatedTimeOfDeparture ?? null;
      const status = r.departureStatus ?? "";
      const delayMin = sched && est
        ? Math.round((Date.parse(est) - Date.parse(sched)) / 60000)
        : null;
      const eta = mmssToMin(r.minutesAndSecondsToDeparture)
        ?? (est ? Math.max(0, Math.round((Date.parse(est) - Date.now()) / 60000)) : null);
      return {
        line: data.rail.line,
        to: (r.destinationName ?? "—").replace(/\s+Rail Station$/, "").replace(/^London /, ""),
        // "Platform Unknown" is noise on a board; show nothing instead.
        plat: r.platformName && r.platformName !== "Platform Unknown" ? r.platformName : "—",
        london: (r.destinationNaptanId === data.rail.inDestinationNaptan ? "in" : "out") as Towards,
        etaMin: eta ?? 0,
        scheduled: sched,
        expected: est,
        delayMin,
        cancelled: status.toLowerCase() === "cancelled",
        status,
        _has: eta !== null,
      };
    })
    .filter((r) => r._has)
    .sort((a, b) => a.etaMin - b.etaMin)
    .slice(0, 12)
    .map(({ _has, ...r }) => r);
}

export async function stokeyBoard(env: Env) {
  const [bus, train, wx] = await Promise.all([
    buses(env),
    rail(env).catch(() => [] as RailRow[]),
    weather(data.home.lat, data.home.lon).catch(() => null),
  ]);

  let vehicles: Pin[] = [];
  if (bus.length) vehicles = await busPins(env, nextPerRoute(bus));

  return { buses: bus, rail: train, weather: wx, vehicles, ts: Math.floor(Date.now() / 1000) };
}

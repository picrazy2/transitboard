import { Env, ArrivalDeparture, arrivals, etaMin, tflJson } from "./tfl";
import { weather } from "./weather";
import { vehiclePins, Pin, PinInput } from "./vehicles";
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
  // Sort on expectedArrival, not the rounded minute: two buses 58 s and 86 s away
  // both have etaMin 1, and nextBuses() must still pick the nearer one.
  const at = (r: BusRow) => (r.expected ? Date.parse(r.expected) : Date.now() + r.etaMin * 60000);
  return rows.flat().sort((a, b) => at(a) - at(b));
}

/** The soonest departure per (line, direction) — one board row, one map pin. */
const nextBuses = (rows: BusRow[]): PinInput[] => {
  const first = new Map<string, BusRow>();
  for (const r of rows) {
    const k = `bus|${r.line}|${r.dir}`;
    if (!first.has(k)) first.set(k, r);
  }
  return [...first.entries()].map(([key, r]) => ({
    vehicleId: r.vehicleId, etaMin: r.etaMin, to: r.to, stop: r.stop,
    key, mode: "bus" as const, london: r.london,
  }));
};

const cleanRailDest = (name?: string) =>
  (name ?? "—").replace(/\s+Rail Station$/, "").replace(/^London /, "");

/**
 * The rail rows come from ArrivalDepartures, which carries scheduled times but
 * no vehicleId. Live predictions carry the vehicleId but no schedule — so pins
 * need their own call. One train per destination, matching the board's rows.
 */
async function nextTrains(env: Env): Promise<PinInput[]> {
  const preds = (await arrivals(data.rail.naptan, env)).filter((p) => p.lineName === data.rail.line);
  const first = new Map<string, PinInput>();
  for (const p of preds) {
    const to = cleanRailDest(p.destinationName);
    const key = `rail|${to}`;
    if (first.has(key) || !p.vehicleId) continue;
    first.set(key, {
      vehicleId: p.vehicleId,
      etaMin: etaMin(p),
      to,
      stop: "Stoke Newington",
      key,
      mode: "rail",
      london: p.direction === data.rail.inDirection ? "in" : "out",
    });
  }
  return [...first.values()];
}

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
      // Floor, not round: a 30-second difference is not "1 min late", and
      // rounding it up strikes through a time and replaces it with itself.
      const delayMin = sched && est
        ? Math.max(0, Math.floor((Date.parse(est) - Date.parse(sched)) / 60000))
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
  const [bus, train, wx, trainPins] = await Promise.all([
    buses(env),
    rail(env).catch(() => [] as RailRow[]),
    weather(data.home.lat, data.home.lon).catch(() => null),
    nextTrains(env).catch(() => [] as PinInput[]),
  ]);

  const wanted = [...nextBuses(bus), ...trainPins];
  const vehicles: Pin[] = wanted.length ? await vehiclePins(env, wanted) : [];

  return { buses: bus, rail: train, weather: wx, vehicles, ts: Math.floor(Date.now() / 1000) };
}

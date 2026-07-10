import { Env, ArrivalDeparture, Prediction, arrivals, etaMin, tflJson } from "./tfl";
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
  /** Matched across from the live predictions; null when no confident match. */
  vehicleId: string | null;
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
    vehicleId: r.vehicleId, etaMin: r.etaMin, expected: r.expected, to: r.to, stop: r.stop,
    key, mode: "bus" as const, london: r.london,
  }));
};

const cleanRailDest = (name?: string) =>
  (name ?? "—").replace(/\s+Rail Station$/, "").replace(/^London /, "");

const weaverArrivals = async (env: Env) =>
  (await arrivals(data.rail.naptan, env)).filter((p) => p.lineName === data.rail.line);

/** Pin every train we can place, so any rail row can be focused individually. */
const MAX_TRAIN_PINS = 8;

/**
 * A train's pin must count down to the same instant its row does. The row uses
 * `estimatedTimeOfDeparture`; the prediction carries `expectedArrival`, which is
 * about 30 s earlier — the dwell. Left alone, a row reading 1:05 had a pin
 * reading 0m. So the pin borrows its row's departure time where we have one.
 */
function trainPins(preds: Prediction[], rows: RailRow[]): PinInput[] {
  const departs = new Map<string, { expected: string | null; etaMin: number }>();
  for (const r of rows) {
    if (r.vehicleId) departs.set(r.vehicleId, { expected: r.expected, etaMin: r.etaMin });
  }

  const seen = new Set<string>();
  const out: PinInput[] = [];
  for (const p of [...preds].sort((a, b) => a.timeToStation - b.timeToStation)) {
    if (!p.vehicleId || seen.has(p.vehicleId)) continue;
    seen.add(p.vehicleId);
    const to = cleanRailDest(p.destinationName);
    const row = departs.get(p.vehicleId);
    out.push({
      vehicleId: p.vehicleId,
      etaMin: row?.etaMin ?? etaMin(p),
      expected: row?.expected ?? p.expectedArrival ?? null,
      to,
      stop: "Stoke Newington",
      key: `rail|${to}`,
      mode: "rail",
      london: p.direction === data.rail.inDirection ? "in" : "out",
    });
    if (out.length >= MAX_TRAIN_PINS) break;
  }
  return out;
}

/**
 * ArrivalDepartures carries the schedule but no vehicleId; the live predictions
 * carry the vehicleId but no schedule. Join them on destination and expected
 * time — a 90 s window matches 16 of 17 rows uniquely, with no ambiguity — so a
 * rail row can be focused down to one train.
 */
const MATCH_WINDOW_MS = 90_000;

function matchVehicle(row: ArrivalDeparture, preds: Prediction[]): string | null {
  const when = Date.parse(row.estimatedTimeOfDeparture ?? row.scheduledTimeOfDeparture ?? "");
  if (!Number.isFinite(when)) return null;
  const hits = preds.filter((p) =>
    p.destinationNaptanId === row.destinationNaptanId &&
    p.expectedArrival &&
    Math.abs(Date.parse(p.expectedArrival) - when) <= MATCH_WINDOW_MS);
  return hits.length === 1 ? hits[0].vehicleId ?? null : null;   // never guess
}

const mmssToMin = (s?: string) => {
  const m = /^(-?\d+):(\d{2})$/.exec(s ?? "");
  return m ? Math.max(0, parseInt(m[1], 10)) : null;
};

// Weaver is the one mode here with a published timetable: ArrivalDepartures
// gives scheduled vs estimated, so it is the only place a real delay exists.
// It carries no direction field, only a destination.
async function rail(env: Env, preds: Prediction[]): Promise<RailRow[]> {
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
        vehicleId: matchVehicle(r, preds),
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
  const [bus, wx, preds] = await Promise.all([
    buses(env),
    weather(data.home.lat, data.home.lon).catch(() => null),
    weaverArrivals(env).catch(() => [] as Prediction[]),
  ]);
  const train = await rail(env, preds).catch(() => [] as RailRow[]);

  const wanted = [...nextBuses(bus), ...trainPins(preds, train)];
  const vehicles: Pin[] = wanted.length ? await vehiclePins(env, wanted) : [];

  return { buses: bus, rail: train, weather: wx, vehicles, ts: Math.floor(Date.now() / 1000) };
}

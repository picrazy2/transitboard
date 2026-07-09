import { Env, arrivals, etaMin } from "./tfl";
import { weather } from "./weather";
import data from "./stokey-stops.json";

// Each stop only reports the (line, direction) pairs it is the *nearest* stop
// for. Without this the same bus shows up three times, once per nearby stop.
// See tools/build-stokey-data.py.

export interface BusRow {
  line: string;
  dir: string;
  to: string;
  towards: string;
  etaMin: number;
  expected: string | null;
  stopId: string;
  stop: string;
  letter: string;
  walkMin: number;
}

export interface RailRow {
  line: string;
  to: string;
  plat: string;
  etaMin: number;
  expected: string | null;
  direction: string;
}

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
          to: p.destinationName ?? p.towards ?? "—",
          towards: (data.terminus as Record<string, string>)[`${p.lineName}|${p.direction}`] ?? "",
          etaMin: etaMin(p),
          expected: p.expectedArrival ?? null,
          stopId: stop.id,
          stop: stop.name,
          letter: stop.letter,
          walkMin: stop.walk_min,
        }));
    }),
  );
  return rows.flat().sort((a, b) => a.etaMin - b.etaMin);
}

async function rail(env: Env): Promise<RailRow[]> {
  const preds = await arrivals(data.rail.naptan, env);
  return preds
    .filter((p) => p.lineName === data.rail.line)
    .slice(0, 12)
    .map((p) => ({
      line: p.lineName,
      to: (p.destinationName ?? "—").replace(/\s+Rail Station$/, "").replace(/^London /, ""),
      plat: p.platformName ?? "—",
      etaMin: etaMin(p),
      expected: p.expectedArrival ?? null,
      direction: p.direction ?? "",
    }));
}

export async function stokeyBoard(env: Env) {
  const [bus, train, wx] = await Promise.all([
    buses(env),
    rail(env).catch(() => [] as RailRow[]),
    weather(data.home.lat, data.home.lon).catch(() => null),
  ]);
  return { buses: bus, rail: train, weather: wx, ts: Math.floor(Date.now() / 1000) };
}

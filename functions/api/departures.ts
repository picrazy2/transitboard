import { Env } from "../../src/tfl";
import { legDepartures, scheduledDepartures } from "../../src/journey";

// /api/departures?stop=<naptan>&line=<lineId>&from=<name>&to=<name>
//   [&toStop=<naptan>&at=<epoch ms>]  — upcoming departures for a journey leg's boarding
// stop ("see more times"). Live by default; when the trip is planned far enough ahead that
// the live feed (~30 min) won't cover it, fall back to TfL's scheduled timetable.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const u = new URL(request.url);
  const stop = u.searchParams.get("stop") ?? "";
  const alt = u.searchParams.get("alt") ?? "";
  const line = u.searchParams.get("line") ?? "";
  const from = u.searchParams.get("from") ?? "";
  const to = u.searchParams.get("to") ?? "";
  const toStop = u.searchParams.get("toStop") ?? "";
  const at = Number(u.searchParams.get("at"));
  if (!stop) return new Response(JSON.stringify({ departures: [] }), { headers: { "content-type": "application/json" } });
  // Beyond ~25 min out the live board is empty for this train, so use the timetable.
  const scheduled = Number.isFinite(at) && at > Date.now() + 25 * 60000 && !!toStop && !!line;
  const departures = scheduled
    ? await scheduledDepartures(env, line, alt || stop, toStop, to, at)
    : await legDepartures(env, stop, line, alt, from, to);
  return new Response(JSON.stringify({ departures, scheduled }), {
    headers: { "content-type": "application/json", "cache-control": scheduled ? "public, max-age=300" : "public, max-age=15" },
  });
};

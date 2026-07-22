import { Env } from "../../src/tfl";
import { legDepartures } from "../../src/journey";

// /api/departures?stop=<naptan>&line=<lineId> — live upcoming departures for a
// journey leg's boarding stop, used by the planner's "see more times".
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const u = new URL(request.url);
  const stop = u.searchParams.get("stop") ?? "";
  const alt = u.searchParams.get("alt") ?? "";
  const line = u.searchParams.get("line") ?? "";
  if (!stop) return new Response(JSON.stringify({ departures: [] }), { headers: { "content-type": "application/json" } });
  const departures = await legDepartures(env, stop, line, alt);
  return new Response(JSON.stringify({ departures }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=15" },
  });
};

import { Env } from "../../src/tfl";
import { planJourney } from "../../src/journey";

// /api/journey?to=<lat>,<lon>&mode=walk|cycle  (origin is always home)
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const u = new URL(request.url);
  const to = (u.searchParams.get("to") ?? "").split(",").map(Number);
  const mode = u.searchParams.get("mode") === "cycle" ? "cycle" : "walk";
  if (to.length !== 2 || !Number.isFinite(to[0]) || !Number.isFinite(to[1])) {
    return new Response(JSON.stringify({ error: "bad to" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const result = await planJourney(env, to[0], to[1], mode);
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=20" },
  });
};

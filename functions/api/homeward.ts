import { Env } from "../../src/tfl";
import { planHomeward } from "../../src/journey";

// /api/homeward?from=<lat>,<lon>  — reverse of /api/journey. Plans cycle+transit routes
// from the user's current location back home (mobile "get me home with my bike" view).
// Destination is always home; only the origin varies.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const u = new URL(request.url);
  const from = (u.searchParams.get("from") ?? "").split(",").map(Number);
  const stage = u.searchParams.get("stage") === "fast" ? "fast" : "full";
  if (from.length !== 2 || !Number.isFinite(from[0]) || !Number.isFinite(from[1])) {
    return new Response(JSON.stringify({ error: "bad from" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const result = await planHomeward(env, from[0], from[1], stage);
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=20" },
  });
};

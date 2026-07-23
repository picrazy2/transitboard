import { Env } from "../../src/tfl";
import { planRoute } from "../../src/journey";

const HOME = "51.5611161,-0.0739865";

// /api/route?from=<lat>,<lon>&to=<lat>,<lon>&toName=<label>&stage=fast|full
// General point-to-point cycle+transit planner for the mobile view. `to` defaults to home
// (the "get me home" case); either endpoint can be arbitrary.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const u = new URL(request.url);
  const from = (u.searchParams.get("from") ?? "").split(",").map(Number);
  const to = (u.searchParams.get("to") || HOME).split(",").map(Number);
  const stage = u.searchParams.get("stage") === "fast" ? "fast" : "full";
  const mode = u.searchParams.get("mode") === "walk" ? "walk" : "cycle";
  const toName = u.searchParams.get("toName") ?? "";
  const ok = (p: number[]) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  if (!ok(from) || !ok(to)) {
    return new Response(JSON.stringify({ error: "bad from/to" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const result = await planRoute(env, from[0], from[1], to[0], to[1], stage, toName, mode);
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=20" },
  });
};

import { Env } from "../../../src/tfl";
import { lineVehicles } from "../../../src/vehicles";

// Every vehicle on the requested lines, not just the next one per board row.
// /Line/{ids}/Arrivals is ~150 KB per line inbound, but only the vehicle
// positions come back out — all ten lines cost ~35 KB of response.
const MAX_LINES = 10;

export const onRequestGet: PagesFunction<Env, "board"> = async ({ params, env, request }) => {
  if (String(params.board) !== "stokey") {
    return Response.json({ error: "unknown board" }, { status: 404 });
  }
  if (!env.TFL_APP_KEY) {
    return Response.json({ error: "TFL_APP_KEY is not configured" }, { status: 500 });
  }

  const raw = new URL(request.url).searchParams.get("lines") ?? "";
  const lines = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!lines.length) return Response.json({ vehicles: [] });
  if (lines.length > MAX_LINES) {
    return Response.json(
      { error: `at most ${MAX_LINES} lines`, asked: lines.length },
      { status: 400 },
    );
  }

  try {
    const vehicles = await lineVehicles(env, lines);
    return Response.json({ lines, vehicles, ts: Math.floor(Date.now() / 1000) }, {
      headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=45" },
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 502 });
  }
};

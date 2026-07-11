import { Env } from "../../../src/tfl";
import { stokeyBoard } from "../../../src/stokey";
import { stratfordBoard } from "../../../src/stratford";
import { cycleBoard } from "../../../src/cycle";

const BOARDS: Record<string, (env: Env) => Promise<unknown>> = {
  stokey: stokeyBoard,
  cycle: cycleBoard,
  stratford: stratfordBoard,
};

export const onRequestGet: PagesFunction<Env, "board"> = async ({ params, env }) => {
  const build = BOARDS[String(params.board)];
  if (!build) {
    return Response.json({ error: `unknown board`, boards: Object.keys(BOARDS) }, { status: 404 });
  }
  if (!env.TFL_APP_KEY) {
    return Response.json({ error: "TFL_APP_KEY is not configured" }, { status: 500 });
  }

  try {
    const payload = await build(env);
    return Response.json(payload, {
      // Same-origin, so no CORS. Board polls every 60 s; a short edge cache
      // absorbs the extra iPads without hammering TfL.
      headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=45" },
    });
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 502 });
  }
};

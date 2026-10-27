import { Env } from "../../../src/tfl";
import { stokeyBoard } from "../../../src/stokey";
import { stratfordBoard } from "../../../src/stratford";
import { cycleBoard } from "../../../src/cycle";
import { edgeCached } from "../../../src/edge";

const BOARDS: Record<string, (env: Env) => Promise<unknown>> = {
  stokey: stokeyBoard,
  cycle: cycleBoard,
  stratford: stratfordBoard,
};

export const onRequestGet: PagesFunction<Env, "board"> = async (ctx) => {
  const { params, env } = ctx;
  const build = BOARDS[String(params.board)];
  if (!build) {
    return Response.json({ error: `unknown board`, boards: Object.keys(BOARDS) }, { status: 404 });
  }
  if (!env.TFL_APP_KEY) {
    return Response.json({ error: "TFL_APP_KEY is not configured" }, { status: 500 });
  }

  try {
    // Board polls every 60 s; 20 s at the edge means extra iPads, the warm
    // fetch of the other mode, and a quick reload all reuse one build.
    return await edgeCached(ctx, `/api/board/${params.board}`, 20, () => build(env));
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 502 });
  }
};

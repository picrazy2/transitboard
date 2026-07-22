import { Env } from "../../src/tfl";
import { placeDetails } from "../../src/journey";

// /api/place?id=<placeId>&session=<token>  -> {lat,lon,name}. Resolves a Google
// Places prediction to coordinates when the user picks it.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const u = new URL(request.url);
  const id = u.searchParams.get("id") ?? "";
  const session = u.searchParams.get("session") ?? undefined;
  const place = await placeDetails(env, id, session);
  return new Response(JSON.stringify({ place }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

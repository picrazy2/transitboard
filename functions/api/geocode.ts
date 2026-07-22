import { Env } from "../../src/tfl";
import { geocode } from "../../src/journey";

// /api/geocode?q=<query>&session=<token>  -> ranked matches (Google Places when a
// GOOGLE_MAPS_KEY is set, else Photon/postcodes.io). session token groups an
// autocomplete session for Google billing.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const u = new URL(request.url);
  const q = u.searchParams.get("q") ?? "";
  const session = u.searchParams.get("session") ?? undefined;
  const places = await geocode(env, q, session);
  return new Response(JSON.stringify({ places }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=120" },
  });
};

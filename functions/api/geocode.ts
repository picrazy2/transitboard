import { Env } from "../../src/tfl";
import { geocode } from "../../src/journey";

// /api/geocode?q=<query>  -> ranked address/postcode matches near home
export const onRequestGet: PagesFunction<Env> = async ({ request }) => {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const places = await geocode(q);
  return new Response(JSON.stringify({ places }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
};

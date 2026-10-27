// Pages Functions run on every request: a Cache-Control header on the response
// tells browsers what to do but never short-circuits the function itself. So
// every poll from every iPad re-ran the whole build (several TfL fetches and,
// for the fleet, ~150 KB of JSON parsed per line) and burned the free plan's
// CPU budget. Put the built JSON in the colo's cache: a hit is a lookup and a
// stream, well under a millisecond of CPU.
//
// `key` must be canonical (sorted params etc.) so equivalent requests share it.
export async function edgeCached(
  ctx: { request: Request; waitUntil: (p: Promise<unknown>) => void },
  key: string,
  ttl: number,
  build: () => Promise<unknown>,
): Promise<Response> {
  const cache = (caches as any).default as Cache;
  const req = new Request(new URL(key, ctx.request.url).toString());
  const hit = await cache.match(req);
  if (hit) return hit;

  const body = JSON.stringify(await build());
  const res = new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttl}`,
    },
  });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

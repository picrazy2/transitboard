export interface Env {
  TFL_APP_KEY: string;
  DARWIN_TOKEN?: string;
}

const TFL = "https://api.tfl.gov.uk";

// api.tfl.gov.uk sits behind Cloudflare and returns "error code: 1010" to
// requests without a recognisable User-Agent.
const UA = "transitboard/1.0 (+https://board.akguo.com)";

export async function tflJson<T = any>(
  path: string,
  env: Env,
  params: Record<string, string> = {},
  ttl = 20,
): Promise<T> {
  const qs = new URLSearchParams(params);
  if (env.TFL_APP_KEY) qs.set("app_key", env.TFL_APP_KEY);
  const res = await fetch(`${TFL}${path}?${qs}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`TfL ${path} -> ${res.status}`);
  return res.json();
}

export interface Prediction {
  lineName: string;
  modeName: string;
  destinationName?: string;
  towards?: string;
  platformName?: string;
  timeToStation: number;
  expectedArrival?: string;
  direction?: string;
  naptanId?: string;
}

export async function arrivals(stopId: string, env: Env): Promise<Prediction[]> {
  const rows = await tflJson<Prediction[]>(`/StopPoint/${stopId}/Arrivals`, env);
  return rows.sort((a, b) => a.timeToStation - b.timeToStation);
}

export const etaMin = (p: Prediction) => Math.max(0, Math.round((p.timeToStation ?? 0) / 60));

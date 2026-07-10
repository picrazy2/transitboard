// Open-Meteo: no API key required.
// timeformat=unixtime keeps every timestamp unambiguous — with the default
// ISO format Open-Meteo returns naive local times ("2026-07-09T20:00") that
// are an hour out if you parse them as UTC during BST.
// The board answers one question: what should I wear on the way out. So: the
// temperature and conditions now, and the same for the next few hours.
const FIELDS = {
  current: "temperature_2m,weather_code,is_day",
  hourly: "temperature_2m,weather_code,is_day",
  daily: "temperature_2m_max,temperature_2m_min",
};

export interface Weather {
  tempC: number;
  code: number;
  isDay: boolean;
  maxC: number;
  minC: number;
  next: { at: number; tempC: number; code: number; isDay: boolean }[];
}

export async function weather(lat: number, lon: number): Promise<Weather> {
  const qs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: "Europe/London",
    timeformat: "unixtime",
    forecast_days: "2",
    ...FIELDS,
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${qs}`, {
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`open-meteo -> ${res.status}`);
  const d: any = await res.json();

  const now = Math.floor(Date.now() / 1000);
  const start = Math.max(0, d.hourly.time.findIndex((t: number) => t >= now));
  const next = d.hourly.time.slice(start, start + 5).map((t: number, i: number) => ({
    at: t,
    tempC: d.hourly.temperature_2m[start + i],
    code: d.hourly.weather_code[start + i],
    isDay: !!d.hourly.is_day[start + i],
  }));

  return {
    tempC: d.current.temperature_2m,
    code: d.current.weather_code,
    isDay: !!d.current.is_day,
    maxC: d.daily.temperature_2m_max[0],
    minC: d.daily.temperature_2m_min[0],
    next,
  };
}

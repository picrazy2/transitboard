// Open-Meteo: no API key required.
// timeformat=unixtime keeps every timestamp unambiguous — with the default
// ISO format Open-Meteo returns naive local times ("2026-07-09T20:00") that
// are an hour out if you parse them as UTC during BST.
// The board answers one question: what should I wear on the way out. So: the
// temperature and conditions now, and the same for the next few hours.
const FIELDS = {
  current: "temperature_2m,weather_code,is_day,apparent_temperature,wind_speed_10m,relative_humidity_2m",
  hourly: "temperature_2m,weather_code,is_day,precipitation_probability",
  daily: "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max",
};

export interface Weather {
  tempC: number;
  code: number;
  isDay: boolean;
  maxC: number;
  minC: number;
  feelsC: number;
  windKph: number;
  humidity: number;
  next: { at: number; tempC: number; code: number; isDay: boolean }[];   // header strip (legacy)
  hours: { at: number; tempC: number; code: number; isDay: boolean; pop: number }[]; // 24h, for the modal
  days: { at: number; maxC: number; minC: number; code: number; pop: number }[];      // 7-day, for the modal
}

export async function weather(lat: number, lon: number): Promise<Weather> {
  const qs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: "Europe/London",
    timeformat: "unixtime",
    forecast_days: "7",
    ...FIELDS,
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${qs}`, {
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`open-meteo -> ${res.status}`);
  const d: any = await res.json();

  const now = Math.floor(Date.now() / 1000);
  const start = Math.max(0, d.hourly.time.findIndex((t: number) => t >= now));
  const hour = (i: number) => ({
    at: d.hourly.time[i], tempC: d.hourly.temperature_2m[i],
    code: d.hourly.weather_code[i], isDay: !!d.hourly.is_day[i],
    pop: d.hourly.precipitation_probability?.[i] ?? 0,
  });
  const hours = d.hourly.time.slice(start, start + 24).map((_: number, i: number) => hour(start + i));

  return {
    tempC: d.current.temperature_2m,
    code: d.current.weather_code,
    isDay: !!d.current.is_day,
    maxC: d.daily.temperature_2m_max[0],
    minC: d.daily.temperature_2m_min[0],
    feelsC: d.current.apparent_temperature,
    windKph: Math.round(d.current.wind_speed_10m),
    humidity: d.current.relative_humidity_2m,
    next: hours.slice(0, 5).map(({ pop, ...h }: any) => h),
    hours,
    days: d.daily.time.map((t: number, i: number) => ({
      at: t, maxC: d.daily.temperature_2m_max[i], minC: d.daily.temperature_2m_min[i],
      code: d.daily.weather_code[i], pop: d.daily.precipitation_probability_max?.[i] ?? 0,
    })),
  };
}

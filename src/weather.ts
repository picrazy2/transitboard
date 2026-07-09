// Open-Meteo: no API key required.
// timeformat=unixtime keeps every timestamp unambiguous — with the default
// ISO format Open-Meteo returns naive local times ("2026-07-09T20:00") that
// are an hour out if you parse them as UTC during BST.
const FIELDS = {
  current: "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,is_day",
  hourly: "temperature_2m,precipitation_probability",
  daily: "temperature_2m_max,temperature_2m_min,sunrise,sunset",
};

export interface Weather {
  tempC: number;
  feelsC: number;
  code: number;
  isDay: boolean;
  windKph: number;
  precipMm: number;
  maxC: number;
  minC: number;
  sunrise: number;
  sunset: number;
  next: { at: number; tempC: number; rainPct: number }[];
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
  const next = d.hourly.time.slice(start, start + 6).map((t: number, i: number) => ({
    at: t,
    tempC: d.hourly.temperature_2m[start + i],
    rainPct: d.hourly.precipitation_probability[start + i],
  }));

  return {
    tempC: d.current.temperature_2m,
    feelsC: d.current.apparent_temperature,
    code: d.current.weather_code,
    isDay: !!d.current.is_day,
    windKph: d.current.wind_speed_10m,
    precipMm: d.current.precipitation,
    maxC: d.daily.temperature_2m_max[0],
    minC: d.daily.temperature_2m_min[0],
    sunrise: d.daily.sunrise[0],
    sunset: d.daily.sunset[0],
    next,
  };
}

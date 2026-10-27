// Weather board. Everything is fetched straight from the browser — Open-Meteo,
// RainViewer, TfL and OSM all allow cross-origin calls without a key — so this
// page costs zero Cloudflare function invocations however long it stays on.
//
//   Open-Meteo forecast   now / 15-min rain / hourly / 10-day. For London its
//                         "best match" is the Met Office UKV 2 km model for the
//                         first ~2 days, then ECMWF/ICON.
//   Open-Meteo air        European AQI, pollutants, pollen (CAMS).
//   RainViewer            last ~2 h of radar, 10-min frames (zoom ≤7 natively).
//   TfL Unified API       nearby stations, live arrivals, and for Overground /
//                         Elizabeth stations the timetable (so delays are real).
//   Nominatim             neighbourhood name for the header.
//
// Styling follows the budget app's design system (see weather.css): Material
// Symbols for every icon, colours read from the CSS tokens so charts follow the
// light/dark theme, which itself follows the sun.

const HOME = { lat: 51.5611161, lon: -0.0739865, name: "Stoke Newington" };
const HOME_STATION = "910GSTKNWNG";   // pinned when we're within HOME_RADIUS of it
const HOME_RADIUS = 2000;
const WX_MS = 10 * 60e3, AQ_MS = 30 * 60e3, DEP_MS = 30e3, LOC_MS = 30 * 60e3;
const THEME = new URLSearchParams(location.search).get("theme");   // ?theme=light|dark pins it

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// SVG presentation attributes can't take var(), so charts resolve tokens at draw time.
const V = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let LOC = store.get("wx.loc", null) || { lat: HOME.lat, lon: HOME.lon, approx: true };
let PLACE = store.get("wx.place", HOME.name);
let WX = null, AQ = null, wxAt = 0;
let hourMode = "temp", hourSel = 0;

// ---------- formatting ----------
let TZ;   // the forecast location's zone, once known; device zone until then
const fmt = (sec, o) => new Date(sec * 1000).toLocaleString("en-GB", { timeZone: TZ, ...o });
const hm = sec => fmt(sec, { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s/g, " ");
const hr = sec => fmt(sec, { hour: "numeric", hour12: true }).replace(/\s/g, "");
const wd = sec => fmt(sec, { weekday: "short" });
const dayKey = sec => fmt(sec, { year: "numeric", month: "2-digit", day: "2-digit" });
const r0 = v => v == null ? "–" : Math.round(v);
const deg = v => `${r0(v)}°`;
const dur = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const compass = d => COMPASS[Math.round(((d % 360) / 22.5)) % 16];
const metres = (a, b) => {
  const R = 6371000, p = Math.PI / 180, dLat = (b.lat - a.lat) * p, dLon = (b.lon - a.lon) * p;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// ---------- icons (Material Symbols Rounded) ----------
const ms = (name, cls = "") => `<span class="ms ${cls}">${name}</span>`;
const WMO = {
  0:["sunny","clear_night","Clear"], 1:["sunny","clear_night","Mostly clear"],
  2:["partly_cloudy_day","partly_cloudy_night","Partly cloudy"], 3:["cloud","cloud","Overcast"],
  45:["foggy","foggy","Fog"], 48:["foggy","foggy","Rime fog"],
  51:["rainy_light","rainy_light","Light drizzle"], 53:["rainy_light","rainy_light","Drizzle"], 55:["rainy","rainy","Heavy drizzle"],
  56:["weather_mix","weather_mix","Freezing drizzle"], 57:["weather_mix","weather_mix","Freezing drizzle"],
  61:["rainy_light","rainy_light","Light rain"], 63:["rainy","rainy","Rain"], 65:["rainy_heavy","rainy_heavy","Heavy rain"],
  66:["weather_mix","weather_mix","Freezing rain"], 67:["weather_mix","weather_mix","Freezing rain"],
  71:["weather_snowy","weather_snowy","Light snow"], 73:["weather_snowy","weather_snowy","Snow"],
  75:["weather_snowy","weather_snowy","Heavy snow"], 77:["weather_snowy","weather_snowy","Snow grains"],
  80:["rainy_light","rainy_light","Showers"], 81:["rainy","rainy","Heavy showers"], 82:["rainy_heavy","rainy_heavy","Violent showers"],
  85:["weather_snowy","weather_snowy","Snow showers"], 86:["weather_snowy","weather_snowy","Snow showers"],
  95:["thunderstorm","thunderstorm","Thunderstorm"], 96:["thunderstorm","thunderstorm","Thunder, hail"], 99:["thunderstorm","thunderstorm","Thunder, hail"],
};
// Condition icons: a small multi-colour set in Material's rounded, filled style, so a
// rain icon is a grey cloud with blue drops and partly-cloudy is a yellow sun behind
// a grey cloud — which a one-colour icon font can't do. Drawn on a 24-unit grid;
// colours come from tokens via style= (SVG presentation attributes can't take var()).
const F = v => `style="fill:var(${v})"`, S = (v, w = 1.8) => `style="stroke:var(${v});stroke-width:${w};stroke-linecap:round;fill:none"`;
const CLOUD = "M6.5 19a4.5 4.5 0 0 1-.4-8.98A6 6 0 0 1 17.6 9.1a5 5 0 0 1-.1 9.9z";
const cloudP = (tx, ty, k, tone = "--cloud") => `<path transform="translate(${tx} ${ty}) scale(${k})" d="${CLOUD}" ${F(tone)}/>`;
const sunP = (cx, cy, r) => {
  let s = `<circle cx="${cx}" cy="${cy}" r="${r}" ${F("--sun")}/>`;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, c = Math.cos(a), n = Math.sin(a);
    s += `<line x1="${(cx + c * (r + 1.6)).toFixed(2)}" y1="${(cy + n * (r + 1.6)).toFixed(2)}" x2="${(cx + c * (r + 3.2)).toFixed(2)}" y2="${(cy + n * (r + 3.2)).toFixed(2)}" ${S("--sun", 1.7)}/>`;
  }
  return s;
};
const moonP = (cx, cy, r) => `<path d="M${cx + r * .35} ${cy - r}A${r} ${r} 0 1 0 ${cx + r} ${cy + r * .35}A${r * .78} ${r * .78} 0 0 1 ${cx + r * .35} ${cy - r}z" ${F("--moon")}/>`;
const drops = (n, tone = "--rain") => [[7, 17], [11, 18.5], [15, 17], [9, 21], [13, 21.5]].slice(0, n)
  .map(([x, y]) => `<line x1="${x}" y1="${y}" x2="${x - 1}" y2="${y + 2.4}" ${S(tone, 1.9)}/>`).join("");
const flakes = n => [[7.5, 17.5], [12, 19], [16.5, 17.5], [9.5, 22], [14.5, 22]].slice(0, n)
  .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.25" ${F("--flake")}/>`).join("");
const bolt = `<path d="M12.6 14.5 9.6 19.3h2.6l-1.3 3.7 4.3-5.6h-2.6l1.5-2.9z" ${F("--bolt")}/>`;
const fog = `<line x1="4" y1="17.5" x2="20" y2="17.5" ${S("--cloud", 1.9)}/><line x1="6" y1="21" x2="18" y2="21" ${S("--cloud", 1.9)}/>`;
function wxG(c, day = true) {
  const peek = day ? sunP(16.8, 6.4, 2.9) : moonP(17, 6.5, 4);   // sun/moon behind a shower cloud
  const hi = (tone = "--cloud") => cloudP(0, -4.5, 1, tone);      // cloud raised to leave room below
  if (c <= 1) return day ? sunP(12, 12, c === 0 ? 4.6 : 4.2) : moonP(11.5, 12, 7.5);
  if (c === 2) return (day ? sunP(8.4, 8.4, 3.4) : moonP(8.6, 8.4, 5.4)) + cloudP(3.4, 3.2, .85);
  if (c === 3) return cloudP(5, -1.5, .72, "--cloud-dark") + cloudP(0, 2, .9);
  if (c === 45 || c === 48) return cloudP(1.5, -5, .88) + fog;
  if (c >= 51 && c <= 55) return hi() + drops(c === 55 ? 3 : 2);
  if (c === 56 || c === 57 || c === 66 || c === 67) return hi() + drops(2) + `<circle cx="15.5" cy="20" r="1.25" ${F("--flake")}/>`;
  if (c === 61 || c === 63) return hi() + drops(c === 61 ? 3 : 4);
  if (c === 65) return hi("--cloud-dark") + drops(5);
  if (c >= 71 && c <= 77) return hi() + flakes(c === 71 ? 3 : 5);
  if (c >= 80 && c <= 82) return peek + cloudP(0, -3.5, .95, c === 82 ? "--cloud-dark" : "--cloud") + drops(c === 80 ? 2 : 4);
  if (c === 85 || c === 86) return peek + cloudP(0, -3.5, .95) + flakes(4);
  if (c >= 95) return hi("--cloud-dark") + bolt + drops(1);
  return cloudP(0, 1, 1);
}
const icon = (c, day = true) => `<svg class="wxi" viewBox="0 0 24 24" aria-hidden="true">${wxG(c, day)}</svg>`;
const label = c => (WMO[c] ?? [, , "—"])[2];

const level = (v, steps) => steps.find(s => v < s[0]) ?? steps[steps.length - 1];
const UV = [[3,"Low","var(--positive)"],[6,"Moderate","var(--warning)"],[8,"High","var(--secondary)"],[11,"Very high","var(--negative)"],[1e9,"Extreme","var(--cat-5)"]];
const AQI = [[20,"Good","var(--positive)"],[40,"Fair","var(--cat-12)"],[60,"Moderate","var(--warning)"],[80,"Poor","var(--secondary)"],[100,"Very poor","var(--negative)"],[1e9,"Extremely poor","var(--cat-5)"]];
const POLLEN = [[1,"None","var(--ink-muted)"],[20,"Low","var(--positive)"],[50,"Moderate","var(--warning)"],[150,"High","var(--secondary)"],[1e9,"Very high","var(--negative)"]];
const BEAUFORT = [[2,"Calm"],[6,"Light air"],[12,"Light breeze"],[20,"Gentle breeze"],[29,"Moderate breeze"],[39,"Fresh breeze"],
  [50,"Strong breeze"],[62,"Near gale"],[75,"Gale"],[89,"Strong gale"],[103,"Storm"],[1e9,"Violent storm"]];

// ---------- theme: light by day, dark after sunset ----------
function applyTheme() {
  const h = new Date().getHours();
  const dark = THEME ? THEME === "dark" : WX ? !WX.current.is_day : (h < 7 || h >= 19);
  const t = dark ? "dark" : "light";
  if (document.documentElement.dataset.theme === t) return false;
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0a0a0d" : "#eef0f4";
  radar?.setTheme(dark); bigRadar?.setTheme(dark);
  return true;
}

// ---------- clock ----------
function tickClock() {
  const d = new Date();
  const h = d.getHours() % 12 || 12, m = String(d.getMinutes()).padStart(2, "0"), s = String(d.getSeconds()).padStart(2, "0");
  $("clock").innerHTML = `${h}:${m}<span class="sec">:${s}</span><span class="ampm">${d.getHours() < 12 ? "am" : "pm"}</span>`;
  $("date").textContent = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}
setInterval(tickClock, 1000); tickClock();

// ---------- location ----------
function setPlace(name) { PLACE = name; store.set("wx.place", name); $("place").textContent = name + (LOC.approx ? " (approx)" : ""); }
async function lookupPlace() {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${LOC.lat}&lon=${LOC.lon}`);
    const a = (await r.json()).address || {};
    setPlace(a.suburb || a.neighbourhood || a.quarter || a.city_district || a.town || a.city || PLACE);
  } catch { setPlace(PLACE); }
}
function locate(force = false) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(p => {
    const next = { lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5), acc: Math.round(p.coords.accuracy) };
    const moved = LOC.approx || metres(LOC, next) > 300;
    LOC = next; store.set("wx.loc", LOC);
    if (moved || force) { lookupPlace(); loadWeather(); loadAir(); loadStations(); radar?.recentre(); }
  }, () => { setPlace(PLACE); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: force ? 0 : 10 * 60e3 });
}
$("place").addEventListener("click", () => { $("place").textContent = "Locating…"; locate(true); });

// ---------- weather ----------
async function loadWeather() {
  const q = new URLSearchParams({
    latitude: LOC.lat, longitude: LOC.lon, timezone: "auto", timeformat: "unixtime",
    past_days: 1, forecast_days: 10, past_minutely_15: 1, forecast_minutely_15: 13,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,is_day,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,visibility,uv_index",
    minutely_15: "precipitation,weather_code",
    hourly: "temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,is_day,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index,cloud_cover,relative_humidity_2m,dew_point_2m,pressure_msl,visibility",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,daylight_duration,sunshine_duration,uv_index_max,precipitation_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant",
  });
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
    if (!r.ok) throw new Error(r.status);
    WX = await r.json(); wxAt = Date.now(); TZ = WX.timezone;
    store.set("wx.cache", WX);
    renderWeather();
  } catch {
    $("stamp").textContent = wxAt ? `Offline · last ${hm(wxAt / 1000)}` : "Can't reach forecast";
  }
}
async function loadAir() {
  const q = new URLSearchParams({
    latitude: LOC.lat, longitude: LOC.lon, timezone: "auto", timeformat: "unixtime", forecast_days: 2,
    current: "european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide,grass_pollen,birch_pollen,alder_pollen,mugwort_pollen,ragweed_pollen",
    hourly: "european_aqi,pm2_5,nitrogen_dioxide,ozone",
  });
  try {
    const r = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`);
    if (r.ok) { AQ = await r.json(); if (WX) { renderSummary(); renderTiles(); } }
  } catch {}
}

// Index helpers over the hourly / daily arrays.
const nowSec = () => Date.now() / 1000;
function hourIdx() { const t = WX.hourly.time, n = nowSec(); let i = t.findIndex(x => x > n) - 1; return Math.max(0, i < 0 ? t.length - 1 : i); }
function todayIdx() { const k = dayKey(nowSec()); return Math.max(0, WX.daily.time.findIndex(t => dayKey(t + 43200) === k)); }
const H = (k, i) => WX.hourly[k]?.[i];
const D = (k, i) => WX.daily[k]?.[i];

function renderWeather() {
  if (!WX) return;
  applyTheme();
  const c = WX.current, ti = todayIdx();
  $("nowIcon").innerHTML = icon(c.weather_code, c.is_day);
  $("nowTemp").textContent = deg(c.temperature_2m);
  $("nowCond").textContent = label(c.weather_code);
  $("nowFeels").textContent = `Feels like ${deg(c.apparent_temperature)}`;
  $("nowHi").textContent = `H ${deg(D("temperature_2m_max", ti))}`;
  $("nowLo").textContent = `L ${deg(D("temperature_2m_min", ti))}`;
  $("stamp").textContent = `Updated ${hm(wxAt / 1000)}`;
  hourSel = 0;
  renderSummary(); renderNowcast(); renderHourly(); renderDays(); renderTiles();
}

// "Dry until 9 pm", "Rain from 3:15 pm", "Rain easing around 4 pm" — from the
// 15-minute series for the next 3 h, then the hourly one out to 24 h.
function rainStory() {
  const m = WX.minutely_15, n = nowSec();
  const slots = m.time.map((t, i) => ({ t, mm: m.precipitation[i] ?? 0 })).filter(s => s.t + 900 > n);
  const wet = s => s.mm >= 0.1;
  const hi0 = hourIdx();
  const hours = WX.hourly.time.slice(hi0 + 1, hi0 + 25).map((t, k) => ({
    t, mm: H("precipitation", hi0 + 1 + k) ?? 0, p: H("precipitation_probability", hi0 + 1 + k) ?? 0 }));
  const wetH = h => h.mm >= 0.2 || h.p >= 60;
  if (slots.length && wet(slots[0])) {
    const stop = slots.findIndex((s, i) => i > 0 && !wet(s) && (!slots[i + 1] || !wet(slots[i + 1])));
    if (stop > 0) return { text: `Rain now, easing around ${hm(slots[stop].t)}`, short: `Easing ${hm(slots[stop].t)}`, wet: true };
    const h = hours.find(h => !wetH(h));
    return { text: h ? `Rain now, likely until about ${hr(h.t)}` : "Rain on and off all day", short: h ? `Raining till ${hr(h.t)}` : "Raining", wet: true };
  }
  const start = slots.find(wet);
  if (start) return { text: `Rain from about ${hm(start.t)}`, short: `Rain at ${hm(start.t)}`, wet: true };
  const h = hours.find(wetH);
  if (h) return { text: `Dry until about ${hr(h.t)}`, short: `Dry till ${hr(h.t)}`, wet: false };
  return { text: "Dry for the next 24 hours", short: "Dry all day", wet: false };
}

function renderSummary() {
  const c = WX.current, ti = todayIdx(), n = nowSec();
  const rise = D("sunrise", ti), set = D("sunset", ti), riseT = D("sunrise", ti + 1);
  const sun = n < rise ? ["Sunrise", rise, "wb_twilight"] : n < set ? ["Sunset", set, "wb_twilight"] : ["Sunrise", riseT, "wb_twilight"];
  const left = sun[1] - n;
  const dl = D("daylight_duration", ti), dlY = D("daylight_duration", ti - 1);
  const dlDelta = dlY ? Math.round((dl - dlY) / 60) : null;
  const story = rainStory();
  const aqi = AQ?.current?.european_aqi;
  const aq = aqi != null ? level(aqi, AQI) : null;
  const chips = [
    ["sun", ms(sun[2], "ic-sun"), sun[0], hm(sun[1]), `in ${dur(left)} · day ${dur(dl)}${dlDelta != null ? ` ${dlDelta >= 0 ? "+" : "−"}${Math.abs(dlDelta)}m` : ""}`],
    ["rain", ms("umbrella", "ic-rain"), "Rain", story.short, `${(D("precipitation_sum", ti) ?? 0).toFixed(1)} mm today · ${r0(D("precipitation_probability_max", ti))}% chance`],
    ["wind", ms("air", "ic-cloud"), "Wind", `${r0(c.wind_speed_10m)} km/h ${compass(c.wind_direction_10m)}`, `Gusts ${r0(c.wind_gusts_10m)} · ${level(c.wind_speed_10m, BEAUFORT)[1].toLowerCase()}`],
    ["aqi", ms("eco", "") , "Air quality", aq ? `<span style="color:${aq[2]}">${aq[1]}</span>` : "–", aq ? `EAQI ${r0(aqi)} · PM2.5 ${r0(AQ.current.pm2_5)}` : "Loading…"],
  ];
  $("summary").innerHTML = chips.map(([k, ic, a, v, s]) =>
    `<button class="chip" data-m="${k}">${k === "aqi" && aq ? ic.replace('class="ms "', `class="ms" style="color:${aq[2]}"`) : ic}` +
    `<span class="txt"><span class="k">${a}</span><span class="v">${v}</span><span class="s">${esc(s)}</span></span></button>`).join("");
  $("rainSub").textContent = story.text;
}

function renderNowcast() {
  const m = WX.minutely_15, n = nowSec();
  const slots = m.time.map((t, i) => ({ t, mm: m.precipitation[i] ?? 0 })).filter(s => s.t + 900 > n).slice(0, 12);
  // Only worth the space when rain is actually due in the next 3 hours; otherwise
  // the rain outlook rides along as a note on the 24-hour heading.
  const wet = slots.some(s => s.mm >= 0.05);
  const changed = $("rainBlock").hidden === wet;
  $("rainBlock").hidden = !wet;
  // After dark the map only earns its space if rain is coming: the radar is empty
  // otherwise and satellite cloud can't see low cloud at night.
  const hideMap = !WX.current.is_day && !wet;
  if (document.body.classList.contains("nomap") !== hideMap) {
    document.body.classList.toggle("nomap", hideMap);
    requestAnimationFrame(() => { renderHourly(); if (!hideMap) radar?.map.invalidateSize(); });   // the grid just changed shape
  }
  if (changed) requestAnimationFrame(renderHourly);   // the chart just gained or lost height
  $("dryNote").textContent = wet ? "" : rainStory().text;
  if (!wet) { $("nowcast").innerHTML = ""; return; }
  const max = Math.max(0.5, ...slots.map(s => s.mm));
  $("nowcast").innerHTML = slots.map((s, i) =>
    `<div class="nc" title="${hm(s.t)} · ${s.mm.toFixed(1)} mm"><i class="${s.mm < 0.05 ? "dry" : ""}" style="height:${Math.max(4, (s.mm / max) * 46)}px"></i>` +
    `<span>${i === 0 ? "Now" : i % 4 === 0 ? hm(s.t) : ""}</span></div>`).join("");
}

// ---------- SVG charts ----------
// One renderer for the hourly strip and every sheet chart. Lines share a y-scale
// unless they bring their own min/max; bars sit in the lower 40%. Colours are
// token names, resolved now so a theme flip just needs a redraw.
function svgChart(el, o) {
  const W = el.clientWidth, Hh = el.clientHeight;
  if (W < 60 || Hh < 50) return;   // mid-layout; the resize handler redraws
  const n = o.t.length, padL = 4, padR = 4, top = o.icons || o.arrows ? 28 : 8, bot = 18;
  const step = (W - padL - padR) / n, x = i => padL + (i + .5) * step;
  const every = px => Math.max(1, Math.ceil(px / step));
  const plotTop = top + 18, plotBot = Hh - bot - 4;
  // Lines with no fixed range share one scale; a line that fixes only its floor
  // (visibility, AQI: min 0) still scales its ceiling to its own data.
  const shared = o.lines.filter(l => l.min == null && l.max == null).flatMap(l => l.v).filter(v => v != null);
  const sMin = Math.min(...shared), sMax = Math.max(...shared);
  const pad = (sMax - sMin) * .15 || 1;
  const own = l => { const v = l.v.filter(x => x != null); return Math.max(...v) * 1.12 || 1; };
  const yOf = l => {
    const lo = l.min ?? sMin - pad, hi = l.max ?? (l.min != null ? own(l) : sMax + pad);
    return v => plotBot - ((v - lo) / (hi - lo || 1)) * (plotBot - plotTop);
  };
  const ink = V("--ink"), surface = V("--surface-1");
  let s = `<svg viewBox="0 0 ${W} ${Hh}" xmlns="http://www.w3.org/2000/svg">`;
  if (o.night) { const band = V("--night-band"); o.night.forEach((d, i) => { if (!d) s += `<rect x="${x(i) - step / 2}" y="${top}" width="${step + .5}" height="${Math.max(0, plotBot - top)}" fill="${band}"/>`; }); }
  if (o.bars) {
    const col = V(o.bars.color);
    const bh = (plotBot - plotTop) * (o.bars.full ? 1 : .4), bm = Math.max(o.bars.max ?? 0, ...o.bars.v.map(v => v ?? 0)) || 1;
    o.bars.v.forEach((v, i) => {
      if (!v) return;
      const h = Math.max(2, (v / bm) * bh);
      s += `<rect x="${x(i) - step * .3}" y="${plotBot - h}" width="${step * .6}" height="${h}" rx="3" fill="${col}" opacity="${o.bars.opacity ?? .45}"/>`;
      if (o.bars.labels && v >= 0.1 && i % every(30) === 0) s += `<text x="${x(i)}" y="${plotBot - h - 4}" text-anchor="middle" fill="${col}">${o.bars.fmt(v)}</text>`;
    });
  }
  for (const l of o.lines) {
    const y = yOf(l), col = V(l.color);
    const pts = l.v.map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean);
    if (pts.length < 2) continue;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
    if (l.fill) s += `<path d="${d}L${pts.at(-1)[0]},${plotBot}L${pts[0][0]},${plotBot}Z" fill="${col}" opacity=".12"/>`;
    s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${l.w ?? 2.5}" ${l.dash ? `stroke-dasharray="${l.dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
    if (l.labels) l.v.forEach((v, i) => {
      if (v == null || (i % every(34) !== 0 && i !== o.sel)) return;
      s += `<text class="tl" x="${x(i)}" y="${y(v) - 8}" text-anchor="middle">${l.fmt(v)}</text>`;
    });
  }
  if (o.icons) o.icons.forEach(([c, d], i) => {
    if (i % every(28) === 0) s += `<g transform="translate(${(x(i) - 11).toFixed(1)} 2) scale(.92)">${wxG(c, d)}</g>`;
  });
  if (o.arrows) { const col = V("--ink-muted"); o.arrows.forEach((a, i) => {
    if (a == null || i % every(26) !== 0) return;
    // Arrow points where the wind is blowing *to* (met direction + 180°).
    s += `<g transform="translate(${x(i)},14) rotate(${a + 180})"><path d="M0,-8 L5.5,6 L0,3 L-5.5,6Z" fill="${col}"/></g>`;
  }); }
  o.t.forEach((t, i) => { if (i % every(46) === 0) s += `<text x="${x(i)}" y="${Hh - 4}" text-anchor="middle">${i === 0 && o.nowFirst ? "Now" : hr(t)}</text>`; });
  if (o.sel != null && o.sel >= 0) {
    s += `<line x1="${x(o.sel)}" x2="${x(o.sel)}" y1="${top}" y2="${plotBot}" stroke="${ink}" stroke-opacity=".3" stroke-dasharray="3 3"/>`;
    for (const l of o.lines) { const v = l.v[o.sel]; if (v != null) s += `<circle cx="${x(o.sel)}" cy="${yOf(l)(v)}" r="5" fill="${V(l.color)}" stroke="${surface}" stroke-width="2.5"/>`; }
  }
  el.innerHTML = s + "</svg>";
  if (o.onPick) {
    const pick = e => { const r = el.getBoundingClientRect(); o.onPick(Math.min(n - 1, Math.max(0, Math.floor((e.clientX - r.left - padL) / step)))); };
    el.onpointerdown = e => { el.setPointerCapture?.(e.pointerId); pick(e); };
    el.onpointermove = e => { if (e.buttons) pick(e); };
  }
}

// Chart config for a window of hourly data in one of the three modes.
function hourlyChart(from, n, mode, sel, onPick, nowFirst = false) {
  const sl = k => WX.hourly[k].slice(from, from + n);
  const t = sl("time"), day = sl("is_day");
  const base = { t, sel, onPick, night: day, nowFirst };
  const icons = sl("weather_code").map((c, i) => [c, day[i]]);
  if (mode === "rain") return { ...base, icons,
    bars: { v: sl("precipitation"), max: 1, color: "--rain", opacity: .8, full: true, labels: true, fmt: v => v.toFixed(1) },
    lines: [{ v: sl("precipitation_probability"), min: 0, max: 100, color: "--lo", w: 2, dash: "4 4", labels: true, fmt: v => `${r0(v)}%` }] };
  if (mode === "wind") return { ...base, arrows: sl("wind_direction_10m"),
    lines: [{ v: sl("wind_gusts_10m"), color: "--ink-faint", w: 2, dash: "4 4", fill: true },
            { v: sl("wind_speed_10m"), color: "--positive", labels: true, fmt: v => r0(v) }] };
  return { ...base, icons,
    bars: { v: sl("precipitation"), max: 2, color: "--rain" },
    lines: [{ v: sl("apparent_temperature"), color: "--ink-faint", w: 2, dash: "4 4" },
            { v: sl("temperature_2m"), color: "--hi", labels: true, fmt: v => `${r0(v)}°`, fill: true }] };
}

function hourText(i) {
  const c = H("weather_code", i), d = H("is_day", i);
  return `<b>${hm(H("time", i))}</b> · ${icon(c, d)} ${label(c)} · <b>${deg(H("temperature_2m", i))}</b> feels ${deg(H("apparent_temperature", i))}` +
    ` · ${ms("umbrella", "ic-rain")} ${r0(H("precipitation_probability", i))}% ${(H("precipitation", i) ?? 0).toFixed(1)} mm` +
    ` · ${ms("air", "ic-cloud")} ${r0(H("wind_speed_10m", i))} km/h ${compass(H("wind_direction_10m", i))}, gusts ${r0(H("wind_gusts_10m", i))}` +
    ` · UV ${r0(H("uv_index", i))} · ${ms("humidity_percentage", "ic-rain")} ${r0(H("relative_humidity_2m", i))}%`;
}

function renderHourly() {
  if (!WX) return;
  const from = hourIdx();
  svgChart($("hourChart"), hourlyChart(from, 24, hourMode, hourSel, i => { hourSel = i; renderHourly(); }, true));
  $("hourDetail").innerHTML = hourText(from + hourSel);
}
for (const b of $("hourSeg").querySelectorAll("button")) b.addEventListener("click", () => {
  hourMode = b.dataset.k;
  for (const x of $("hourSeg").querySelectorAll("button")) x.classList.toggle("on", x === b);
  renderHourly();
});

// ---------- days ----------
// The iPad grid has room for 7 comfortable rows; the "10 days" button opens the rest.
// Phone layouts scroll, so they list all 10.
const fewDays = () => matchMedia("(min-height: 641px) and (min-width: 701px)").matches;
let dayMode = "temp";
function daysHTML(n) {
  const ti = todayIdx(), idx = WX.daily.time.map((_, i) => i).filter(i => i >= ti).slice(0, n);
  const lo = Math.min(...idx.map(i => D("temperature_2m_min", i))), hi = Math.max(...idx.map(i => D("temperature_2m_max", i)));
  const pct = v => ((v - lo) / (hi - lo || 1)) * 100;
  const mmMax = Math.max(2, ...idx.map(i => D("precipitation_sum", i) ?? 0));
  return idx.map(i => {
    const p = D("precipitation_probability_max", i) ?? 0;
    const head = `<span class="dn">${i === ti ? "Today" : wd(D("time", i) + 43200)}</span>
      <span class="de">${icon(D("weather_code", i))}</span>
      <span class="dp${p < 10 && dayMode === "temp" ? " z" : ""}">${p}%</span>`;
    if (dayMode === "rain") {
      // Bar length is the day's total against the wettest day shown; shade is the chance.
      const mm = D("precipitation_sum", i) ?? 0, h = D("precipitation_hours", i) ?? 0;
      return `<button class="day rain${i === ti ? " today" : ""}" data-i="${i}">${head}
        <span class="bar wet"><i style="left:0;right:${100 - Math.min(100, (mm / mmMax) * 100)}%;opacity:${(.35 + .65 * p / 100).toFixed(2)}"></i></span>
        <span class="lo">${mm >= 0.05 ? `${mm < 10 ? mm.toFixed(1) : r0(mm)}<small>mm</small>` : "–"}</span><span class="hi">${h ? `${r0(h)}<small>h</small>` : ""}</span></button>`;
    }
    const mn = D("temperature_2m_min", i), mx = D("temperature_2m_max", i);
    const now = i === ti ? `<b style="left:${pct(WX.current.temperature_2m)}%"></b>` : "";
    return `<button class="day${i === ti ? " today" : ""}" data-i="${i}">${head}
      <span class="bar"><i style="left:${pct(mn)}%;right:${100 - pct(mx)}%"></i>${now}</span>
      <span class="lo">${deg(mn)}</span><span class="hi">${deg(mx)}</span></button>`;
  }).join("");
}
function renderDays() {
  const n = fewDays() ? 7 : 10;
  $("daysTitle").textContent = `Next ${n} days`;
  $("daysMore").hidden = n === 10;
  $("days").innerHTML = daysHTML(n);
}
$("days").addEventListener("click", e => { const b = e.target.closest(".day"); if (b) dayModal(+b.dataset.i); });
for (const b of $("daySeg").querySelectorAll("button")) b.addEventListener("click", () => {
  dayMode = b.dataset.k;
  for (const x of $("daySeg").querySelectorAll("button")) x.classList.toggle("on", x === b);
  renderDays();
});
$("daysMore").addEventListener("click", () => {
  if (!WX) return;
  openModal(`<h3>${ms("calendar_month")}Next 10 days</h3><p class="lede">Tap a day for hour by hour.</p><div class="daylist sheetdays" id="allDays">${daysHTML(10)}</div>`);
  $("allDays").addEventListener("click", e => { const b = e.target.closest(".day"); if (b) dayModal(+b.dataset.i); });
});

// ---------- detail tiles ----------
function moon(date = new Date()) {
  const synodic = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14) / 864e5;
  const age = (((date / 864e5 - ref) % synodic) + synodic) % synodic, f = age / synodic;
  const names = ["New moon","Waxing crescent","First quarter","Waxing gibbous","Full moon","Waning gibbous","Last quarter","Waning crescent"];
  const toFull = ((synodic / 2 - age) + synodic) % synodic;
  const toNew = synodic - age;
  return { f, name: names[Math.round(f * 8) % 8], next: new Date(+date + toNew * 864e5),
    lit: Math.round((1 - Math.cos(2 * Math.PI * f)) / 2 * 100), full: new Date(+date + toFull * 864e5) };
}
// The lit part of the disc: an outer half-circle on the sunward side closed by
// the terminator, an ellipse whose x-radius is r·|cos 2πf|.
function moonSvg(f, size = 24) {
  const r = 10, rx = (r * Math.abs(Math.cos(2 * Math.PI * f))).toFixed(2);
  const waxing = f < .5, crescent = f < .25 || f > .75;
  const outer = waxing ? 1 : 0, inner = waxing ? (crescent ? 0 : 1) : (crescent ? 1 : 0);
  return `<svg class="moonsvg" viewBox="-12 -12 24 24" width="${size}" height="${size}"><circle r="${r}" fill="var(--surface-3)"/>` +
    `<path d="M0,${-r} A${r},${r} 0 0 ${outer} 0,${r} A${rx},${r} 0 0 ${inner} 0,${-r}Z" fill="var(--sun)"/></svg>`;
}
function pressureTrend() {
  const i = hourIdx(), a = H("pressure_msl", i), b = H("pressure_msl", i - 3);
  if (a == null || b == null) return "";
  const d = a - b;
  return Math.abs(d) < 1 ? "Steady" : d > 0 ? `Rising ${d.toFixed(1)} in 3h` : `Falling ${(-d).toFixed(1)} in 3h`;
}
function renderTiles() {
  const c = WX.current, ti = todayIdx(), hi = hourIdx(), m = moon();
  const uvNow = c.uv_index ?? H("uv_index", hi) ?? 0, uv = level(uvNow, UV), uvMax = D("uv_index_max", ti) ?? 0;
  const pol = AQ?.current ? Object.entries(AQ.current).filter(([k]) => k.endsWith("_pollen")) : [];
  const worst = pol.filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];
  const pl = worst ? level(worst[1], POLLEN) : null;
  const vis = c.visibility ?? H("visibility", hi);
  const tiles = [
    ["feels", "thermostat", "Feels like", deg(c.apparent_temperature), c.apparent_temperature < c.temperature_2m - 1.5 ? "Wind chill" : c.apparent_temperature > c.temperature_2m + 1.5 ? "Humid" : "Similar to actual"],
    ["humidity", "humidity_percentage", "Humidity", `${r0(c.relative_humidity_2m)}<small>%</small>`, `Dew point ${deg(c.dew_point_2m)}`],
    ["pressure", "compress", "Pressure", `${r0(c.pressure_msl)}<small>hPa</small>`, pressureTrend()],
    ["uv", "light_mode", "UV index", `<span style="color:${uv[2]}">${r0(uvNow)}</span><small>${uv[1]}</small>`, `Max today ${uvMax.toFixed(0)} · ${level(uvMax, UV)[1]}`],
    ["cloud", "cloud", "Cloud cover", `${r0(c.cloud_cover)}<small>%</small>`, `${dur(D("sunshine_duration", ti) ?? 0)} sunshine today`],
    ["visibility", "visibility", "Visibility", vis == null ? "–" : vis >= 10000 ? `${r0(vis / 1000)}<small>km</small>` : `${(vis / 1000).toFixed(1)}<small>km</small>`, vis == null ? "" : vis < 1000 ? "Fog" : vis < 5000 ? "Hazy" : "Clear"],
    ["gusts", "air", "Gusts", `${r0(c.wind_gusts_10m)}<small>km/h</small>`, `Max today ${r0(D("wind_gusts_10m_max", ti))} km/h`],
    ["pollen", "local_florist", "Pollen", pl ? `<span style="color:${pl[2]}">${pl[1]}</span>` : "–", worst && worst[1] >= 1 ? `${worst[0].replace("_pollen", "")} ${r0(worst[1])}/m³` : "Out of season"],
    ["moon", "bedtime", "Moon", `${moonSvg(m.f)}${m.lit}<small>%</small>`, m.name],
  ];
  $("tiles").innerHTML = tiles.map(([k, ic, t, v, s]) =>
    `<button class="tile" data-m="${k}"><span class="k">${ms(ic)}${t}</span><span class="v">${v}</span><span class="s">${esc(s)}</span></button>`).join("");
}
document.addEventListener("click", e => { const b = e.target.closest("[data-m]"); if (b && WX) metricModal(b.dataset.m); });
$("nowBtn").addEventListener("click", () => WX && dayModal(todayIdx()));

// ---------- sheets ----------
let modalTimer, modalCleanup = null;
function openModal(html, { wide = false } = {}) {
  $("modalBody").innerHTML = html;
  $("modal").querySelector(".sheet").classList.toggle("wide", wide);
  $("modal").hidden = false;
  clearTimeout(modalTimer); modalTimer = setTimeout(closeModal, 3 * 60e3);   // kiosk drifts back to the board
}
function closeModal() {
  $("modal").hidden = true; clearTimeout(modalTimer);
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
}
$("modalClose").addEventListener("click", closeModal);
$("modal").addEventListener("click", e => { if (e.target === $("modal")) closeModal(); });

function dayModal(i) {
  const start = WX.hourly.time.findIndex(t => dayKey(t) === dayKey(D("time", i) + 43200));
  const isToday = i === todayIdx();
  const from = isToday ? hourIdx() : Math.max(0, start), n = 24;
  let mode = "temp", sel = 0;
  const kv = [
    ["High / low", `${deg(D("temperature_2m_max", i))} / ${deg(D("temperature_2m_min", i))}`],
    ["Feels like", `${deg(D("apparent_temperature_max", i))} / ${deg(D("apparent_temperature_min", i))}`],
    ["Rain", `${(D("precipitation_sum", i) ?? 0).toFixed(1)} mm · ${r0(D("precipitation_probability_max", i))}%`],
    ["Rain hours", `${r0(D("precipitation_hours", i))} h`],
    ["Wind", `${r0(D("wind_speed_10m_max", i))} km/h ${compass(D("wind_direction_10m_dominant", i) ?? 0)}`],
    ["Gusts", `${r0(D("wind_gusts_10m_max", i))} km/h`],
    ["UV max", `${(D("uv_index_max", i) ?? 0).toFixed(0)} · ${level(D("uv_index_max", i) ?? 0, UV)[1]}`],
    ["Sunshine", dur(D("sunshine_duration", i) ?? 0)],
    ["Sunrise", hm(D("sunrise", i))], ["Sunset", hm(D("sunset", i))],
    ["Daylight", dur(D("daylight_duration", i) ?? 0)],
    ["Golden hour", `from ${hm(D("sunset", i) - 3600)}`],
  ];
  openModal(`<h3>${icon(D("weather_code", i))}${isToday ? "Today" : fmt(D("time", i) + 43200, { weekday: "long", day: "numeric", month: "long" })} · ${label(D("weather_code", i))}</h3>
    <p class="lede">${isToday ? "Next 24 hours" : "Hour by hour"}. Tap the chart for any hour.</p>
    <div class="seg" id="mSeg"><button data-k="temp" class="on">Temp</button><button data-k="rain">Rain</button><button data-k="wind">Wind</button></div>
    <div class="bigchart" id="mChart"></div><div class="hourdetail" id="mDetail"></div>
    <div class="kv">${kv.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>`);
  const draw = () => {
    svgChart($("mChart"), hourlyChart(from, n, mode, sel, j => { sel = j; draw(); }, isToday));
    $("mDetail").innerHTML = hourText(from + sel);
  };
  for (const b of $("mSeg").querySelectorAll("button")) b.addEventListener("click", () => {
    mode = b.dataset.k; for (const x of $("mSeg").querySelectorAll("button")) x.classList.toggle("on", x === b); draw();
  });
  draw();
}

// ---------- sun ----------
function sunLede(ti) {
  const n = nowSec(), rise = D("sunrise", ti), set = D("sunset", ti);
  const dl = D("daylight_duration", ti), d = Math.round((dl - (D("daylight_duration", ti - 1) ?? dl)) / 60);
  const left = n < rise ? `Sunrise in ${dur(rise - n)}` : n < set ? `${dur(set - n)} of daylight left` : `Sunrise tomorrow ${hm(D("sunrise", ti + 1))}`;
  return `${left} · ${dur(dl)} of daylight today, ${d >= 0 ? d + " min longer" : -d + " min shorter"} than yesterday`;
}
// Today's sun path: a cosine over the 24 h, shifted so it crosses the horizon at
// sunrise and sunset; filled above the horizon, the sun dot at the current time.
function drawSunArc(el, ti) {
  const W = el.clientWidth, Hh = el.clientHeight; if (!W || !Hh) return;
  const t0 = D("time", ti), day = 86400, rise = D("sunrise", ti), set = D("sunset", ti), noon = (rise + set) / 2;
  const base = Math.cos(Math.PI * (set - noon) / (day / 2));
  const elev = t => Math.cos(Math.PI * (t - noon) / (day / 2)) - base;
  const top = 34, h = Hh - top - 30;   // room for the noon label above, rise/set labels below
  const peak = 1 - base, trough = -1 - base, hz = top + h * peak / (peak - trough);
  const X = t => 10 + ((t - t0) / day) * (W - 20), Y = t => hz - elev(t) / (peak - trough) * h;
  const pts = []; for (let t = t0; t <= t0 + day; t += 600) pts.push(`${X(t).toFixed(1)},${Y(t).toFixed(1)}`);
  const lit = []; for (let t = rise; t <= set; t += 300) lit.push(`${X(t).toFixed(1)},${Y(t).toFixed(1)}`);
  const sun = V("--sun"), ink = V("--ink-muted"), faint = V("--ink-faint"), sep = V("--separator"), n = nowSec();
  let s = `<svg viewBox="0 0 ${W} ${Hh}" xmlns="http://www.w3.org/2000/svg">`;
  s += `<polygon points="${X(rise)},${hz} ${lit.join(" ")} ${X(set)},${hz}" fill="${sun}" opacity=".18"/>`;
  s += `<polyline points="${pts.join(" ")}" fill="none" stroke="${faint}" stroke-width="2" stroke-dasharray="3 4"/>`;
  s += `<polyline points="${lit.join(" ")}" fill="none" stroke="${sun}" stroke-width="3" stroke-linecap="round"/>`;
  s += `<line x1="10" x2="${W - 10}" y1="${hz}" y2="${hz}" stroke="${sep}" stroke-width="1.5"/>`;
  for (const [t, lab, anchor] of [[rise, `Sunrise ${hm(rise)}`, "middle"], [noon, `Solar noon ${hm(noon)}`, "middle"], [set, `Sunset ${hm(set)}`, "middle"]])
    s += `<text x="${X(t)}" y="${t === noon ? Y(t) - 12 : hz + 20}" text-anchor="${anchor}" fill="${ink}">${lab}</text>`;
  if (n >= t0 && n <= t0 + day) s += `<circle cx="${X(n)}" cy="${Y(n)}" r="9" fill="${n > rise && n < set ? sun : V("--night")}" stroke="${V("--surface-1")}" stroke-width="3"/>`;
  el.innerHTML = s + "</svg>";
}
// One row per day: a 24-hour track with the daylight span drawn on it.
function daylightRow(i, ti) {
  const t0 = D("time", i), rise = D("sunrise", i), set = D("sunset", i), pc = t => ((t - t0) / 86400 * 100).toFixed(2);
  const dl = D("daylight_duration", i), d = Math.round((dl - (D("daylight_duration", i - 1) ?? dl)) / 60);
  const now = i === ti ? `<b class="nowmark" style="left:${pc(nowSec())}%"></b>` : "";
  return `<div class="dlrow${i === ti ? " today" : ""}"><span class="dn">${i === ti ? "Today" : wd(t0 + 43200)}</span>
    <span class="rt">${hm(rise)}</span>
    <span class="track"><i style="left:${pc(rise)}%;right:${100 - pc(set)}%"></i>${now}</span>
    <span class="st">${hm(set)}</span>
    <span class="len">${dur(dl)}<small>${d >= 0 ? "+" : "−"}${Math.abs(d)}m</small></span></div>`;
}

// One sheet per tile/chip: a 48-hour chart of that variable plus a sentence.
function metricModal(k) {
  const from = hourIdx(), n = 48, sl = key => WX.hourly[key].slice(from, from + n), t = sl("time");
  const ti = todayIdx();
  const simple = (title, ic, lede, lines, more = {}) => {
    openModal(`<h3>${ms(ic)}${title}</h3><p class="lede">${lede}</p><div class="bigchart" id="mChart"></div><div class="hourdetail" id="mDetail"></div>`);
    let sel = 0;
    const draw = () => {
      svgChart($("mChart"), { t, lines, sel, night: sl("is_day"), nowFirst: true, onPick: j => { sel = j; draw(); }, ...more });
      $("mDetail").innerHTML = hourText(from + sel);
    };
    draw();
  };
  const L = (key, color, f, o = {}) => ({ v: sl(key), color, labels: true, fmt: f, fill: true, ...o });
  const c = WX.current;
  if (k === "rain") return dayModal(ti);
  if (k === "feels") return simple("Feels like", "thermostat", `Actual ${deg(c.temperature_2m)}, feels ${deg(c.apparent_temperature)} with wind and humidity.`,
    [{ v: sl("temperature_2m"), color: "--ink-faint", w: 2, dash: "4 4" }, L("apparent_temperature", "--hi", v => `${r0(v)}°`)]);
  if (k === "humidity") return simple("Humidity", "humidity_percentage", `${r0(c.relative_humidity_2m)}% now. Dew point ${deg(c.dew_point_2m)}; above about 16° feels muggy.`,
    [L("relative_humidity_2m", "--rain", v => `${r0(v)}%`, { min: 0, max: 100 })]);
  if (k === "pressure") return simple("Pressure", "compress", `${r0(c.pressure_msl)} hPa, ${pressureTrend().toLowerCase() || "steady"}. Falling pressure usually means unsettled weather is on the way.`,
    [L("pressure_msl", "--trip", v => r0(v), { fill: false })]);
  if (k === "uv") return simple("UV index", "light_mode", `Peaks at ${(D("uv_index_max", ti) ?? 0).toFixed(0)} today. Sun protection from 3 upwards.`,
    [L("uv_index", "--warning", v => v.toFixed(0), { min: 0, max: Math.max(4, ...sl("uv_index").filter(x => x != null)) })]);
  if (k === "cloud") return simple("Cloud cover", "cloud", `${r0(c.cloud_cover)}% now · ${dur(D("sunshine_duration", ti) ?? 0)} of sunshine expected today.`,
    [L("cloud_cover", "--ink-muted", v => `${r0(v)}%`, { min: 0, max: 100 })]);
  if (k === "visibility") return simple("Visibility", "visibility", "Kilometres. Under 1 km is fog.",
    [L("visibility", "--lo", v => r0(v / 1000), { min: 0 })]);
  if (k === "gusts" || k === "wind") return simple("Wind", "air", `${r0(c.wind_speed_10m)} km/h from the ${compass(c.wind_direction_10m)}, gusting ${r0(c.wind_gusts_10m)}. Arrows point where it's blowing.`,
    [{ v: sl("wind_gusts_10m"), color: "--ink-faint", w: 2, dash: "4 4", fill: true }, L("wind_speed_10m", "--positive", v => r0(v), { fill: false })],
    { arrows: sl("wind_direction_10m") });
  if (k === "sun" || k === "moon") {
    const days = WX.daily.time.map((_, i) => i).filter(i => i >= ti).slice(0, 10), m = moon();
    openModal(`<h3>${ms("wb_twilight", "ic-sun")}Sun & moon</h3>
      <p class="lede">${sunLede(ti)}</p>
      <div class="sunarc" id="sunArc"></div>
      <div class="daylight">${days.map(i => daylightRow(i, ti)).join("")}</div>
      <div class="moonrow">${moonSvg(m.f, 64)}<div><b>${m.name}</b><span>${m.lit}% lit</span>
        <span>Full moon ${m.full.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · new moon ${m.next.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</span></div></div>`);
    drawSunArc($("sunArc"), ti);
    return;
  }
  if (k === "aqi" || k === "pollen") {
    if (!AQ) return;
    const a = AQ.current, at = AQ.hourly.time, ai = Math.max(0, at.findIndex(x => x > nowSec()) - 1);
    const pol = Object.entries(a).filter(([x]) => x.endsWith("_pollen"));
    openModal(`<h3>${ms("eco")}Air quality & pollen</h3><p class="lede">European AQI ${r0(a.european_aqi)}, ${level(a.european_aqi ?? 0, AQI)[1].toLowerCase()}. Source: CAMS via Open-Meteo.</p>
      <div class="bigchart" id="mChart"></div>
      <div class="kv">${[["PM2.5", a.pm2_5], ["PM10", a.pm10], ["NO₂", a.nitrogen_dioxide], ["Ozone", a.ozone], ["SO₂", a.sulphur_dioxide]]
        .map(([k2, v]) => `<div><span>${k2} · µg/m³</span><b>${r0(v)}</b></div>`).join("")}
        ${pol.map(([k2, v]) => `<div><span>${k2.replace("_pollen", "")} pollen</span><b style="color:${level(v ?? 0, POLLEN)[2]}">${v == null ? "–" : level(v, POLLEN)[1]}</b></div>`).join("")}</div>`);
    svgChart($("mChart"), { t: at.slice(ai, ai + 48), sel: 0, nowFirst: true, lines: [{ v: AQ.hourly.european_aqi.slice(ai, ai + 48), color: "--positive", labels: true, fill: true, fmt: v => r0(v), min: 0 }] });
  }
}

// ---------- radar ----------
// RainViewer's free tier serves the last ~2 h at 10-min steps, natively up to
// zoom 7; Leaflet upscales past that. Labels sit above the rain. CARTO's free
// basemaps now need a key; Esri's light/dark canvases don't, and follow the theme.
let radar = null, bigRadar = null, FRAMES = null;
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
const esriUrl = (dark, kind) => `${ESRI}/World_${dark ? "Dark" : "Light"}_Gray_${kind}/MapServer/tile/{z}/{y}/{x}`;
const isDark = () => document.documentElement.dataset.theme === "dark";
async function loadFrames() {
  try {
    const d = await (await fetch("https://api.rainviewer.com/public/weather-maps.json")).json();
    FRAMES = { host: d.host, list: [...(d.radar.past || []), ...(d.radar.nowcast || [])] };
    radar?.setFrames(); bigRadar?.setFrames();
    radar?.refreshClouds(); bigRadar?.refreshClouds();
  } catch {}
}
// Clouds from EUMETSAT's public WMS (keyless, CORS-open), MTG satellite, every 10 min.
//   Day:   0.6 µm visible, ~1 km over the UK (cloud streets show). Brightness
//          becomes opacity; from histograms over London, ground sits ~50-65 and
//          cloud 95-145.
//   Night: 10.5 µm infrared, ~2 km, thresholded so only cold (mid/high) cloud
//          shows. Low cloud is about as warm as the ground at night and can't be
//          separated, so it is honestly missing — the status pill says so.
// Tried and dropped for night: Meteosat's cloud mask (msg_fes:clm). On a clear
// 27 Oct 2026 evening it flagged 77% of the London view as cloud while every
// London airport METAR reported no cloud: cooling land reads as low cloud.
// Clear ground stays transparent; cloud is a theme-coloured wash.
const EUMETSAT = "https://view.eumetsat.int/geoserver/wms";
const CLOUD_SRC = {
  vis: { layer: "mtg_fd:vis06_hrfi", mPerPx: 1000, step: 600, alpha: p => Math.sqrt(Math.max(0, Math.min(1, (p[0] - 72) / 78))) },
  ir: { layer: "mtg_fd:ir105_hrfi", mPerPx: 2000, step: 600, alpha: p => Math.sqrt(Math.max(0, Math.min(1, (p[0] - 66) / 64))) },
};
const CloudLayer = L.GridLayer.extend({
  options: { tileSize: 256, opacity: 1, zIndex: 4, time: null, src: "vis", attribution: "EUMETSAT" },
  createTile(coords, done) {
    const tile = document.createElement("canvas"), size = this.getTileSize();
    tile.width = size.x; tile.height = size.y;
    const src = CLOUD_SRC[this.options.src];
    const nw = this._map.unproject(coords.scaleBy(size), coords.z), se = this._map.unproject(coords.scaleBy(size).add(size), coords.z);
    const a = L.CRS.EPSG3857.project(nw), b = L.CRS.EPSG3857.project(se);
    // Fetch at about the sensor's resolution (no point asking for more) and let
    // bilinear upscaling smooth it when zoomed in.
    const px = Math.max(16, Math.min(size.x, Math.round((b.x - a.x) / src.mPerPx)));
    const q = new URLSearchParams({ service: "WMS", version: "1.3.0", request: "GetMap", layers: src.layer, styles: "",
      format: "image/png", crs: "EPSG:3857", bbox: `${a.x},${b.y},${b.x},${a.y}`, width: px, height: px });
    if (src.transparent) q.set("transparent", "true");
    if (this.options.time) q.set("time", this.options.time);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas"); c.width = c.height = px;
        const cx = c.getContext("2d"); cx.drawImage(img, 0, 0);
        const d = cx.getImageData(0, 0, px, px), p = d.data;
        const [r, g, bl] = this.options.rgb;
        let cloudy = 0;
        for (let i = 0; i < p.length; i += 4) {
          const k = src.alpha(p.subarray(i, i + 4));
          if (k > .3) cloudy++;
          p[i] = r; p[i + 1] = g; p[i + 2] = bl; p[i + 3] = Math.round(255 * k);
        }
        tile._cover = cloudy / (px * px);   // for the "cloud n%" status
        cx.putImageData(d, 0, 0);
        const tx = tile.getContext("2d");
        tx.imageSmoothingEnabled = true; tx.imageSmoothingQuality = "high";
        tx.drawImage(c, 0, 0, size.x, size.y);
      } catch {}
      done(null, tile);
    };
    img.onerror = () => done(null, tile);
    img.src = `${EUMETSAT}?${q}`;
    return tile;
  },
});
// Images land ~20-30 min after their slot; "now" asks for the latest, an older
// radar frame for the slot at or before it.
const cloudTime = (sec, latest, src) => latest ? null
  : new Date(Math.floor(sec / CLOUD_SRC[src].step) * CLOUD_SRC[src].step * 1000).toISOString().replace(".000", "");
// Visible only works with the sun well up; otherwise infrared.
function cloudSrc(sec) {
  if (!WX) return "ir";
  const i = WX.daily.time.findIndex(t => dayKey(t + 43200) === dayKey(sec));
  const rise = D("sunrise", i), set = D("sunset", i);
  return rise && sec > rise + 3600 && sec < set - 3600 ? "vis" : "ir";
}
let cloudOn = store.get("wx.clouds", true);

// Opens on the latest frame (now); the slider scrubs back through the last ~2 h.
// Left alone for 2 minutes it springs back to now, so the kiosk never shows old rain.
function makeRadar(el, zoom, timeEl, slider, cloudBtn, statusEl) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, minZoom: 5, maxZoom: 11 }).setView([LOC.lat, LOC.lon], zoom);
  map.attributionControl.setPrefix("");
  map.createPane("labels"); map.getPane("labels").style.zIndex = 450; map.getPane("labels").style.pointerEvents = "none";
  const base = L.tileLayer(esriUrl(isDark(), "Base"), { maxNativeZoom: 16, attribution: "Esri · RainViewer · EUMETSAT" }).addTo(map);
  const ref = L.tileLayer(esriUrl(isDark(), "Reference"), { maxNativeZoom: 16, pane: "labels" }).addTo(map);
  const you = L.marker([LOC.lat, LOC.lon], { icon: L.divIcon({ className: "", html: '<div class="youdot"></div>', iconSize: [16, 16] }), zIndexOffset: 1000 }).addTo(map);
  const cloudStyle = () => isDark() ? { rgb: [255, 255, 255], opacity: .5 } : { rgb: [70, 82, 104], opacity: .42 };
  const clouds = new CloudLayer({ ...cloudStyle(), src: cloudSrc(nowSec()) });
  let layers = [], k = 0, back = null, cloudT;
  const syncCloud = () => {
    if (!cloudOn || !FRAMES) return;
    const at = FRAMES.list[k]?.time ?? nowSec(), src = cloudSrc(at), t = cloudTime(at, k >= layers.length - 1, src);
    if (t === clouds.options.time && src === clouds.options.src) return;
    clouds.options.time = t; clouds.options.src = src;
    clearTimeout(cloudT); cloudT = setTimeout(() => clouds.redraw(), 250);   // don't refetch on every slider tick
  };
  const setCloudBtn = () => { if (cloudBtn) { cloudBtn.classList.toggle("on", cloudOn); cloudBtn.setAttribute("aria-pressed", cloudOn); } };
  setCloudBtn();
  if (cloudBtn) cloudBtn.addEventListener("click", () => {
    cloudOn = !cloudOn; store.set("wx.clouds", cloudOn); setCloudBtn();
    if (cloudOn) { const at = FRAMES?.list[k]?.time ?? nowSec(); clouds.options.src = cloudSrc(at); clouds.options.time = cloudTime(at, k >= layers.length - 1, clouds.options.src); clouds.addTo(map); }
    else map.removeLayer(clouds);
    status();
  });

  // Status pill: a spinner while the visible rain frame or the clouds are still
  // fetching, then what actually came back, so an empty map reads as "nothing
  // there" rather than "not loaded". Rain is measured from the loaded tiles'
  // pixels (RainViewer serves CORS), cloud from the coverage each tile recorded.
  const busy = new Set();
  let statusT;   // declared up here: adding a layer fires "loading" synchronously
  const track = (layer, name) => layer.on("loading", () => { busy.add(name); status(); }).on("load", () => { busy.delete(name); status(); });
  track(clouds, "clouds");
  if (cloudOn) clouds.addTo(map);   // after tracking, so the first load shows the spinner
  const probe = document.createElement("canvas"); probe.width = probe.height = 32;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  // Only the part of each tile that is actually on screen counts: tiles reach well
  // past the edges (more so as the z7 radar is upscaled), and rain off-screen
  // shouldn't make the pill say "in view".
  const rainInView = layer => {
    const view = map.getPixelBounds();
    let any = false, seen = 0;
    for (const t of Object.values(layer._tiles || {})) {
      if (!t.current || !t.loaded || !t.el.complete || !t.el.naturalWidth) continue;
      const tb = layer._tileCoordsToBounds(t.coords);
      const tl = map.project(tb.getNorthWest()), br = map.project(tb.getSouthEast());
      const x0 = Math.max(tl.x, view.min.x), x1 = Math.min(br.x, view.max.x);
      const y0 = Math.max(tl.y, view.min.y), y1 = Math.min(br.y, view.max.y);
      if (x1 <= x0 || y1 <= y0) continue;
      const W = t.el.naturalWidth, fx = W / (br.x - tl.x), fy = W / (br.y - tl.y);
      seen++;
      try {
        pctx.clearRect(0, 0, 32, 32);
        pctx.drawImage(t.el, (x0 - tl.x) * fx, (y0 - tl.y) * fy, (x1 - x0) * fx, (y1 - y0) * fy, 0, 0, 32, 32);
        const d = pctx.getImageData(0, 0, 32, 32).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 40) { any = true; break; }
      } catch { return null; }
      if (any) break;
    }
    return seen ? any : null;
  };
  map.on("moveend zoomend", () => status());
  const cloudInView = () => {
    const tiles = Object.values(clouds._tiles || {}).filter(t => t.current && t.loaded && t.el._cover != null);
    return tiles.length ? tiles.reduce((s, t) => s + t.el._cover, 0) / tiles.length : null;
  };
  function status() {
    if (!statusEl) return;
    clearTimeout(statusT);
    statusT = setTimeout(() => {
      const cur = layers[k], loadingRain = cur && busy.has(cur._leaflet_id), loadingCloud = cloudOn && busy.has("clouds");
      if (loadingRain || loadingCloud) {
        statusEl.innerHTML = `<span class="spin"></span>Loading ${loadingRain && loadingCloud ? "radar & clouds" : loadingRain ? "radar" : "clouds"}…`;
        statusEl.hidden = false; return;
      }
      const rain = cur ? rainInView(cur) : null, cov = cloudOn ? cloudInView() : null;
      const parts = [];
      if (rain != null) parts.push(rain ? `${ms("rainy", "ic-rain")}Rain in view` : "No rain in view");
      const night = clouds.options.src === "ir";
      if (cov != null) parts.push(night
        ? (cov < .03 ? "no mid/high cloud (night: low cloud not visible)" : `mid/high cloud ${Math.round(cov * 100)}% (night)`)
        : (cov < .03 ? "clear sky" : `cloud ${Math.round(cov * 100)}%`));
      statusEl.innerHTML = parts.join(" · ");
      statusEl.hidden = !parts.length;
    }, 120);
  }
  const show = i => {
    k = i;
    layers.forEach((l, j) => l.setOpacity(j === i ? .8 : 0));
    syncCloud(); status();
    slider.value = i;
    slider.style.setProperty("--p", `${layers.length > 1 ? (i / (layers.length - 1)) * 100 : 100}%`);
    const f = FRAMES.list[i]; if (!f) return;
    const ago = Math.round((Date.now() / 1000 - f.time) / 60);
    timeEl.innerHTML = i === layers.length - 1 ? `<b>Now</b> · ${hm(f.time)}` : `${hm(f.time)} · <b>${ago} min ago</b>`;
  };
  const latest = () => layers.length && show(layers.length - 1);
  slider.addEventListener("input", () => {
    show(+slider.value);
    clearTimeout(back); back = setTimeout(latest, 2 * 60e3);
  });
  return {
    map,
    setFrames() {
      if (!FRAMES) return;
      const atNow = k >= layers.length - 1, keep = !atNow && FRAMES.list.findIndex(f => f.time === FRAMES.list[k]?.time);
      layers.forEach(l => map.removeLayer(l));
      layers = FRAMES.list.map(f => {
        const l = L.tileLayer(`${FRAMES.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`,
          { opacity: 0, maxNativeZoom: 7, maxZoom: 11, zIndex: 5, crossOrigin: "anonymous" }).addTo(map);
        return track(l, l._leaflet_id);
      });
      slider.max = Math.max(0, layers.length - 1);
      show(atNow || keep == null || keep < 0 ? layers.length - 1 : keep);
    },
    setTheme(dark) {
      base.setUrl(esriUrl(dark, "Base")); ref.setUrl(esriUrl(dark, "Reference"));
      L.Util.setOptions(clouds, cloudStyle()); clouds.setOpacity(clouds.options.opacity); clouds.redraw();
    },
    // New radar frames every 10 min: also pull the newest cloud image when showing now.
    refreshClouds() { if (cloudOn && k >= layers.length - 1) clouds.redraw(); },
    recentre() { you.setLatLng([LOC.lat, LOC.lon]); map.setView([LOC.lat, LOC.lon], map.getZoom()); },
    destroy() { clearTimeout(back); clearTimeout(cloudT); clearTimeout(statusT); map.remove(); },
  };
}
$("radarBig").addEventListener("click", () => {
  openModal(`<div id="bigmap"></div><div class="mapstatus" id="bStatus" hidden></div><div class="radarbar"><span class="rtime" id="bTime">Radar</span><input type="range" class="rslider" id="bSlider" min="0" max="0" step="1" aria-label="Radar time"><button id="bCloud" class="cloudtog" title="Cloud cover">${ms("cloud")}</button><button id="bZoom" title="Whole UK">${ms("zoom_out_map")}</button></div>`, { wide: true });
  bigRadar = makeRadar($("bigmap"), 9, $("bTime"), $("bSlider"), $("bCloud"), $("bStatus"));
  bigRadar.setFrames();
  $("bZoom").onclick = () => bigRadar.map.setView([54.5, -3], 6);
  modalCleanup = () => { bigRadar.destroy(); bigRadar = null; };
});

// ---------- departures (TfL, straight from the browser) ----------
// Arrivals gives live predictions for every TfL mode. For Overground and Elizabeth
// stations ArrivalDepartures adds the timetable, so a late or cancelled train is a
// fact rather than a guess; it only accepts TfL-run rail line ids.
const TFL_RAIL = new Set(["weaver", "mildmay", "windrush", "suffragette", "lioness", "liberty", "elizabeth"]);
const LINE_COLOUR = {
  weaver: "#823a62", mildmay: "#437ec1", windrush: "#ef4d5e", suffragette: "#39b97a", lioness: "#e89a00", liberty: "#5d6061",
  victoria: "#0098d4", piccadilly: "#1c3f95", northern: "#3a3a3c", central: "#dc241f", district: "#007d32",
  "hammersmith-city": "#d97a93", circle: "#c9a800", metropolitan: "#9b0056", jubilee: "#7c8287", bakerloo: "#b36305",
  elizabeth: "#6950a1", dlr: "#00a4a7", "waterloo-city": "#4fa58b",
};
const cleanName = s => String(s ?? "").replace(/\s+(Rail|Underground|DLR|Overground)\s+Station$/i, "").replace(/\s+Station$/i, "").replace(/^London /, "");
const LINE_NAME = id => id.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
let STATIONS = [], STATION = null, DEPS = [], depDir = null, depAt = 0;

async function loadStations() {
  try {
    const q = new URLSearchParams({ lat: LOC.lat, lon: LOC.lon, radius: 2000,
      stopTypes: "NaptanRailStation,NaptanMetroStation", modes: "overground,tube,elizabeth-line,dlr,national-rail" });
    const d = await (await fetch(`https://api.tfl.gov.uk/StopPoint?${q}`)).json();
    STATIONS = (d.stopPoints || []).map(s => ({ id: s.id || s.naptanId, name: cleanName(s.commonName), dist: Math.round(s.distance),
      lines: (s.lines || []).map(l => l.id) }));
  } catch { STATIONS = []; }
  const saved = store.get("wx.station", null);
  const home = metres(LOC, HOME) < HOME_RADIUS;
  const homeStation = STATIONS.find(s => s.id === HOME_STATION) || { id: HOME_STATION, name: "Stoke Newington", lines: ["weaver"] };
  STATION = (saved && (STATIONS.find(s => s.id === saved) || (saved === HOME_STATION && home && homeStation)))
    || (home && homeStation) || STATIONS[0] || null;
  loadDeps();
}

async function loadDeps() {
  if (!STATION) { $("station").textContent = "No station nearby"; $("deps").innerHTML = ""; return; }
  const dist = STATIONS.find(s => s.id === STATION.id)?.dist;
  $("station").innerHTML = `${ms("train")}${esc(STATION.name)}${dist != null ? `<small>${dist < 1000 ? dist + " m" : (dist / 1000).toFixed(1) + " km"}</small>` : ""}`;
  const timetabled = (STATION.lines || []).filter(l => TFL_RAIL.has(l));
  try {
    const [arr, ad] = await Promise.all([
      fetch(`https://api.tfl.gov.uk/StopPoint/${STATION.id}/Arrivals`).then(r => r.ok ? r.json() : Promise.reject(r.status)),
      timetabled.length && STATION.id.startsWith("910G")
        ? fetch(`https://api.tfl.gov.uk/StopPoint/${STATION.id}/ArrivalDepartures?lineIds=${timetabled.join(",")}`).then(r => r.ok ? r.json() : []).catch(() => [])
        : [],
    ]);
    DEPS = normalise(arr, ad, timetabled);
    depAt = Date.now();
    $("depStamp").textContent = "Live";
  } catch {
    $("depStamp").textContent = depAt ? "Stale" : "";
  }
  renderDeps();
}

// Both feeds into one row shape. The timetable has no direction or line, so borrow
// them from a live prediction heading for the same destination.
function normalise(arr, ad, timetabled) {
  const byDest = new Map();
  for (const p of arr) if (p.destinationNaptanId && !byDest.has(p.destinationNaptanId)) byDest.set(p.destinationNaptanId, p);
  const plat = s => s && !/unknown/i.test(s) ? s.replace(/^.*-\s*/, "").replace(/^Platform\s*/i, "Plat ") : "";
  const now = Date.now();
  if (ad.length) {
    return ad.map(r => {
      const twin = byDest.get(r.destinationNaptanId);
      const sched = Date.parse(r.scheduledTimeOfDeparture ?? "") || null;
      const est = Date.parse(r.estimatedTimeOfDeparture ?? "") || sched;
      const lineId = twin?.lineId || timetabled[0];
      return {
        dir: twin?.direction || "all", dest: cleanName(r.destinationName), lineId, line: twin?.lineName || LINE_NAME(lineId),
        plat: plat(r.platformName), exp: est, sched,
        // Floor, not round: 30 s late is not "1 min late".
        delayMin: sched && est ? Math.max(0, Math.floor((est - sched) / 60000)) : 0,
        cancelled: /cancel/i.test(r.departureStatus ?? ""),
      };
    }).filter(r => r.exp && r.exp > now - 60e3).sort((a, b) => a.exp - b.exp);
  }
  return arr.filter(p => p.expectedArrival).map(p => ({
    dir: p.direction || p.platformName || "all", dest: cleanName(p.destinationName || p.towards), lineId: p.lineId, line: p.lineName,
    plat: plat(p.platformName), exp: Date.parse(p.expectedArrival), sched: null, delayMin: 0, cancelled: false,
  })).sort((a, b) => a.exp - b.exp);
}

function renderDeps() {
  const groups = new Map();
  for (const r of DEPS) { if (!groups.has(r.dir)) groups.set(r.dir, []); groups.get(r.dir).push(r); }
  const keys = [...groups.keys()].sort((a, b) => a === "inbound" ? -1 : b === "inbound" ? 1 : a.localeCompare(b));
  const pref = store.get(`wx.dir.${STATION?.id}`, "inbound");
  depDir = groups.has(depDir) ? depDir : groups.has(pref) ? pref : keys[0] ?? null;
  // Name each direction by where most of its trains are going.
  const name = k => {
    const top = Object.entries(groups.get(k).reduce((m, r) => (m[r.dest] = (m[r.dest] || 0) + 1, m), {}))
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const dir = k === "inbound" ? "Inbound" : k === "outbound" ? "Outbound" : k === "all" ? "All" : k;
    return `${dir}${top ? " · " + top : ""}`;
  };
  $("dirTog").innerHTML = keys.length > 1 ? keys.map(k => `<button data-d="${esc(k)}" class="${k === depDir ? "on" : ""}">${esc(name(k))}</button>`).join("") : "";
  const rows = depDir ? groups.get(depDir).slice(0, 20) : [];
  const keep = $("deps").scrollTop;
  $("deps").innerHTML = rows.length ? rows.map((r, i) => {
    const late = !r.cancelled && r.delayMin >= 1;
    const time = r.cancelled ? `<s>${hm(r.sched / 1000)}</s> <span class="cancel-t">Cancelled</span>`
      : late ? `<s>${hm(r.sched / 1000)}</s> <span class="late-t">${hm(r.exp / 1000)} · ${r.delayMin} min late</span>`
      : `${hm(r.exp / 1000)}${r.sched ? " · on time" : ""}`;
    // Minutes colour: green on time, orange late, red cancelled. Tube/DLR have no
    // timetable, so their status is unknown and the number stays plain ink.
    const ontime = r.sched && !late && !r.cancelled;
    return `<div class="dep${i === 0 ? " first" : ""}${late ? " late" : ""}${ontime ? " ontime" : ""}${r.cancelled ? " cancelled" : ""}">
      <span><div class="to">${esc(r.dest)}</div>
        <div class="meta"><span class="pill" style="--c:${LINE_COLOUR[r.lineId] || "var(--ink-muted)"}">${esc(r.line)}</span>${r.plat ? esc(r.plat) + " · " : ""}${time}</div></span>
      ${r.cancelled ? `<span class="eta cx">${ms("block")}</span>` : `<span class="eta" data-exp="${r.exp}"></span>`}</div>`;
  }).join("") : `<div class="empty">${STATION ? "No live departures from TfL for this station right now." : ""}</div>`;
  $("deps").scrollTop = keep;
  tickDeps();
}
function tickDeps() {
  for (const el of document.querySelectorAll(".eta[data-exp]")) {
    const s = (+el.dataset.exp - Date.now()) / 1000;
    if (s < -30) { el.closest(".dep")?.remove(); continue; }
    const m = Math.floor(s / 60);
    el.classList.toggle("due", m < 1);
    el.innerHTML = m < 1 ? "Due" : `${m}<small>min</small>`;
  }
}
setInterval(tickDeps, 1000);
$("dirTog").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  depDir = b.dataset.d; store.set(`wx.dir.${STATION.id}`, depDir); renderDeps();
});
$("station").addEventListener("click", () => {
  const list = STATIONS.slice();
  if (!list.some(s => s.id === HOME_STATION)) list.push({ id: HOME_STATION, name: "Stoke Newington", lines: ["weaver"], dist: Math.round(metres(LOC, { lat: 51.5652, lon: -0.0727 })) });
  openModal(`<h3>${ms("train")}Station</h3><p class="lede">Nearest stations to ${esc(PLACE)}. Your choice is remembered.</p>
    <div class="stlist">${list.map(s => `<button data-id="${esc(s.id)}" class="${s.id === STATION?.id ? "on" : ""}"><span>${esc(s.name)}</span><small>${s.dist < 1000 ? s.dist + " m" : (s.dist / 1000).toFixed(1) + " km"}</small></button>`).join("")}
    <button data-id=""><span>Always use the nearest</span><small>Auto</small></button></div>`);
  $("modalBody").querySelector(".stlist").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    store.set("wx.station", b.dataset.id || null);
    STATION = b.dataset.id ? list.find(s => s.id === b.dataset.id) : (STATIONS[0] || null);
    depDir = null; closeModal(); loadDeps();
  });
});

// ---------- keep the screen on, keep everything fresh ----------
let wakeLock = null;
async function keepAwake() {
  try { if (!wakeLock && navigator.wakeLock && !document.hidden) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch {}
}
document.addEventListener("pointerdown", keepAwake, { passive: true });   // iOS wants a gesture first

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  keepAwake();
  if (Date.now() - wxAt > WX_MS) { loadWeather(); loadAir(); loadFrames(); }
  loadDeps();
});
setInterval(() => { if (!document.hidden) { loadWeather(); loadFrames(); } }, WX_MS);
setInterval(() => { if (!document.hidden) loadAir(); }, AQ_MS);
setInterval(() => { if (!document.hidden) loadDeps(); }, DEP_MS);
setInterval(() => { if (!document.hidden) locate(); }, LOC_MS);
// Charts and "in 2h 10m" drift; redraw the cheap bits each minute.
setInterval(() => {
  if (!WX || document.hidden) return;
  if (applyTheme()) renderWeather();
  else { renderSummary(); renderNowcast(); if (hourSel === 0) renderHourly(); }
}, 60e3);
// A wall screen left for days: reload once overnight to pick up deploys.
(function nightlyReload() {
  const d = new Date(), t = new Date(d); t.setHours(3, 30, 0, 0); if (t <= d) t.setDate(t.getDate() + 1);
  setTimeout(() => location.reload(), t - d);
})();
let _rs; addEventListener("resize", () => { clearTimeout(_rs); _rs = setTimeout(() => { if (WX) { renderHourly(); renderDays(); } radar?.map.invalidateSize(); }, 150); });
// The icon font arriving changes nothing in layout, but chart glyphs drawn before it
// loads can render as their ligature names in Safari; redraw once it's in.
document.fonts?.ready.then(() => { if (WX) renderHourly(); });

// ---------- boot ----------
(function init() {
  applyTheme();
  setPlace(PLACE);
  radar = makeRadar($("map"), 8, $("radarTime"), $("radarSlider"), $("radarCloud"), $("radarStatus"));
  const cached = store.get("wx.cache", null);
  if (cached) { WX = cached; TZ = WX.timezone; renderWeather(); $("stamp").textContent = "Refreshing…"; }
  loadWeather(); loadAir(); loadFrames(); loadStations();
  locate();
  keepAwake();
})();

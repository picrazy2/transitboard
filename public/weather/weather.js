// Weather board. Everything is fetched straight from the browser — Open-Meteo,
// RainViewer, TfL and OSM all allow cross-origin calls without a key — so this
// page costs zero Cloudflare function invocations however long it stays on.
//
//   Open-Meteo forecast   now / 15-min rain / hourly / 10-day. For London its
//                         "best match" is the Met Office UKV 2 km model for the
//                         first ~2 days, then ECMWF/ICON.
//   Open-Meteo air        European AQI, pollutants, pollen (CAMS).
//   TfL Unified API       nearby stations, live arrivals, and for Overground /
//                         Elizabeth stations the timetable (so delays are real).
//   Nominatim             neighbourhood name for the header.
//
// Styling follows the budget app's design system (see weather.css), dark only:
// Material Symbols for UI icons, a small multi-colour SVG set for conditions,
// colours read from the CSS tokens. SunCalc (cdnjs) gives sun and moon times
// beyond the 10-day forecast. Birthdays come from an encrypted file (see
// tools/birthdays-encrypt.mjs) unlocked by a key kept on the device.

const HOME = { lat: 51.5611161, lon: -0.0739865, name: "Stoke Newington" };
const HOME_STATION = "910GSTKNWNG";   // pinned when we're within HOME_RADIUS of it
const HOME_RADIUS = 2000;
const WX_MS = 10 * 60e3, AQ_MS = 30 * 60e3, DEP_MS = 30e3, LOC_MS = 30 * 60e3;

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
let hourSel = null;   // null = follow the current hour

// ---------- formatting ----------
let TZ;   // the forecast location's zone, once known; device zone until then
const fmt = (sec, o) => new Date(sec * 1000).toLocaleString("en-GB", { timeZone: TZ, ...o });
const hm = sec => fmt(sec, { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s/g, " ");
const hr = sec => fmt(sec, { hour: "numeric", hour12: true }).replace(/\s/g, "");
const wd = sec => fmt(sec, { weekday: "short" });
const dayKey = sec => fmt(sec, { year: "numeric", month: "2-digit", day: "2-digit" });
const r0 = v => v == null ? "–" : Math.round(v);
const deg = v => `${r0(v)}°`;
const dur = s => { const t = Math.round(s / 60), h = Math.floor(t / 60), m = t % 60; return h ? `${h}h ${m}m` : `${m}m`; };
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
    if (moved || force) { lookupPlace(); loadWeather(); loadAir(); loadStations(); }
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
    if (r.ok) { AQ = await r.json(); if (WX) renderSummary(); }
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
  const c = WX.current, ti = todayIdx();
  $("nowIcon").innerHTML = icon(c.weather_code, c.is_day);
  $("nowTemp").textContent = deg(c.temperature_2m);
  $("nowCond").textContent = label(c.weather_code);
  $("nowFeels").textContent = `Feels like ${deg(c.apparent_temperature)}`;
  $("nowHi").textContent = `H ${deg(D("temperature_2m_max", ti))}`;
  $("nowLo").textContent = `L ${deg(D("temperature_2m_min", ti))}`;
  $("stamp").textContent = `Updated ${hm(wxAt / 1000)}`;
  hourSel = null;
  renderSummary(); renderNowcast(); renderHourly(); renderDays();
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

// Six cards, three rows of two, where the 3x3 tiles used to be. The other
// readings (feels like, pressure, UV, visibility, gusts, pollen) sit behind the
// "More" button on the 24-hour card.
function renderSummary() {
  const c = WX.current, ti = todayIdx(), n = nowSec();
  const rise = D("sunrise", ti), set = D("sunset", ti), riseT = D("sunrise", ti + 1);
  const sun = n < rise ? ["Sunrise", rise] : n < set ? ["Sunset", set] : ["Sunrise", riseT];
  const dl = D("daylight_duration", ti), dlY = D("daylight_duration", ti - 1);
  const dlDelta = dlY ? Math.round((dl - dlY) / 60) : null;
  const aqi = AQ?.current?.european_aqi, aq = aqi != null ? level(aqi, AQI) : null;
  const m = moon();
  const cards = [
    ["sun", ms("wb_twilight", "ic-sun"), sun[0], hm(sun[1]), `in ${dur(sun[1] - n)} · day ${dur(dl)}${dlDelta != null ? ` ${dlDelta >= 0 ? "+" : "−"}${Math.abs(dlDelta)}m` : ""}`],
    ["wind", ms("air", "ic-cloud"), "Wind", `${r0(c.wind_speed_10m)} km/h ${compass(c.wind_direction_10m)}`, `Gusts ${r0(c.wind_gusts_10m)} · ${level(c.wind_speed_10m, BEAUFORT)[1].toLowerCase()}`],
    ["aqi", `<span class="ms" style="color:${aq ? aq[2] : "var(--ink-muted)"}">eco</span>`, "Air quality", aq ? `<span style="color:${aq[2]}">${aq[1]}</span>` : "–", aq ? `EAQI ${r0(aqi)} · PM2.5 ${r0(AQ.current.pm2_5)}` : "Loading…"],
    ["humidity", ms("humidity_percentage", "ic-rain"), "Humidity", `${r0(c.relative_humidity_2m)}%`, `Dew point ${deg(c.dew_point_2m)}`],
    ["cloud", ms("cloud", "ic-cloud"), "Cloud cover", `${r0(c.cloud_cover)}%`, `${dur(D("sunshine_duration", ti) ?? 0)} sunshine today`],
    ["moon", moonSvg(m.f, 26), "Moon", `${m.lit}% lit`, `${m.name} · in ${zodiac(moonLongitude(new Date())).name}`],
  ];
  $("summary").innerHTML = cards.map(([k, ic, a, v, s]) =>
    `<button class="chip" data-m="${k}"><span class="txt"><span class="k">${ic}${a}</span><span class="v">${v}</span><span class="s">${esc(s)}</span></span></button>`).join("");
  $("rainSub").textContent = rainStory().text;
}

function renderNowcast() {
  const m = WX.minutely_15, n = nowSec();
  const slots = m.time.map((t, i) => ({ t, mm: m.precipitation[i] ?? 0 })).filter(s => s.t + 900 > n).slice(0, 12);
  // Only worth the space when rain is actually due in the next 3 hours; otherwise
  // the rain outlook rides along as a note on the 24-hour heading.
  const wet = slots.some(s => s.mm >= 0.05);
  const changed = $("rainBlock").hidden === wet;
  $("rainBlock").hidden = !wet;
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
  const n = o.t.length, padL = 4, padR = o.bars?.axis ? 34 : 4, top = o.icons || o.arrows ? 28 : 8, bot = 18;
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
    // A second y-axis on the right for the bars (rain mm), so the temperature
    // line keeps its own scale on the left.
    if (o.bars.axis) {
      const ax = W - 2, sep = V("--separator"), muted = V("--ink-muted");
      for (const f of [0, .5, 1]) {
        const y = plotBot - f * bh;
        s += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${sep}" stroke-dasharray="${f ? "2 4" : ""}"/>`;
        s += `<text x="${ax}" y="${y + 4}" text-anchor="end" fill="${f ? col : muted}">${f ? (bm * f).toFixed(bm * f < 1 ? 1 : 0) : 0}${f === 1 ? o.bars.axis : ""}</text>`;
      }
    }
    o.bars.v.forEach((v, i) => {
      if (!v) return;
      const h = Math.max(2, (v / bm) * bh);
      s += `<rect x="${x(i) - step * .3}" y="${plotBot - h}" width="${step * .6}" height="${h}" rx="3" fill="${col}" opacity="${o.bars.alpha?.[i] ?? o.bars.opacity ?? .45}"/>`;
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
  // A solid line at the current time, placed within the hour, not on a tick.
  if (o.nowAt && o.nowAt >= o.t[0] && o.nowAt < o.t[0] + n * 3600) {
    const nx = padL + ((o.nowAt - o.t[0]) / 3600) * step, acc = V("--accent");
    s += `<line x1="${nx}" x2="${nx}" y1="${top}" y2="${plotBot}" stroke="${acc}" stroke-width="2"/>`;
    s += `<rect x="${nx - 17}" y="${top + 1}" width="34" height="15" rx="7.5" fill="${acc}"/><text x="${nx}" y="${top + 12}" text-anchor="middle" fill="#fff" font-weight="600" font-size="10">Now</text>`;
  }
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
  // Default: temperature on the left axis, rain (mm per hour) as bars on a right
  // axis, each bar's strength the chance of rain. Wind lives in the wind card.
  const mm = sl("precipitation"), nice = [1, 2, 5, 10, 20].find(v => v >= Math.max(...mm.map(x => x ?? 0))) ?? 50;
  return { ...base, icons,
    bars: { v: mm, max: nice, color: "--rain", axis: "mm", full: false,
      alpha: sl("precipitation_probability").map(p => (.3 + .6 * (p ?? 0) / 100).toFixed(2)) },
    // Rain also as a line, drawn even when it's all zero, so the right-hand axis
    // always has something on it. Scaled to the bars: they use the bottom 40%.
    lines: [{ v: mm.map(v => v ?? 0), min: 0, max: nice / .4, color: "--rain", w: 2.5 },
            { v: sl("apparent_temperature"), color: "--ink-faint", w: 2, dash: "4 4" },
            { v: sl("temperature_2m"), color: "--hi", labels: true, fmt: v => `${r0(v)}°`, fill: true }] };
}

function hourText(i) {
  const c = H("weather_code", i), d = H("is_day", i);
  return `<b>${hm(H("time", i))}</b> · ${icon(c, d)} ${label(c)} · <b>${deg(H("temperature_2m", i))}</b> feels ${deg(H("apparent_temperature", i))}` +
    ` · ${ms("umbrella", "ic-rain")} ${r0(H("precipitation_probability", i))}% ${(H("precipitation", i) ?? 0).toFixed(1)} mm` +
    ` · ${ms("air", "ic-cloud")} ${r0(H("wind_speed_10m", i))} km/h ${compass(H("wind_direction_10m", i))}, gusts ${r0(H("wind_gusts_10m", i))}` +
    ` · UV ${r0(H("uv_index", i))} · ${ms("humidity_percentage", "ic-rain")} ${r0(H("relative_humidity_2m", i))}%`;
}

// The main chart is today, midnight to midnight, with a line at the current time:
// a fixed frame is easier to read at a glance than a window that slides each hour.
function todayStart() { const k = dayKey(nowSec()); return Math.max(0, WX.hourly.time.findIndex(t => dayKey(t) === k)); }
function renderHourly() {
  if (!WX) return;
  const from = todayStart(), cur = Math.min(23, Math.max(0, hourIdx() - from)), sel = hourSel ?? cur;
  svgChart($("hourChart"), { ...hourlyChart(from, 24, "temp", sel, i => { hourSel = i === cur ? null : i; renderHourly(); }), nowAt: nowSec() });
  $("hourDetail").innerHTML = hourText(from + sel);
}
$("moreBtn").addEventListener("click", () => WX && detailsModal());

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
// The readings that didn't make the six summary cards, one tap away.
function detailsModal() {
  const c = WX.current, ti = todayIdx(), hi = hourIdx();
  const uvNow = c.uv_index ?? H("uv_index", hi) ?? 0, uv = level(uvNow, UV), uvMax = D("uv_index_max", ti) ?? 0;
  const pol = AQ?.current ? Object.entries(AQ.current).filter(([k]) => k.endsWith("_pollen")) : [];
  const worst = pol.filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0];
  const pl = worst ? level(worst[1], POLLEN) : null;
  const vis = c.visibility ?? H("visibility", hi);
  const tiles = [
    ["feels", "thermostat", "Feels like", deg(c.apparent_temperature), c.apparent_temperature < c.temperature_2m - 1.5 ? "Wind chill" : c.apparent_temperature > c.temperature_2m + 1.5 ? "Humid" : "Similar to actual"],
    ["pressure", "compress", "Pressure", `${r0(c.pressure_msl)}<small>hPa</small>`, pressureTrend()],
    ["uv", "light_mode", "UV index", `<span style="color:${uv[2]}">${r0(uvNow)}</span><small>${uv[1]}</small>`, `Max today ${uvMax.toFixed(0)} · ${level(uvMax, UV)[1]}`],
    ["visibility", "visibility", "Visibility", vis == null ? "–" : vis >= 10000 ? `${r0(vis / 1000)}<small>km</small>` : `${(vis / 1000).toFixed(1)}<small>km</small>`, vis == null ? "" : vis < 1000 ? "Fog" : vis < 5000 ? "Hazy" : "Clear"],
    ["gusts", "air", "Gusts", `${r0(c.wind_gusts_10m)}<small>km/h</small>`, `Max today ${r0(D("wind_gusts_10m_max", ti))} km/h`],
    ["pollen", "local_florist", "Pollen", pl ? `<span style="color:${pl[2]}">${pl[1]}</span>` : "–", worst && worst[1] >= 1 ? `${worst[0].replace("_pollen", "")} ${r0(worst[1])}/m³` : "Out of season"],
  ];
  openModal(`<h3>${ms("thermostat")}More details</h3><p class="lede">Tap any reading for its next 48 hours.</p>
    <div class="tiles">${tiles.map(([k, ic, t, v, s]) =>
      `<button class="tile" data-m="${k}"><span class="k">${ms(ic)}${t}</span><span class="v">${v}</span><span class="s">${esc(s)}</span></button>`).join("")}</div>`);
}

// ---------- moon (astronomy, then the astrology people read into it) ----------
// Low-precision lunar longitude (Meeus ch. 47, main terms): good to ~1°, plenty
// to say which sign the moon is in.
function moonLongitude(date) {
  const d = date / 864e5 - 10957.5, r = Math.PI / 180;   // days since J2000.0
  const L = 218.316 + 13.176396 * d, M = (134.963 + 13.064993 * d) * r, Ms = (357.529 + 0.98560028 * d) * r;
  const D2 = (297.850 + 12.190749 * d) * r * 2, F2 = (93.272 + 13.229350 * d) * r * 2;
  const lon = L + 6.289 * Math.sin(M) + 1.274 * Math.sin(D2 - M) + 0.658 * Math.sin(D2) + 0.214 * Math.sin(2 * M)
    - 0.186 * Math.sin(Ms) - 0.114 * Math.sin(F2);
  return ((lon % 360) + 360) % 360;
}
const SIGNS = [
  ["Aries", "♈", "fire", "Impulsive, brave energy. Good for starting things, short on patience."],
  ["Taurus", "♉", "earth", "Slow, sensual, steady. Comfort food, nature, finishing what you began."],
  ["Gemini", "♊", "air", "Chatty and curious. Messages, quick trips, too many tabs open."],
  ["Cancer", "♋", "water", "Home and feelings run high. Nesting, family, a soft day."],
  ["Leo", "♌", "fire", "Warm and showy. Celebrate, create, be seen."],
  ["Virgo", "♍", "earth", "Tidy, practical, detail-minded. Lists, health, putting things in order."],
  ["Libra", "♎", "air", "Social and balancing. Partnerships, beauty, fairness."],
  ["Scorpio", "♏", "water", "Intense and private. Depth over small talk; let go of something."],
  ["Sagittarius", "♐", "fire", "Restless optimism. Plans, travel, big ideas."],
  ["Capricorn", "♑", "earth", "Ambitious and grounded. Work, structure, long-term goals."],
  ["Aquarius", "♒", "air", "Independent and inventive. Friends, causes, doing it differently."],
  ["Pisces", "♓", "water", "Dreamy and intuitive. Rest, art, music, let things drift."],
];
const zodiac = lon => { const s = SIGNS[Math.floor(lon / 30) % 12]; return { name: s[0], glyph: s[1], element: s[2], meaning: s[3] }; };
const PHASE_MEANING = [
  "New moon: a reset. Traditionally the time to set intentions and begin quietly.",
  "Waxing crescent: momentum building. Take the first small steps on what you started.",
  "First quarter: a push. Decisions and obstacles; act rather than wait.",
  "Waxing gibbous: refine and adjust. Nearly there, keep tuning.",
  "Full moon: peak and release. Things come to light; emotions run high, sleep runs light.",
  "Waning gibbous: gratitude and sharing. Pass on what you learned.",
  "Last quarter: let go. Clear out, forgive, finish loose ends.",
  "Waning crescent: rest. Wind down and recharge before the next cycle.",
];
// Traditional (Old Farmer's Almanac) names for the full moon of each month.
const FULL_NAMES = ["Wolf", "Snow", "Worm", "Pink", "Flower", "Strawberry", "Buck", "Sturgeon", "Harvest", "Hunter's", "Beaver", "Cold"];
// Next times the phase crosses new / first quarter / full / last quarter, from SunCalc.
function nextPhases(from = new Date(), days = 32) {
  const out = [], names = ["New moon", "First quarter", "Full moon", "Last quarter"];
  let prev = SunCalc.getMoonIllumination(from).phase;
  for (let h = 1; h <= days * 24; h++) {
    const t = new Date(+from + h * 3600e3), p = SunCalc.getMoonIllumination(t).phase;
    for (let q = 0; q < 4; q++) {
      const target = q / 4;
      const crossed = q === 0 ? p < prev - .5 : prev < target && p >= target;
      // The phase jitters across 0/1 near new moon; one event per phase per cycle.
      if (crossed && !out.some(o => o.q === q && t - o.t < 2 * 864e5)) out.push({ t, q, name: names[q] });
    }
    prev = p;
  }
  return out;
}
function moonModal() {
  const now = new Date(), ill = SunCalc.getMoonIllumination(now), f = ill.phase;
  const m = moon(now), z = zodiac(moonLongitude(now)), k = Math.round(f * 8) % 8;
  const times = SunCalc.getMoonTimes(now, LOC.lat, LOC.lon), tmr = SunCalc.getMoonTimes(new Date(+now + 864e5), LOC.lat, LOC.lon);
  const rise = times.rise && times.rise > now ? times.rise : tmr.rise, set = times.set && times.set > now ? times.set : tmr.set;
  const phases = nextPhases(now);
  const full = phases.find(p => p.q === 2);
  const age = f * 29.53;
  const sunSign = zodiac(((280.46 + 0.9856474 * (now / 864e5 - 10957.5)) % 360 + 360) % 360);
  const ds = d => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  // Eight phases of the cycle, the current one ringed; then the next 30 nights.
  const strip = [0, 1, 2, 3, 4, 5, 6, 7].map(i => `<div class="ph${i === k ? " on" : ""}">${moonSvg(i / 8 + .0001, 40)}<span>${["New", "Wax. cres.", "1st qtr", "Wax. gib.", "Full", "Wan. gib.", "Last qtr", "Wan. cres."][i]}</span></div>`).join("");
  const cal = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(+now + i * 864e5), p = SunCalc.getMoonIllumination(d).phase;
    return `<div class="mc${i === 0 ? " on" : ""}">${moonSvg(p + .0001, 26)}<span>${i === 0 ? "Today" : d.getDate()}</span></div>`;
  }).join("");
  openModal(`<h3>${moonSvg(f, 30)} ${m.name} in ${z.name} ${z.glyph}</h3>
    <p class="lede">${Math.round(ill.fraction * 100)}% lit · ${age.toFixed(1)} days old · rises ${rise ? hm(rise / 1000) : "–"}, sets ${set ? hm(set / 1000) : "–"}</p>
    <div class="phases">${strip}</div>
    <div class="moonmeaning">
      <div><span>This phase</span><p>${PHASE_MEANING[k]}</p></div>
      <div><span>Moon in ${z.name} · ${z.element}</span><p>${z.meaning}</p></div>
      <div><span>Sun in ${sunSign.name} ${sunSign.glyph}</span><p>The season's backdrop: ${sunSign.meaning.charAt(0).toLowerCase() + sunSign.meaning.slice(1)}</p></div>
    </div>
    <div class="kv">${phases.slice(0, 4).map(p => `<div><span>${p.name}${p.q === 2 ? ` · ${FULL_NAMES[p.t.getMonth()]} Moon` : ""}</span><b>${ds(p.t)}</b> ${hm(p.t / 1000)}</div>`).join("")}</div>
    <h4>Next 30 nights</h4><div class="mooncal">${cal}</div>
    <p class="fine">Phases and times are astronomy (SunCalc). The meanings are traditional astrology, for fun.${full ? ` Next full moon: the ${FULL_NAMES[full.t.getMonth()]} Moon.` : ""}</p>`);
}

document.addEventListener("click", e => {
  const b = e.target.closest("[data-m]"); if (!b || !WX) return;
  if (b.dataset.m === "moon") return moonModal();
  metricModal(b.dataset.m);
});
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
// Sunrise and sunset over weeks to a year: day-to-day they move by minutes, so the
// shape only shows on a long axis. Two y-axes (each time keeps its own range) —
// sunrise on the left, sunset on the right. SunCalc, not the forecast, so it can
// run past the 10 forecast days; clock changes show as steps.
const locMin = sec => { const [h, m] = fmt(sec, { hour: "2-digit", minute: "2-digit", hour12: false }).split(":").map(Number); return (h % 24) * 60 + m; };
const clock = min => { const h = Math.floor(min / 60), m = Math.round(min % 60); return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`; };
function sunSeries(t0, n) {
  return Array.from({ length: n }, (_, i) => {
    const day = t0 + i * 86400, x = SunCalc.getTimes(new Date((day + 43200) * 1000), LOC.lat, LOC.lon);
    const rise = x.sunrise / 1000, set = x.sunset / 1000;
    return { day, rise, set, r: locMin(rise), s: locMin(set), len: set - rise };
  });
}
function drawSunTimes(el, data, sel, onPick) {
  const W = el.clientWidth, Hh = el.clientHeight; if (W < 60 || Hh < 60) return;
  const padL = 58, padR = 58, top = 16, bot = 26, n = data.length;
  const X = i => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  // Each axis snaps to whole or half hours: half-hour ticks on a short range,
  // hourly once the swing passes ~2.5 h (a year, or across a clock change).
  const range = k => {
    const v = data.map(d => d[k]), lo = Math.min(...v), hi = Math.max(...v);
    const step = hi - lo > 150 ? 60 : 30;
    let a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
    if (b - a < 2 * step) b = a + 2 * step;
    return [a, b, step];
  };
  const [rLo, rHi, rStep] = range("r"), [sLo, sHi, sStep] = range("s");
  const Yr = v => top + (v - rLo) / (rHi - rLo) * (Hh - top - bot);          // later sunrise sits lower
  const Ys = v => Hh - bot - (v - sLo) / (sHi - sLo) * (Hh - top - bot);     // later sunset sits higher
  // Sunrise yellow, sunset pink: far apart in hue so the two lines never blur.
  const rise = V("--sun"), set = V("--cat-4"), sep = V("--separator"), muted = V("--ink-muted"), ink = V("--ink");
  let s = `<svg viewBox="0 0 ${W} ${Hh}" xmlns="http://www.w3.org/2000/svg">`;
  for (let m = rLo; m <= rHi; m += rStep) {
    const y = Yr(m);
    s += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${sep}" stroke-dasharray="${m % 60 ? "2 4" : ""}"/>`;
    s += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="${rise}">${clock(m)}</text>`;
  }
  for (let m = sLo; m <= sHi; m += sStep) s += `<text x="${W - padR + 8}" y="${Ys(m) + 4}" fill="${set}">${clock(m)}</text>`;
  // Month starts (or weeks, on a short range) along the bottom.
  data.forEach((d, i) => {
    const dt = fmt(d.day + 43200, { day: "numeric" }) | 0;
    const tick = n > 60 ? dt === 1 : i % 7 === 0;
    if (!tick) return;
    s += `<line x1="${X(i)}" x2="${X(i)}" y1="${top}" y2="${Hh - bot}" stroke="${sep}" stroke-dasharray="2 4"/>`;
    s += `<text x="${X(i)}" y="${Hh - 6}" text-anchor="middle" fill="${muted}">${fmt(d.day + 43200, n > 60 ? { month: "short" } : { day: "numeric", month: "short" })}</text>`;
  });
  const path = (k, Y) => data.map((d, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(d[k]).toFixed(1)}`).join("");
  s += `<path d="${path("r", Yr)}" fill="none" stroke="${rise}" stroke-width="3" stroke-linejoin="round"/>`;
  s += `<path d="${path("s", Ys)}" fill="none" stroke="${set}" stroke-width="3" stroke-linejoin="round"/>`;
  s += `<text x="${padL + 6}" y="${top + 14}" fill="${rise}" font-weight="600">Sunrise</text><text x="${W - padR - 6}" y="${top + 14}" text-anchor="end" fill="${set}" font-weight="600">Sunset</text>`;
  const d = data[sel];
  s += `<line x1="${X(sel)}" x2="${X(sel)}" y1="${top}" y2="${Hh - bot}" stroke="${ink}" stroke-opacity=".35" stroke-dasharray="3 3"/>`;
  s += `<circle cx="${X(sel)}" cy="${Yr(d.r)}" r="5.5" fill="${rise}" stroke="${V("--surface-1")}" stroke-width="2.5"/><circle cx="${X(sel)}" cy="${Ys(d.s)}" r="5.5" fill="${set}" stroke="${V("--surface-1")}" stroke-width="2.5"/>`;
  el.innerHTML = s + "</svg>";
  const pick = e => { const r = el.getBoundingClientRect(); onPick(Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - padL) / (W - padL - padR) * (n - 1))))); };
  el.onpointerdown = e => { el.setPointerCapture?.(e.pointerId); pick(e); };
  el.onpointermove = e => { if (e.buttons) pick(e); };
}
function sunModal() {
  const ti = todayIdx(), t0 = D("time", ti);
  let n = 90, sel = 0, data = sunSeries(t0, n);
  openModal(`<h3>${ms("wb_twilight", "ic-sun")}Sunrise & sunset</h3>
    <p class="lede">${sunLede(ti)}</p>
    <div class="sunarc" id="sunArc"></div>
    <div class="cardhead"><h4 id="stDetail"></h4>
      <div class="seg" id="stSeg"><button data-n="30">30 days</button><button data-n="90" class="on">90 days</button><button data-n="365">Year</button></div></div>
    <div class="sunchart" id="sunTimes"></div>`);
  drawSunArc($("sunArc"), ti);
  const draw = () => {
    const d = data[sel], prev = data[sel - 1];
    const delta = prev ? Math.round((d.len - prev.len) / 60) : null;
    $("stDetail").innerHTML = `<b>${sel === 0 ? "Today" : fmt(d.day + 43200, { weekday: "short", day: "numeric", month: "short" })}</b> · sunrise ${hm(d.rise)} · sunset ${hm(d.set)} · ${dur(d.len)} daylight${delta != null ? ` (${delta >= 0 ? "+" : "−"}${Math.abs(delta)}m)` : ""}`;
    drawSunTimes($("sunTimes"), data, sel, i => { sel = i; draw(); });
  };
  for (const b of $("stSeg").querySelectorAll("button")) b.onclick = () => {
    n = +b.dataset.n; data = sunSeries(t0, n); sel = Math.min(sel, n - 1);
    for (const x of $("stSeg").querySelectorAll("button")) x.classList.toggle("on", x === b);
    draw();
  };
  draw();
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
  if (k === "sun") return sunModal();
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
  // Icons in the card header (city = towards London, landscape = away), with the
  // full "Inbound · Liverpool Street" as the tooltip; anything else stays text.
  const glyph = k => k === "inbound" ? ms("location_city") : k === "outbound" ? ms("landscape") : esc(k.replace(/^Platform\s*/i, "P"));
  $("dirTog").innerHTML = keys.length > 1 ? keys.map(k => `<button data-d="${esc(k)}" class="${k === depDir ? "on" : ""}" title="${esc(name(k))}" aria-label="${esc(name(k))}">${glyph(k)}</button>`).join("") : "";
  $("dirName").textContent = depDir && keys.length > 1 ? name(depDir).replace(/^(Inbound|Outbound|All) · /, "to ") : "";
  const rows = depDir ? groups.get(depDir).slice(0, 20) : [];
  const keep = $("deps").scrollTop;
  $("deps").innerHTML = rows.length ? rows.map((r, i) => {
    const late = !r.cancelled && r.delayMin >= 1;
    const time = r.cancelled ? `<s>${hm(r.sched / 1000)}</s> <span class="cancel-t">Cancelled</span>`
      : late ? `<s>${hm(r.sched / 1000)}</s> <span class="late-t">${hm(r.exp / 1000)} +${r.delayMin}</span>`
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

// ---------- birthdays ----------
// Guests' names and birthdays never sit in the repo or on the public site in the
// clear: birthdays.enc.json is AES-GCM, keyed by PBKDF2 from a passphrase that
// lives only on the device (set once by opening /weather/#bkey=<passphrase>).
// Rebuild it with tools/birthdays-encrypt.mjs.
const GROUPS = { family: [0, "Family"], groom: [1, "Groom's party"], bride: [2, "Bride's party"], guest: [3, "Guest"] };
let BDAYS = null, BD_MISSING = [], bdLocked = false;
function takeKeyFromHash() {
  const m = /[#&]bkey=([^&]+)/.exec(location.hash);
  if (!m) return false;
  store.set("wx.bkey", decodeURIComponent(m[1]));
  history.replaceState(null, "", location.pathname + location.search);   // don't leave it in the address bar
  return true;
}
takeKeyFromHash();
// Opening the setup link on an already-open board only changes the hash.
addEventListener("hashchange", () => { if (takeKeyFromHash()) loadBirthdays(); });
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function loadBirthdays() {
  const pass = store.get("wx.bkey", null);
  if (!pass) { bdLocked = true; return renderBirthdays(); }
  try {
    const e = await (await fetch("/weather/birthdays.enc.json", { cache: "no-cache" })).json();
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64(e.salt), iterations: e.iter, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(e.iv) }, key, b64(e.ct));
    const data = JSON.parse(new TextDecoder().decode(plain));
    BDAYS = data.people; BD_MISSING = data.missing || [];
    bdLocked = false;
  } catch { bdLocked = true; }
  renderBirthdays();
}
// Days from today (local) to the next occurrence; Feb 29 counts as Feb 28 off-year.
function daysUntil(p, from = new Date()) {
  const t0 = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (const y of [t0.getFullYear(), t0.getFullYear() + 1]) {
    let d = new Date(y, p.m - 1, p.d);
    if (d.getMonth() !== p.m - 1) d = new Date(y, 1, 28);
    if (d >= t0) return Math.round((d - t0) / 864e5);
  }
  return 366;
}
const prio = p => GROUPS[p.g]?.[0] ?? 3;
const bdWhen = n => n === 0 ? "Today" : n === 1 ? "Tomorrow" : n < 7 ? new Date(Date.now() + n * 864e5).toLocaleDateString("en-GB", { weekday: "long" }) : `in ${n} days`;
const bdDate = p => new Date(2000, p.m - 1, p.d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const ageOn = (p, n) => p.y ? ` · turns ${new Date(Date.now() + n * 864e5).getFullYear() - p.y}` : "";
// Only family gets a badge; the wedding parties still sort first, unlabelled.
function bdRow(p, n, big = false, when = bdWhen(n)) {
  return `<div class="bd${big ? " big" : ""}"><span class="who"><b>${esc(p.n)}</b>
    <small>${p.g === "family" ? `<span class="grp g-family">Family</span>` : ""}${bdDate(p)}${n >= 0 ? ageOn(p, n) : ""}</small></span>
    <span class="when${n === 0 ? " today" : ""}">${when}</span></div>`;
}
// Days since the most recent occurrence (0 today, up to 365).
const daysSince = p => { const n = daysUntil(p); return n === 0 ? 0 : 365 - n; };
function renderBirthdays() {
  const el = $("bdBody"); if (!el) return;
  if (bdLocked || !BDAYS) {
    el.innerHTML = `<div class="empty">${bdLocked ? "Locked on this device. Tap to enter the key." : "Loading…"}</div>`;
    return;
  }
  const up = BDAYS.map(p => ({ p, n: daysUntil(p) })).sort((a, b) => a.n - b.n || prio(a.p) - prio(b.p));
  const today = up.filter(x => x.n === 0);
  let html;
  if (today.length) {
    $("bdTitle").textContent = "Birthday today";
    html = today.map(x => bdRow(x.p, 0, true)).join("") + `<div class="bdnext">Next: ${up.filter(x => x.n > 0).slice(0, 2).map(x => `${esc(x.p.n)} (${bdWhen(x.n)})`).join(", ")}</div>`;
  } else {
    $("bdTitle").textContent = "Next birthdays";
    // Everyone's next few by date, then the nearest of family and the wedding
    // party if none of them made that list.
    const next = up.slice(0, 4), vip = up.filter(x => prio(x.p) < 3 && !next.includes(x)).slice(0, 2);
    html = next.map((x, i) => bdRow(x.p, x.n, i === 0)).join("") +
      (vip.length && !next.some(x => prio(x.p) < 3) ? `<div class="bdsub">Family & wedding party</div>${vip.map(x => bdRow(x.p, x.n)).join("")}` : "");
  }
  el.innerHTML = html;
}
$("bdCard").addEventListener("click", () => {
  // A Home Screen web app on iPad has its own storage and no address bar, so the
  // setup link can't reach it: let the locked card take the key directly.
  if (bdLocked) {
    const k = prompt("Birthday key");
    if (k && k.trim()) { store.set("wx.bkey", k.trim()); loadBirthdays(); }
    return;
  }
  if (!BDAYS) return;
  const up = BDAYS.map(p => ({ p, n: daysUntil(p) })).sort((a, b) => a.n - b.n || prio(a.p) - prio(b.p));
  const months = new Map();
  for (const x of up) {
    const k = new Date(Date.now() + x.n * 864e5).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    if (!months.has(k)) months.set(k, []); months.get(k).push(x);
  }
  const recent = BDAYS.map(p => ({ p, d: daysSince(p) })).filter(x => x.d >= 1 && x.d <= 30).sort((a, b) => a.d - b.d);
  const ago = d => d === 1 ? "Yesterday" : `${d} days ago`;
  openModal(`<h3>${ms("cake", "ic-sun")}Birthdays</h3><p class="lede">${BDAYS.length} guests.</p>
    ${recent.length ? `<h4>Last 30 days</h4><div class="bdlist recent">${recent.map(x => bdRow(x.p, -1, false, ago(x.d))).join("")}</div>` : ""}
    ${[...months].map(([k, xs]) => `<h4>${k}</h4><div class="bdlist">${xs.map(x => bdRow(x.p, x.n)).join("")}</div>`).join("")}
    ${BD_MISSING.length ? `<h4>No birthday yet · ${BD_MISSING.length}</h4><div class="bdmissing">${BD_MISSING.map(m =>
      `<span>${esc(m.n)}${m.g === "family" ? ` <span class="grp g-family">Family</span>` : ""}</span>`).join("")}</div>` : ""}`);
});
// The day rolls over at midnight; the minute timer below keeps "Tomorrow" honest.
setInterval(() => { if (!document.hidden) renderBirthdays(); }, 10 * 60e3);

// ---------- keep the screen on, keep everything fresh ----------
let wakeLock = null;
async function keepAwake() {
  try { if (!wakeLock && navigator.wakeLock && !document.hidden) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch {}
}
document.addEventListener("pointerdown", keepAwake, { passive: true });   // iOS wants a gesture first

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  keepAwake();
  if (Date.now() - wxAt > WX_MS) { loadWeather(); loadAir(); }
  renderBirthdays();
  loadDeps();
});
setInterval(() => { if (!document.hidden) loadWeather(); }, WX_MS);
setInterval(() => { if (!document.hidden) loadAir(); }, AQ_MS);
setInterval(() => { if (!document.hidden) loadDeps(); }, DEP_MS);
setInterval(() => { if (!document.hidden) locate(); }, LOC_MS);
// Charts and "in 2h 10m" drift; redraw the cheap bits each minute.
setInterval(() => {
  if (!WX || document.hidden) return;
  renderSummary(); renderNowcast(); renderHourly();
}, 60e3);
// A wall screen left for days: reload once overnight to pick up deploys.
(function nightlyReload() {
  const d = new Date(), t = new Date(d); t.setHours(3, 30, 0, 0); if (t <= d) t.setDate(t.getDate() + 1);
  setTimeout(() => location.reload(), t - d);
})();
let _rs; addEventListener("resize", () => { clearTimeout(_rs); _rs = setTimeout(() => { if (WX) { renderHourly(); renderDays(); } }, 150); });
// The icon font arriving changes nothing in layout, but chart glyphs drawn before it
// loads can render as their ligature names in Safari; redraw once it's in.
document.fonts?.ready.then(() => { if (WX) renderHourly(); });

// ---------- boot ----------
(function init() {
  setPlace(PLACE);
  const cached = store.get("wx.cache", null);
  if (cached) { WX = cached; TZ = WX.timezone; renderWeather(); $("stamp").textContent = "Refreshing…"; }
  loadWeather(); loadAir(); loadStations(); loadBirthdays();
  locate();
  keepAwake();
})();

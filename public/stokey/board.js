/* One board engine, two modes. Walk = Weaver + buses; Cycle = trains only.
   The header, weather, clock, chips, cards, focus state and polling are shared;
   the map layer differs (bus roads vs rail lines) so it is mode-branched but
   driven by the same shared state. Both datasets are prefetched, so the
   Walk|Cycle toggle switches instantly with no network. Edit once. */

// ---------- mode + config ----------
let MODE = location.pathname.includes("/cycle") ? "cycle" : "walk";
const HOME = [51.5611161, -0.0739865];
const REFRESH_MS = 60000;
const RAIL_STOP = "910GSTKNWNG";   // walk: the one Weaver station on the board
const RAIL_WALK_S = 348;           // walk: 491 m to Stoke Newington station

const LINE_COLOR = {
  "Weaver":"#823a62", "Mildmay":"#3a6ea5", "Windrush":"#dc241f", "Suffragette":"#57ad6d",
  "Lioness":"#c99e28", "Liberty":"#5d6067", "Victoria":"#0098d4", "Piccadilly":"#0a338c",
  "Northern":"#111", "Central":"#e32017", "Elizabeth line":"#6950a1", "Elizabeth":"#6950a1",
  "Greater Anglia":"#d70428", "Great Northern":"#0a493e", "Thameslink":"#e05aa6",
  // Rest of the tube + a few NR operators, so journey-planner legs get their real colour.
  "Bakerloo":"#b36305", "Circle":"#ffd300", "District":"#00782a", "Hammersmith & City":"#f3a9bb",
  "Jubilee":"#a0a5a9", "Metropolitan":"#9b0056", "Waterloo & City":"#95cdba", "DLR":"#00a4a7",
  "Tram":"#5fb130", "Heathrow Express":"#532e63", "Southern":"#8cc63f", "Southeastern":"#389cff",
  "South Western Railway":"#24215e", "c2c":"#b6153c", "Chiltern Railways":"#00bfff",
};
// Walk colours a line by kind (bus red, night blue, Weaver purple); cycle by brand.
function colorOf(line){
  if(line === "Weaver") return "#823a62";
  if(LINE_COLOR[line]) return LINE_COLOR[line];
  if(String(line).startsWith("N")) return "#1b2a6b";
  return "#e1251b";
}

const CFG = {
  walk: {
    api:"/api/board/stokey", geo:"/stokey/geo.json", fleet:"/api/fleet/stokey",
    lines:["Weaver","67","73","76","106","149","243","276","393","476","N73"],
    defaultLines:["Weaver"], hasBuses:true, hasFleet:true, hasArrows:true, status:false,
    openZoom:15,
  },
  cycle: {
    api:"/api/board/cycle", geo:"/stokey/cycle/geo.json", fleet:null,
    lines:["Weaver","Victoria","Piccadilly","Mildmay","Windrush","Suffragette","Great Northern","Thameslink","Greater Anglia"],
    // Every line is a train you might take, so the default lists them all (grouped);
    // tapping a chip narrows to one line and expands to one card per vehicle.
    defaultLines:["Weaver","Victoria","Piccadilly","Mildmay","Windrush","Suffragette","Great Northern","Thameslink","Greater Anglia"],
    hasBuses:false, hasFleet:false, hasArrows:false, status:true,
    openZoom:14,
  },
};
let C = CFG[MODE];
let SERVICES = C.lines;
let DEFAULT_LINES = C.defaultLines;

// ---------- small helpers ----------
const pad = n => String(n).padStart(2, "0");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const to12h = d => d.toLocaleTimeString("en-US",
  {hour:"numeric", minute:"2-digit", hour12:true, timeZone:"Europe/London"})
  .replace(" ", "").replace("AM", "am").replace("PM", "pm");
const hhmm = epoch => to12h(new Date(epoch * 1000));
const clockTime = iso => iso ? to12h(new Date(iso)) : "";
const walkMins = m => Math.max(1, Math.round(m));

function shortStop(s){
  const first = String(s ?? "").split("/")[0].trim();
  return first.replace(/^Stoke Newington\s+/i, "") || first;
}
// A physical bus stop only ever serves one direction; the first of its `towards`
// destinations names it. "Clapton Pond Or Stoke Newington Common" -> "Clapton Pond".
function shortTowards(t){
  return String(t ?? "").split(/\s+Or\s+|,/i)[0].trim();
}
function shortDest(name){
  const norm = s => s.replace(/,\s*/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\s+Rail Station$/i, "").replace(/\s+Bus Station$/i, " Bus Stn").replace(/\s+Station$/i, " Stn");
  const s = norm(String(name ?? "—"));
  if(s.length <= 24 || !s.includes("/")) return s;
  const parts = s.split("/").map(norm);
  return parts.find(p => /\bStn\b/.test(p)) ?? parts[0];
}
const plat = p => (p && p !== "—") ? esc(p.replace(/^Platform\s+/i, "Plat ")) : "";

// ---------- clock ----------
function tickClock(){
  const d = new Date();
  let h = d.getHours(); const ampm = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  clock.innerHTML = `${h}:${pad(d.getMinutes())}<span class="sec">:${pad(d.getSeconds())}</span><span class="ampm"> ${ampm}</span>`;
}
setInterval(tickClock, 1000); tickClock();

// ---------- weather (shared, the rich walk version) ----------
const WMO = {
  0:["☀️","🌙","Clear"], 1:["🌤️","🌙","Mostly clear"], 2:["⛅","☁️","Partly cloudy"], 3:["☁️","☁️","Overcast"],
  45:["🌫️","🌫️","Fog"], 48:["🌫️","🌫️","Rime fog"],
  51:["🌦️","🌦️","Light drizzle"], 53:["🌦️","🌦️","Drizzle"], 55:["🌦️","🌦️","Heavy drizzle"],
  56:["🌧️","🌧️","Freezing drizzle"], 57:["🌧️","🌧️","Freezing drizzle"],
  61:["🌦️","🌦️","Light rain"], 63:["🌧️","🌧️","Rain"], 65:["🌧️","🌧️","Heavy rain"],
  66:["🌧️","🌧️","Freezing rain"], 67:["🌧️","🌧️","Freezing rain"],
  71:["🌨️","🌨️","Light snow"], 73:["🌨️","🌨️","Snow"], 75:["❄️","❄️","Heavy snow"], 77:["❄️","❄️","Snow grains"],
  80:["🌦️","🌦️","Showers"], 81:["🌧️","🌧️","Showers"], 82:["⛈️","⛈️","Violent showers"],
  85:["🌨️","🌨️","Snow showers"], 86:["❄️","❄️","Snow showers"],
  95:["⛈️","⛈️","Thunderstorm"], 96:["⛈️","⛈️","Thunder, hail"], 99:["⛈️","⛈️","Thunder, hail"],
};
const wmoIcon = (code, isDay) => (WMO[code] ?? ["🌡️","🌡️","—"])[isDay ? 0 : 1];
const wmoLabel = code => (WMO[code] ?? ["","","—"])[2];
function renderWeather(w){
  if(w === undefined){ wx.innerHTML = ""; return; }          // not loaded yet
  if(!w){ wx.innerHTML = `<div class="meta" style="color:var(--bad)">⚠ weather unavailable</div>`; return; }
  // The day's HIGH is the number that matters at a glance in the morning, so it's the big
  // one; the low sits beside it and the current temp is the small line below.
  const r = Math.round;
  wx.innerHTML = `
    <div class="now"><span class="icon">${wmoIcon(w.code, w.isDay)}</span>
      ${w.maxC != null
        ? `<span class="temp hi">${r(w.maxC)}°</span><span class="templo lo">${r(w.minC)}°</span>`
        : `<span class="temp">${r(w.tempC)}°</span>`}</div>
    <div class="meta">${esc(wmoLabel(w.code))}<br>now ${r(w.tempC)}°</div>`;
}

// ---------- weather modal ----------
// Tap the header weather to open a fuller forecast: current detail, the next 24
// hours, and the 7-day outlook.
const wxModal = document.createElement("div");
wxModal.className = "wxmodal"; wxModal.hidden = true;
document.body.appendChild(wxModal);
wxModal.addEventListener("click", e => {
  if(e.target === wxModal || e.target.closest(".wxclose")) wxModal.hidden = true;
});
document.addEventListener("keydown", e => { if(e.key === "Escape") wxModal.hidden = true; });
wx.style.cursor = "pointer";
wx.addEventListener("click", () => { if(MB?.weather){ renderWxModal(MB.weather); wxModal.hidden = false; } });

const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function renderWxModal(w){
  const hrs = (w.hours ?? []).map(h => `
    <div class="wxh"><span class="t">${hhmm(h.at).replace(/:\d\d/,"")}</span>
      <span class="i">${wmoIcon(h.code, h.isDay)}</span>
      <b>${Math.round(h.tempC)}°</b>
      <span class="p">${h.pop > 0 ? h.pop + "%" : ""}</span></div>`).join("");
  const days = (w.days ?? []).map((d, i) => {
    const dow = DOW[new Date(d.at * 1000).getDay()];
    return `<div class="wxd"><span class="dn">${i === 0 ? "Today" : dow}</span>
      <span class="i">${wmoIcon(d.code, true)}</span>
      <span class="pp">${d.pop > 0 ? d.pop + "%" : ""}</span>
      <span class="hl"><b>${Math.round(d.maxC)}°</b> <span class="lo">${Math.round(d.minC)}°</span></span></div>`;
  }).join("");
  wxModal.innerHTML = `<div class="wxsheet">
    <button class="wxclose" aria-label="Close">&times;</button>
    <div class="wxnow">
      <span class="bigicon">${wmoIcon(w.code, w.isDay)}</span>
      <div class="bignow"><div class="bigtemp">${Math.round(w.tempC)}°</div>
        <div class="cond">${esc(wmoLabel(w.code))}</div></div>
      <div class="wxstats">
        ${w.feelsC != null ? `<div>Feels like <b>${Math.round(w.feelsC)}°</b></div>` : ""}
        ${w.windKph != null ? `<div>Wind <b>${w.windKph} km/h</b></div>` : ""}
        ${w.humidity != null ? `<div>Humidity <b>${w.humidity}%</b></div>` : ""}
        <div>Today <b>${Math.round(w.maxC)}°</b> / ${Math.round(w.minC)}°</div>
      </div>
    </div>
    <div class="wxsec">Next 24 hours</div>
    <div class="wxhours">${hrs}</div>
    <div class="wxsec">7-day forecast</div>
    <div class="wxdays">${days}</div>
  </div>`;
}

// ---------- countdown ----------
function countdown(iso, fallbackMin){
  if(!iso) return {text: fallbackMin === 0 ? "Due" : `${fallbackMin} min`, secs: fallbackMin * 60};
  const secs = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if(secs <= 0) return {text: "Due", secs: 0};
  return {text: `${Math.floor(secs / 60)}:${pad(secs % 60)}`, secs};
}
const reachable = (secs, thresholdS) => secs >= thresholdS;
function pinEta(iso, fallbackMin){
  if(fallbackMin == null && !iso) return "";
  if(!iso) return fallbackMin === 0 ? "Due" : `${fallbackMin}m`;
  const secs = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const m = Math.round(secs / 60);
  return m <= 0 ? "Due" : `${m}m`;
}

// ---------- normalized model ----------
// raw[mode] holds each mode's raw payload (for that mode's map engine); MB is the
// active mode's payload normalized into shared rows + pins.
const raw = {walk:null, cycle:null};
const geoCache = {walk:null, cycle:null};
let board = null;   // raw payload for the ACTIVE mode (walk map funcs read this)
let MB = null;      // {rows, pins, status, weather, ts}

function normalize(mode, p){
  if(!p) return null;
  if(mode === "walk"){
    const rows = [];
    for(const r of (p.rail ?? [])) rows.push({
      line:"Weaver", mode:"rail", to:r.to, london:r.london, stopId:RAIL_STOP,
      plat:r.plat, walkMin:RAIL_WALK_S/60, cycMin:null,
      scheduled:r.scheduled, delayMin:r.delayMin, cancelled:r.cancelled,
      etaMin:r.etaMin, expected:r.expected, vehicleId:r.vehicleId,
      key:`rail|${r.to}`, reachSecs:RAIL_WALK_S,
    });
    for(const r of (p.buses ?? [])) rows.push({
      line:r.line, mode:"bus", to:r.to, london:r.london, stopId:r.stopId,
      stop:r.stop, letter:r.letter, walkMin:r.walkMin, cycMin:null, plat:null,
      etaMin:r.etaMin, expected:r.expected, vehicleId:r.vehicleId,
      key:`bus|${r.line}|${r.dir}`, dir:r.dir, reachSecs:Math.round(r.walkMin*60),
    });
    const pins = (p.vehicles ?? []).map(v => ({...v, serving:true}));
    return {rows, pins, status:p.status ?? [], weather:p.weather, ts:p.ts};
  }
  // cycle. Reachability is the cycle time to THIS station, not the board's radius,
  // so a train 4:41 away at a 1.6-min-cycle station is not flagged unreachable.
  const mk = (r, london) => ({
    line:r.line, lineId:r.lineId, mode:"rail", to:r.to, london,
    stopId:r.stationId, station:r.station, cycMin:r.cycMin, walkMin:null, plat:r.plat,
    dir:r.dir, etaMin:r.etaMin, expected:r.expected, vehicleId:r.vehicleId,
    scheduled:r.scheduled ?? null, delayMin:r.delayMin ?? null, cancelled:!!r.cancelled,
    key:`${r.lineId}|${r.to}|${r.stationId}`, reachSecs:Math.round((r.cycMin || 0) * 60),
  });
  const rows = [...(p.into ?? []).map(r => mk(r, "in")), ...(p.out ?? []).map(r => mk(r, "out"))];
  // Pin key matches its row's group key so focus/stop/vehicle taps resolve it.
  const pins = (p.pins ?? []).map(v => ({...v, mode:"rail", serving:true,
    key:`${v.lineId}|${v.to}|${v.stationId ?? ""}`}));
  return {rows, pins, status:p.status ?? [], weather:p.weather, ts:p.ts, cycMin:p.cycMin, pinsTimedOut:!!p.pinsTimedOut};
}

// ---------- filtering state ----------
let selected = new Set(SERVICES);
let tableAll = false;
let focus = null;   // {kind:"route"|"vehicle"|"dir"|"stop", ...}

const mapNarrowed = () => selected.size !== SERVICES.length;
function hasRail(){ return (MB?.rows ?? []).some(r => r.mode === "rail"); }
function effectiveTableAll(){
  if(tableAll) return true;
  // Default column is the Weaver alone; if it's empty, fall back to All.
  return !(MB?.rows ?? []).some(r => DEFAULT_LINES.includes(r.line));
}
function tableLines(){
  if(mapNarrowed()) return selected;
  if(focus && focus.kind === "stop") return new Set(SERVICES);
  return new Set(effectiveTableAll() ? SERVICES : DEFAULT_LINES);
}
const tableNarrowed = () => tableLines().size !== SERVICES.length;
function expanded(){ return tableNarrowed(); }
const lineOf = g => g.line;
const shown = g => tableLines().has(lineOf(g));

// ---------- grouping ----------
function groupsFor(dir){
  const rows = (MB?.rows ?? []).filter(r => r.london === dir).filter(shown);
  if(expanded()) return rows.map(r => ({...r, etas:[{min:r.etaMin, exp:r.expected}], one:true}));
  const m = new Map();
  for(const r of rows){
    if(!m.has(r.key)) m.set(r.key, {...r, etas:[]});
    m.get(r.key).etas.push({min:r.etaMin, exp:r.expected});
  }
  return [...m.values()];
}
function allGroups(){ return ["in","out"].flatMap(groupsFor); }
const departsAt = g => g.etas[0].exp ? Date.parse(g.etas[0].exp) : Date.now() + g.etas[0].min * 60000;

// ---------- focus resolution ----------
function focusSets(){
  const keys = new Set(), stops = new Set();
  if(!focus || !MB) return {keys, stops, veh:null, active:false};
  for(const g of allGroups().filter(shown)){
    const hit = focus.kind === "vehicle" ? g.vehicleId === focus.id
              : focus.kind === "route"   ? g.key === focus.key
              : focus.kind === "dir"     ? g.london === focus.dir
              :                            g.stopId === focus.id;
    if(hit){ keys.add(g.key); stops.add(g.stopId); }
  }
  return {keys, stops, veh: focus.kind === "vehicle" ? focus.id : null, active:true};
}
let FS = {keys:new Set(), stops:new Set(), active:false};
const focusMatchesRow = g => !FS.active ? true : FS.veh ? g.vehicleId === FS.veh : FS.keys.has(g.key);
function focusStillVisible(){
  return allGroups().filter(shown).some(g =>
    focus.kind === "vehicle" ? g.vehicleId === focus.id
    : focus.kind === "route" ? g.key === focus.key
    : focus.kind === "dir"   ? g.london === focus.dir
    : g.stopId === focus.id);
}

// ---------- rows ----------
const TRAIN_GLYPH = `<svg viewBox="0 0 24 24" width="19" height="19" fill="#fff" aria-hidden="true"><path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h12v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4ZM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3.5-7H6V6h5v4Zm2 0V6h5v4h-5Zm3.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/></svg>`;
const WARN_GLYPH = `<span class="warn" title="Not enough time to get there">⚠</span> `;

// Fixed-width badges so the columns line up. Walk's Weaver is the train glyph;
// a bus is its number; a cycle rail line is a short colour-coded abbreviation.
const ABBR = {
  "Weaver":"Weav", "Victoria":"Vic", "Piccadilly":"Picc", "Mildmay":"Mild",
  "Windrush":"Wind", "Suffragette":"Suff", "Lioness":"Lion", "Liberty":"Lib",
  "Great Northern":"GN", "Thameslink":"TL", "Greater Anglia":"GA",
  "Northern":"Nor", "Central":"Cen", "Elizabeth line":"Liz",
};
function badgeHTML(g){
  const col = colorOf(g.line);
  if(g.mode === "rail" && MODE === "walk")
    return `<div class="badge glyph" style="background:${col}" title="${esc(g.line)}">${TRAIN_GLYPH}</div>`;
  if(g.mode === "rail")
    return `<div class="badge abbr" style="background:${col}" title="${esc(g.line)}">${esc(ABBR[g.line] ?? g.line.slice(0,4))}</div>`;
  return `<div class="badge" style="background:${col}">${esc(g.line)}</div>`;
}

// The delay treatment (struck schedule, late in red) for the right-hand column.
function railTimeHTML(g){
  if(!g.scheduled) return clockTime(g.expected);
  const sched = clockTime(g.scheduled);
  // Delay: scheduled (struck) stacked above the new time, so it stays one time wide.
  if(g.cancelled) return `<span class="delay"><s>${sched}</s><span class="cancelled">Canc.</span></span>`;
  if(g.delayMin >= 1) return `<span class="delay"><s>${sched}</s><span class="late">${clockTime(g.expected)}</span></span>`;
  return `<span class="ontime">${sched}</span>`;
}

function subHTML(g){
  if(g.mode === "rail" && MODE === "walk")
    return `${walkMins(g.walkMin)} min walk${plat(g.plat) ? " · " + plat(g.plat) : ""}`;
  if(g.mode === "rail")   // cycle
    return `${esc(g.station)} · ${g.cycMin} min cycle${g.plat && g.plat !== "—" ? " · " + esc(g.plat) : ""}`;
  return `${esc(shortStop(g.stop))}${g.letter ? " (" + esc(g.letter) + ")" : ""} · ${walkMins(g.walkMin)} min walk`;
}

function rowHTML(g){
  const first = g.etas[0];
  const cd = countdown(first.exp, first.min);
  const walkS = g.reachSecs;
  const miss = !reachable(cd.secs, walkS);
  // Right column. One-per-vehicle: the clock time (rail shows delay struck through);
  // grouped: the next couple of ETAs in minutes.
  // Grouped: always two "next" slots, dashed when absent, so the big ETA column
  // stays vertically aligned down the list.
  const rest = g.one
    ? (g.mode === "rail" ? railTimeHTML(g) : clockTime(first.exp))
    : `${g.etas[1] ? g.etas[1].min : "–"} · ${g.etas[2] ? g.etas[2].min : "–"}`;
  return `
    <div class="row ${g.cancelled ? "off" : ""} ${miss ? "unreachable" : ""} ${focusMatchesRow(g) ? "" : "dim"}"
         data-key="${esc(g.key)}" data-stop="${esc(g.stopId ?? "")}"
         ${g.one && g.vehicleId ? `data-veh="${esc(g.vehicleId)}"` : ""}>
      ${badgeHTML(g)}
      <div class="mid">
        <div class="to">${esc(shortDest(g.to))}</div>
        <div class="from">${WARN_GLYPH}${subHTML(g)}</div>
      </div>
      <div class="etas">
        <span class="n ${cd.secs === 0 ? "due" : ""}" data-exp="${first.exp || ""}" data-min="${first.min}" data-walk="${walkS}">${cd.text}</span>
        <span class="rest">${rest}</span>
      </div>
    </div>`;
}

function renderDirection(dir, listEl, countEl){
  const atStop = focus && focus.kind === "stop" ? focus.id : null;
  const groups = groupsFor(dir)
    .filter(g => !atStop || g.stopId === atStop)
    // Drop anything already "Due" — you can't reach it, so it's just clutter.
    // (The live vehicle still shows as a pin on the map.)
    .filter(g => countdown(g.etas[0].exp, g.etas[0].min).secs > 0)
    .sort((a,b) => departsAt(a) - departsAt(b));
  countEl.textContent = groups.length ? `${groups.length} ${expanded() ? "departures" : "routes"}` : "";
  listEl.innerHTML = groups.length ? groups.map(rowHTML).join("") : '<div class="empty">Nothing due.</div>';
  listEl.closest(".panel").classList.toggle("novalue", groups.length === 0);
}

function tickETAs(){
  for(const el of document.querySelectorAll(".pineta")){
    el.textContent = pinEta(el.dataset.exp || null, el.dataset.min === "" ? null : +el.dataset.min);
  }
  for(const el of document.querySelectorAll(".etas .n[data-exp]")){
    const c = countdown(el.dataset.exp || null, +el.dataset.min);
    const row = el.closest(".row");
    if(c.secs <= 0){ if(row) row.remove(); continue; }   // ticked to Due — drop it
    el.textContent = c.text; el.classList.toggle("due", c.secs === 0);
    if(row) row.classList.toggle("unreachable", !reachable(c.secs, +el.dataset.walk));
  }
}
setInterval(tickETAs, 1000);

// ---------- layout ----------
function focusedSide(){
  if(focus && focus.kind === "dir") return focus.dir;
  if(!focus || focus.kind !== "route" || !MB) return null;
  for(const dir of ["in","out"]) if(groupsFor(dir).some(g => g.key === focus.key)) return dir;
  return null;
}
let layoutClass = "";
function applyLayout(){
  const side = focusedSide();
  const next = side ? `solo-${side}` : "stacked";
  if(next === layoutClass) return;
  cols.classList.remove("solo-in","solo-out","stacked");
  cols.classList.add(next);
  layoutClass = next;
  const until = Date.now() + 420;
  (function follow(){ map.invalidateSize({animate:false}); if(Date.now() < until) requestAnimationFrame(follow); })();
}

// ---------- chips ----------
// Sticky: once a line has shown departures this session its chip stays enabled,
// so a transient empty/slow fetch doesn't flash half the chips grey.
let everLive = new Set();
function linesWithDepartures(){
  if(!MB) return new Set(SERVICES);
  for(const r of (MB.rows ?? [])) everLive.add(r.line);
  return everLive;
}
function renderFilters(){
  const dead = mapNarrowed();
  const eff = effectiveTableAll();
  // Default/All only means something when the default is a subset (walk = Weaver).
  // For cycle the default already lists every line, so the switch is hidden.
  const hasToggle = DEFAULT_LINES.length !== SERVICES.length;
  const seg = hasToggle ? `<div class="seg ${dead ? "dead" : ""}" ${dead ? 'aria-disabled="true"' : ""} role="group"
       title="${dead ? "Only meaningful when every line is selected" : "What the table lists"}">
     <button data-table="0" class="${!eff ? "on" : ""}" aria-pressed="${!eff}">Default</button>
     <button data-table="1" class="${eff ? "on" : ""}" aria-pressed="${eff}">All</button>
   </div><span class="chipsep"></span>` : "";
  const live = linesWithDepartures();
  const disr = new Set((MB?.status ?? []).filter(s => !s.good).map(s => s.line));
  filters.innerHTML = seg + SERVICES.map(id => {
    const short = id.replace("Greater Anglia","Gtr Anglia").replace("Great Northern","Gt Northern");
    return `<button class="chip ${selected.has(id) ? "on" : ""}"
              data-line="${esc(id)}" style="background:${colorOf(id)}"
              ${live.has(id) ? "" : "disabled"}>${esc(short)}</button>`;
  }).join("");
}
filters.addEventListener("click", e => {
  const seg = e.target.closest(".seg button");
  if(seg){
    if(seg.parentElement.classList.contains("dead")) return;
    tableAll = seg.dataset.table === "1"; focus = null;
    renderFilters(); renderAll(); return;
  }
  const b = e.target.closest(".chip");
  if(!b || b.disabled) return;
  const id = b.dataset.line;
  if(!mapNarrowed()) selected = new Set([id]);
  else if(selected.has(id)){ selected.delete(id); if(selected.size === 0){ selected = new Set(SERVICES); tableAll = false; } }
  else selected.add(id);
  if(focus && !focusStillVisible()) focus = null;
  renderFilters(); renderAll();
});

// ---------- disruptions (header middle) ----------
// Worst first: an actual service problem outranks a bus route diversion.
const SEV_RANK = ["Suspended","Part Suspended","Closure","Part Closure","Severe Delays","Reduced Service","Minor Delays","Special Service"];
const sevRank = s => { const i = SEV_RANK.indexOf(s.severity); return i < 0 ? 50 : i; };
let disruptOpen = false;
function renderStatus(){
  const el = document.getElementById("disrupt");
  if(!el) return;
  const bad = (MB?.status ?? []).filter(s => !s.good).sort((a,b) => sevRank(a) - sevRank(b));
  if(!bad.length){ el.innerHTML = ""; disruptOpen = false; return; }
  const NR = new Set(["great-northern","thameslink","greater-anglia","southeastern"]);
  const items = bad.map(s => {
    const url = NR.has(s.lineId)
      ? "https://www.nationalrail.co.uk/status-and-disruptions/"
      : "https://tfl.gov.uk/tube-dlr-overground/status/";
    return `<a href="${url}" target="_blank" rel="noopener" title="${esc(s.reason || s.severity)}">
      <span class="dot"></span><b>${esc(s.line)}</b>&nbsp;${esc(s.severity)}${s.reason ? ` <span class="reason">— ${esc(s.reason)}</span>` : ""}</a>`;
  }).join("");
  el.innerHTML = `<button class="disruptbtn" aria-expanded="${disruptOpen}" title="Service disruptions">
      <span class="dot"></span>${bad.length} ${bad.length === 1 ? "alert" : "alerts"}</button>
    <div class="disruptpanel"${disruptOpen ? "" : " hidden"}>${items}</div>`;
  el.querySelector(".disruptbtn").onclick = (e) => {
    e.stopPropagation();
    disruptOpen = !disruptOpen;
    el.querySelector(".disruptpanel").hidden = !disruptOpen;
    el.querySelector(".disruptbtn").setAttribute("aria-expanded", String(disruptOpen));
  };
}
// Tapping anywhere outside closes the open disruptions dropdown.
document.addEventListener("click", (e) => {
  if(disruptOpen && !e.target.closest("#disrupt")){
    disruptOpen = false;
    const p = document.querySelector(".disruptpanel");
    if(p) p.hidden = true;
    const b = document.querySelector(".disruptbtn");
    if(b) b.setAttribute("aria-expanded", "false");
  }
});

// ---------- render ----------
function renderAll(){
  if(!MB) return;
  if(mapNarrowed() && ![...selected].some(l => linesWithDepartures().has(l))){
    selected = new Set(SERVICES); tableAll = false; focus = null; renderFilters();
  }
  FS = focusSets();
  for(const b of document.querySelectorAll(".only"))
    b.setAttribute("aria-pressed", String(!!focus && focus.kind === "dir" && focus.dir === b.dataset.dir));
  syncToggle(); syncChips(); renderStatus(); applyLayout();
  renderDirection("in", inList, inCount);
  renderDirection("out", outList, outCount);
  cols.classList.toggle("one-row",
    inPanel.classList.contains("novalue") !== outPanel.classList.contains("novalue"));
  renderPins(); applyMapFilter();
  if(C.hasFleet) syncFleet();
}
function syncChips(){
  const live = linesWithDepartures();
  const disr = new Set((MB?.status ?? []).filter(s => !s.good).map(s => s.line));
  for(const b of document.querySelectorAll(".chip[data-line]")){
    b.disabled = !live.has(b.dataset.line);
  }
}
function syncToggle(){
  const eff = effectiveTableAll();
  for(const b of document.querySelectorAll(".seg button")){
    const on = (b.dataset.table === "1") === eff;
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
  }
}

// ---------- interactions ----------
function onRowClick(e){
  const row = e.target.closest(".row"); if(!row) return;
  const key = row.dataset.key, veh = row.dataset.veh;
  if(veh) focus = (focus && focus.kind === "vehicle" && focus.id === veh) ? null : {kind:"vehicle", id:veh, key};
  else focus = (focus && focus.kind === "route" && focus.key === key) ? null : {kind:"route", key};
  renderAll();
}
inList.addEventListener("click", onRowClick);
outList.addEventListener("click", onRowClick);
function focusDir(dir){ focus = (focus && focus.kind === "dir" && focus.dir === dir) ? null : {kind:"dir", dir}; renderAll(); }
for(const b of document.querySelectorAll(".only"))
  b.addEventListener("click", e => { e.stopPropagation(); focusDir(b.dataset.dir); });
function focusStop(id){ focus = (focus && focus.kind === "stop" && focus.id === id) ? null : {kind:"stop", id}; renderAll(); }
function focusPin(v){
  const same = focus && focus.kind === "vehicle" && focus.id === v.vehicleId;
  if(same){ focus = null; selected = new Set(SERVICES); tableAll = false; }
  else{
    selected = new Set([v.line]); tableAll = false;
    focus = v.serving === false ? null : {kind:"vehicle", id:v.vehicleId, key:v.key};
    if(focus && !focusStillVisible()) focus = null;
  }
  renderFilters(); renderAll();
}

// ---------- map (shared shell, mode-branched layers) ----------
const map = L.map("map", {zoomControl:false, attributionControl:false, zoomSnap:0.25});
const tiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  subdomains:"abcd", maxZoom:19,
}).addTo(map);
let showPassed = false;   // toggled by the map FAB; passed/Due vehicles are grey
map.setView(HOME, C.openZoom);

// On focus, only the lines stay (dimmed) for context; every other layer — off-line
// stops, their labels, off-focus vehicle pins — is hidden outright, not just faded.
const DIM = {line:.05};
const FIT = {paddingTopLeft:[16,34], paddingBottomRight:[16,16], maxZoom:19};
const GONE = "#5a6070";
const pinLayer = L.layerGroup().addTo(map);
// Shown when the server flags that positioning timed out, so an empty map reads
// as "couldn't load" rather than "no trains".
const pinWarn = document.createElement("div");
pinWarn.className = "pinwarn"; pinWarn.hidden = true;
pinWarn.innerHTML = "&#9888; live positions unavailable";
mapPanel.appendChild(pinWarn);
const COMPASS = ["N","NE","E","SE","S","SW","W","NW"];
const compass = brg => COMPASS[Math.round((brg % 360) / 45) % 8];
const isFull = () => mapPanel.classList.contains("full");

let homeBounds = null, lastFit = null;
let fleet = [];

// Layers, rebuilt per mode:
let lineLayers = [];   // {poly, line, pair?}   pair = "line|dir" for buses
let nodeMarkers = [];  // {id, marker, lines, onBoard, rail, name, base}
let arrowMarkers = [];
let homeMarker = null;
let ROUTE_STOPS = {}, SERVICE = {};
const tempTips = [];

function operating(line, now = new Date()){
  const iv = SERVICE[line]; if(!iv) return true;
  const m = now.getHours()*60 + now.getMinutes();
  return iv.some(([a,b]) => m >= a-15 && m <= b+15);
}
const onMap = line => selected.has(line) && (mapNarrowed() || operating(line));

// Click a drawn route to filter by it, exactly like tapping its chip. On a shared
// corridor (several routes overlaid) every line within a few pixels is selected.
function filterToLinesNear(latlng){
  const p = map.latLngToLayerPoint(latlng);
  const hit = new Set();
  for(const l of lineLayers){
    let near = false;
    const check = ll => { if(!near && p.distanceTo(map.latLngToLayerPoint(ll)) < 12) near = true; };
    const walk = a => { if(Array.isArray(a)) a.forEach(walk); else check(a); };
    l.poly.eachLayer(sub => sub.getLatLngs && walk(sub.getLatLngs()));
    if(near) hit.add(l.line);
  }
  if(!hit.size) return;
  selected = hit; tableAll = false; focus = null;
  renderFilters(); renderAll();
}

function clearMapLayers(){
  for(const l of lineLayers) map.removeLayer(l.poly);
  for(const n of nodeMarkers) map.removeLayer(n.marker);
  for(const a of arrowMarkers) map.removeLayer(a.marker);
  if(homeMarker) map.removeLayer(homeMarker);
  lineLayers = []; nodeMarkers = []; arrowMarkers = []; homeMarker = null;
  pinLayer.clearLayers();
}

function showInfo(html){ infobody.innerHTML = html; mapinfo.hidden = false; }
const hideInfo = () => { mapinfo.hidden = true; };
function infoOn(marker, html){
  marker.on("click", e => { L.DomEvent.stopPropagation(e); showInfo(typeof html === "function" ? html() : html); });
  return marker;
}

function buildMap(){
  clearMapLayers();
  const geo = geoCache[MODE]; if(!geo) return;
  const of = kind => geo.features.filter(f => f.properties.kind === kind);
  SERVICE = geo.service ?? {}; ROUTE_STOPS = geo.routeStops ?? {};

  if(C.hasArrows) for(const f of of("arrow")){
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    const m = L.marker([lat, lon], {interactive:false, icon:L.divIcon({className:"", iconSize:[14,14], iconAnchor:[7,7], html:
      `<div style="width:14px;height:14px;transform:rotate(${p.bearing}deg)"><div style="width:0;height:0;margin:0 auto;border:3.5px solid transparent;border-bottom:6px solid #ff8f85"></div></div>`})}).addTo(map);
    arrowMarkers.push({marker:m, lines:p.lines, pairs:p.pairs ?? []});
  }

  for(const f of of("bus")){
    const p = f.properties;
    const poly = L.geoJSON(f, {style:{color: p.night ? "#5b6ed6" : "#e1251b",
      weight: p.night ? 2.5 : 3.5, opacity: p.night ? .45 : .6, dashArray: p.night ? "3 6" : null}}).addTo(map);
    poly.on("click", e => { L.DomEvent.stopPropagation(e); filterToLinesNear(e.latlng); });
    lineLayers.push({poly, line:p.line, pair:`${p.line}|${p.dir}`, night:p.night});
  }
  for(const f of of("rail")){
    const line = f.properties.line ?? "Weaver", col = colorOf(line);
    const poly = L.geoJSON(f, {style:{color:col, weight: MODE === "cycle" ? 3.5 : 5, opacity:.9,
      lineCap:"round", lineJoin:"round"}}).addTo(map);
    poly.on("click", e => { L.DomEvent.stopPropagation(e); filterToLinesNear(e.latlng); });
    lineLayers.push({poly, line, rail:true});
  }

  for(const f of of("stop")){
    const p = f.properties, [lon, lat] = f.geometry.coordinates, on = p.onBoard, near = p.near;
    // On-board stops are the point of the board: make them big and easy to hit. The
    // dense off-board line stops stay tiny (and get thinned out by zoom).
    const base = {radius: on ? 10 : near ? 4 : 2.5, color: on ? "#fff" : near ? "#6c7484" : "#4a5162", weight: on ? 3 : 1.5};
    const m = L.circleMarker([lat, lon], {...base, fillColor:"#0f1115", fillOpacity:1}).addTo(map);
    infoOn(m, `<b>${esc(p.name)}</b>${p.letter ? " (" + esc(p.letter) + ")" : ""}<br>
      ${p.walk_min != null ? walkMins(p.walk_min) + " min walk" : "not within a 10 min walk"}<br>${linesHTML(p)}
      ${p.towards ? `<br><span style="color:#9aa3b2">towards ${esc(p.towards)}</span>` : ""}`);
    if(on){
      m.bindTooltip(`${esc(shortStop(p.name))}${p.letter ? " " + esc(p.letter) : ""}`,
        {permanent:true, direction:"right", offset:[9,0], className:"maplabel big", interactive:true});
      const tapStop = e => { L.DomEvent.stopPropagation(e); focusStop(p.id); };
      m.on("click", tapStop);
      m.on("tooltipopen", ev => ev.tooltip.getElement()?.addEventListener("click", tapStop));  // label counts as a tap target
    }
    nodeMarkers.push({id:p.id, marker:m, lines:p.lines, onBoard:on, rail:false, name:p.name, base,
      label: on ? `${shortStop(p.name)}${p.letter ? " " + p.letter : ""}` : "",
      towards: shortTowards(p.towards),   // bus stops are one-direction; shown when focused
      dense: !on && !near});  // an intermediate stop on a route; thinned out when zoomed out
  }
  for(const f of of("station")){
    const p = f.properties, [lon, lat] = f.geometry.coordinates, on = p.onBoard;
    let m;
    if(MODE === "walk"){
      const size = on ? 20 : 9;
      m = L.marker([lat, lon], {icon:L.divIcon({className:"", iconSize:[size,size], html:
        `<div style="width:${size}px;height:${size}px;background:#823a62;border:${on?3:1.5}px solid ${on?"#fff":"#8a6d7c"};border-radius:4px"></div>`})}).addTo(map);
    }else{
      m = L.circleMarker([lat, lon], {radius: on ? 10 : 3.5, color: on ? "#fff" : "#5a6472", weight: on ? 3 : 1.5, fillColor:"#0f1115", fillOpacity:1}).addTo(map);
    }
    infoOn(m, `<b>${esc(p.name)}</b><br>${MODE === "walk" ? "Weaver line" : (p.lines ? esc(p.lines.join(", ")) : "")}${p.cyc_min != null ? ` · ${p.cyc_min} min cycle` : ""}${p.walk_min != null ? ` · ${walkMins(p.walk_min)} min walk` : ""}`);
    if(on){
      m.bindTooltip(esc(p.name), {permanent:true, direction:"right", offset:[11,0], className:"maplabel rail big", interactive:true});
      const tapStop = () => focusStop(p.id);
      m.on("click", tapStop);
      m.on("tooltipopen", ev => ev.tooltip.getElement()?.addEventListener("click", tapStop));  // label counts as a tap target
    }
    nodeMarkers.push({id:p.id, marker:m, lines:p.lines ?? ["Weaver"], onBoard:on, rail:true, name:p.name});
  }

  const [hlon, hlat] = of("home")[0].geometry.coordinates;
  homeMarker = L.marker([hlat, hlon], {icon:L.divIcon({className:"", iconSize:[17,17], html:
    `<div style="width:17px;height:17px;background:#20c05b;border:3px solid #0f1115;border-radius:50%;box-shadow:0 0 0 2px #20c05b"></div>`})}).addTo(map);
  infoOn(homeMarker, "<b>Home</b><br>149 Stoke Newington High St");

  const onNodes = of("stop").concat(of("station")).filter(f => f.properties.onBoard)
    .map(f => [f.geometry.coordinates[1], f.geometry.coordinates[0]]);
  homeBounds = L.latLngBounds(onNodes.length ? onNodes : [[hlat, hlon]]).extend([hlat, hlon]).pad(0.08);
  lastFit = null;
  map.fitBounds(homeBounds, FIT);
}

function linesHTML(p){
  const lines = p.lines ?? [];
  if(!p.onBoard) return lines.map(esc).join(", ");
  const own = new Set(p.primaryLines ?? []);
  const html = lines.map(l => own.has(l) ? `<b>${esc(l)}</b>` : `<span style="color:#6c7484">${esc(l)}</span>`).join(", ");
  const others = lines.filter(l => !own.has(l));
  return html + (others.length ? `<br><span style="color:#6c7484;font-size:11px">grey: a nearer stop serves these</span>` : "");
}

// which route-directions / lines the map is "about"
function activeLines(){
  if(!mapNarrowed() && !focus && !isFull()) return new Set();
  if(focus && (focus.kind === "route" || focus.kind === "vehicle")){
    const g = allGroups().find(x => x.key === focus.key);
    if(g) return new Set([g.line]);
    // A focused vehicle may have no board row (gone past, or a different dest);
    // fall back to the pin's own line so the line never vanishes underneath it.
    if(focus.kind === "vehicle"){
      const p = allPins().find(v => v.vehicleId === focus.id);
      if(p) return new Set([p.line]);
    }
    return new Set();
  }
  if(focus && (focus.kind === "dir" || focus.kind === "stop")){
    const s = new Set();
    for(const g of allGroups().filter(shown)){
      if(focus.kind === "dir" ? g.london === focus.dir : g.stopId === focus.id)
        if(onMap(g.line)) s.add(g.line);
    }
    return s;
  }
  return new Set(SERVICES.filter(onMap));
}

// ---------- pins ----------
const BUS_GLYPH = `<svg viewBox="0 0 24 24" width="13" height="13" fill="#fff" aria-hidden="true"><path d="M4 16c0 .88.39 1.67 1 2.22V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4S4 2.5 4 6v10Zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM18 11H6V6h12v5Z"/></svg>`;
const TRAIN_GLYPH_SM = TRAIN_GLYPH.replace('width="19" height="19"', 'width="13" height="13"');

function allPins(){
  const rows = (MB?.pins ?? []);
  const seen = new Set(rows.map(v => v.vehicleId));
  return rows.concat(fleet.filter(v => !seen.has(v.vehicleId)).map(v => ({...v, serving:false})));
}
// Passed = a fleet vehicle already gone by, OR a train now Due (dropped from the
// table). Passed pins are grey and hidden unless the map's toggle is on.
const isPassed = v => v.serving === false || countdown(v.expected, v.etaMin).secs <= 0;
function renderPins(){
  pinLayer.clearLayers();
  if(typeof JP !== "undefined" && JP.active){ pinWarn.hidden = true; return; }  // journey planner owns the map
  pinWarn.hidden = !(MB && MB.pinsTimedOut);
  const isMine = v => !FS.active ? true : FS.veh ? v.vehicleId === FS.veh : FS.keys.has(v.key);
  // When focused, off-focus pins are hidden entirely (only lines stay, dimmed).
  const keep = v => onMap(v.line) && (showPassed || !isPassed(v)) && isMine(v);
  for(const v of allPins().filter(keep)){
    const rail = v.mode === "rail";
    const night = String(v.line).startsWith("N");
    const gone = isPassed(v);
    const col = colorOf(v.line);
    const bg = gone ? GONE : col;
    const arrow = gone ? "#8a90a0" : col;
    const glyph = rail ? TRAIN_GLYPH_SM : BUS_GLYPH;
    const label = v.line;   // rail and bus both labelled by line
    const eta = pinEta(v.expected, v.etaMin);
    const icon = L.divIcon({className:"", iconSize:[100,84], iconAnchor:[50,52], html:
      `<div style="width:100px;height:84px;position:relative">
         <div style="position:absolute;left:50px;top:0;transform:translateX(-50%);white-space:nowrap;
                     background:${bg};color:#fff;font:800 9.5px/1 system-ui;padding:3px 5px;border-radius:4px;border:1px solid #0f1115">
           ${esc(label)}${eta ? ` <span class="pineta" data-exp="${v.expected ?? ""}" data-min="${v.etaMin ?? ""}" style="font-weight:600;opacity:.85">${esc(eta)}</span>` : ""}
         </div>
         <div style="position:absolute;left:37px;top:39px;width:26px;height:26px;border-radius:50%;
                     background:${bg};border:2px solid #0f1115;box-shadow:0 0 0 1.5px ${arrow};display:grid;place-items:center">${glyph}</div>
         <div style="position:absolute;left:18px;top:20px;width:64px;height:64px;transform:rotate(${v.bearing}deg);pointer-events:none">
           <div style="width:0;height:0;margin:0 auto;border:5px solid transparent;border-bottom:9px solid ${arrow}"></div>
         </div>
       </div>`});
    const when = v.etaMin == null ? "already past your stop"
      : `${eta === "Due" ? "Due" : eta.replace("m"," min")} at ${esc(shortStop(v.stop ?? v.station ?? "your stop"))}`;
    // Soonest on top: among live vehicles the one with the lowest ETA wins, so
    // several stacked at a terminus show the next-to-depart in front.
    const z = gone ? 300 : 2000 - Math.min(v.etaMin ?? 999, 999);
    const marker = L.marker([v.lat, v.lon], {icon, zIndexOffset: z, vehicleId:v.vehicleId}).addTo(pinLayer);
    infoOn(marker, `<b>${esc(v.line)} → ${esc(shortDest(v.to))}</b><br>${when}<br>
      <span style="color:#9aa3b2">heading ${compass(v.bearing)} · estimated position · ${esc(v.vehicleId)}</span>`);
    marker.on("click", () => focusPin(v));
  }
}

// ---------- map filtering ----------
function applyMapFilter(){
  if(typeof JP !== "undefined" && JP.active){   // planner mode: hide the board's own layers
    for(const l of lineLayers) l.poly.setStyle({opacity:0});
    for(const a of arrowMarkers) a.marker.setOpacity(0);
    for(const s of nodeMarkers){ if(s.marker.setOpacity) s.marker.setOpacity(0); else s.marker.setStyle({opacity:0, fillOpacity:0}); const t = s.marker.getTooltip && s.marker.getTooltip(); if(t && t.getElement()) t.getElement().style.opacity = 0; }
    if(homeMarker) homeMarker.setOpacity(0);
    return;
  }
  const focused = FS.active;
  const active = activeLines();
  const attention = focused || active.size > 0;
  for(const l of lineLayers){
    const on = onMap(l.line);
    // Focused: a bus line-layer is "mine" if its exact route-direction is focused;
    // a rail line-layer is "mine" if the focused line matches. Narrowed (no focus):
    // dim lines that aren't in the active set.
    const dim = focused ? (l.pair ? !FS.keys.has(`bus|${l.pair}`) : !active.has(l.line))
                        : (active.size > 0 && !active.has(l.line));
    const base = l.rail ? (MODE === "cycle" ? .85 : .95) : (l.night ? .45 : .6);
    l.poly.setStyle({
      opacity: !on ? 0 : dim ? DIM.line : attention ? .95 : base,
      weight: l.rail ? (MODE === "cycle" ? 3.5 : 5)
                     : (!dim && attention ? (l.night ? 3.5 : 4.5) : (l.night ? 2.5 : 3.5)),
    });
  }
  for(const a of arrowMarkers){
    const live = a.lines.some(onMap);
    const mine = !focused || a.pairs.some(pr => FS.keys.has(`bus|${pr}`));
    a.marker.setOpacity(!live ? 0 : !mine ? 0 : .9);
  }
  const zoom = map.getZoom();
  for(const s of nodeMarkers){
    const serves = s.lines.some(onMap);
    const mine = s.lines.some(l => active.has(l)) || FS.stops.has(s.id);
    // Non-relevant nodes are hidden outright when focused/narrowed (not dimmed), so
    // only the lines carry the context. A hidden node is o=0. Dense intermediate
    // stops also drop out when zoomed out, unless we're zoomed in or focused on them.
    const off = !serves || (attention && !mine && !(active.size === 0 && !focused));
    const declutter = s.dense && zoom < DENSE_ZOOM && !(attention && mine);
    const o = (off || declutter) ? 0 : 1;
    if(s.marker.setOpacity) s.marker.setOpacity(o);
    else s.marker.setStyle({opacity:o, fillOpacity:o, ...(s.base ?? {})});
    // Labels: only the *relevant* stop(s) when there is a focus — a focused route
    // shows its own station, a tapped stop shows only itself. Off-focus, on-board
    // labels show normally; a bare chip filter labels the active lines' on-board stops.
    const labelOn = focused ? FS.stops.has(s.id)
                  : active.size > 0 ? (s.onBoard && s.lines.some(l => active.has(l)))
                  : s.onBoard;
    // When we're down to the relevant stop(s), spell out which way the bus goes.
    if(s.label !== undefined && s.marker.setTooltipContent){
      const showDir = labelOn && attention && !s.rail && s.towards;
      s.marker.setTooltipContent(showDir ? `${s.label} <span class="dir">→ ${esc(s.towards)}</span>` : s.label);
    }
    const tip = s.marker.getTooltip && s.marker.getTooltip();
    if(tip && tip.getElement()) tip.getElement().style.opacity = labelOn ? 1 : 0;
  }
  tiles.setOpacity(1);
  if(homeMarker) homeMarker.setOpacity(1);
  fitFocus();
}

// ---------- fit ----------
// Two behaviours, by the user's steer:
//   - vehicle focus: frame just that train and the stop it's heading for.
//   - anything else (chip filter, route/direction focus): frame the whole
//     geometry of the active line(s), always.
// Framing a whole line can otherwise fly the map right out (the 476 runs to
// Waterloo); cap how far it will zoom out so home stays legible.
const MIN_FOCUS_ZOOM = 12.5;
// Below this zoom the intermediate route stops are too dense to read, so hide them.
const DENSE_ZOOM = 15;
function fitTo(pts, sig){
  if(sig === lastFit) return;
  if(!pts.length){ return; }
  lastFit = sig;
  if(pts.length < 2){ if(homeBounds) map.fitBounds(homeBounds, {...FIT, animate:true}); return; }
  const b = L.latLngBounds(pts);
  const z = Math.max(MIN_FOCUS_ZOOM, map.getBoundsZoom(b, false, L.point(34, 50)));
  map.setView(b.getCenter(), z, {animate:true});
}
// Every focus (a vehicle, a stop, a line/direction) pans to a single fixed zoom
// centred on the thing itself — never a fit-to-bounds that flies out for a long line.
const FOCUS_ZOOM = 14;
function fitFocus(){
  if(!focus && !mapNarrowed()){
    if(lastFit !== null){ lastFit = null; if(homeBounds) map.fitBounds(homeBounds, {...FIT, animate:true}); }
    return;
  }
  const active = activeLines();
  let center = null, sig = "";
  if(FS.veh){
    const v = allPins().find(v => v.vehicleId === FS.veh);
    if(v) center = L.latLng(v.lat, v.lon);
    else { const s = nodeMarkers.find((s) => FS.stops.has(s.id)); if(s) center = s.marker.getLatLng(); }
    sig = `veh:${FS.veh}`;
  } else if(focus && focus.kind === "stop"){
    const n = nodeMarkers.find((s) => s.id === focus.id); if(n) center = n.marker.getLatLng();
    sig = `stop:${focus.id}`;
  } else {
    // Line / direction: centre on this line's board stop(s) near home, not the whole
    // route — so it lands consistently instead of framing miles of track.
    const pts = [];
    for(const s of nodeMarkers) if(s.onBoard && s.lines.some((l) => active.has(l))) pts.push(s.marker.getLatLng());
    if(pts.length) center = L.latLngBounds(pts).getCenter();
    sig = `lines:${[...active].sort().join(",")}|${focus?.kind || ""}|${focus?.id || ""}`;
  }
  if(!center || sig === lastFit) return;
  lastFit = sig;
  map.setView(center, FOCUS_ZOOM, {animate:true});
}

// ---------- fleet (walk only) ----------
let fleetToken = 0;
async function syncFleet(){
  if(!C.hasFleet) return;
  const lines = [...activeLines()].filter(l => l !== "Weaver");
  const token = ++fleetToken;
  if(!lines.length){ if(fleet.length){ fleet = []; renderPins(); } return; }
  try{
    const res = await fetch(`${C.fleet}?lines=${lines.join(",")}`, {cache:"no-store"});
    const data = res.ok ? await res.json() : {vehicles:[]};
    if(token !== fleetToken) return;
    fleet = data.vehicles ?? [];
  }catch{ if(token !== fleetToken) return; fleet = []; }
  renderPins(); applyMapFilter();
}

// Re-thin intermediate stops as the user zooms (fitFocus early-returns on the same
// focus signature, so this never fights a manual zoom).
map.on("zoomend", () => { if(geoCache[MODE]) applyMapFilter(); });

// ---------- map controls ----------
map.on("click", () => {
  if(typeof JP !== "undefined" && JP.active) return;   // planner owns the map
  hideInfo();
  const had = focus || mapNarrowed() || tableAll;
  focus = null; selected = new Set(SERVICES); tableAll = false;
  if(had){ renderFilters(); renderAll(); }
});
// FAB icons (Material, no emoji). Deferred to init() — mi() is defined later.
function setFabIcons(){
  if(typeof recentre !== "undefined") recentre.innerHTML = mi("mylocation", 19);
  if(typeof passedBtn !== "undefined") passedBtn.innerHTML = mi("recent", 19);
  if(typeof legendBtn !== "undefined") legendBtn.innerHTML = mi("info", 19);
  if(typeof fullscreen !== "undefined") fullscreen.innerHTML = mi("fullscreen", 19);
}

// Recentre: frame the whole journey while planning, else home.
if(typeof recentre !== "undefined") recentre.addEventListener("click", () => {
  if(typeof JP !== "undefined" && JP.active){ lastFit = null; jpFit(); return; }
  if(homeBounds){ lastFit = null; map.fitBounds(homeBounds, FIT); }
});
if(typeof infoclose !== "undefined") infoclose.addEventListener("click", e => {
  e.stopPropagation(); hideInfo();
  if(typeof JP !== "undefined" && JP.active) return;
  const had = focus || mapNarrowed() || tableAll;   // closing the popup also clears the focus
  focus = null; selected = new Set(SERVICES); tableAll = false;
  if(had){ renderFilters(); renderAll(); }
});
if(typeof passedBtn !== "undefined") passedBtn.addEventListener("click", () => {
  showPassed = !showPassed;
  passedBtn.setAttribute("aria-pressed", String(showPassed));
  renderPins();
});
const JP_LEGEND = `<div><span class="leg-line walk"></span> Walk</div>
  <div><span class="leg-line cycle"></span> Cycle</div>
  <div><span class="leg-line" style="background:#e1251b"></span> Bus</div>
  <div><span class="leg-line" style="background:#0098d4;height:4px"></span> Rail / tube</div>
  <div><span class="dot" style="border-color:#fff;background:#0f1115;width:11px;height:11px"></span> Change / stop</div>
  <div><span class="dot" style="border-color:#20c05b"></span> Home &nbsp;<span class="dot" style="border-color:#e6e8ee"></span> Destination</div>`;
const BOARD_LEGEND = (typeof maplegend !== "undefined" && maplegend) ? maplegend.innerHTML : "";
if(typeof legendBtn !== "undefined") legendBtn.addEventListener("click", () => {
  const open = maplegend.hidden;
  if(open) maplegend.innerHTML = (typeof JP !== "undefined" && JP.active) ? JP_LEGEND : BOARD_LEGEND;
  maplegend.hidden = !open; legendBtn.setAttribute("aria-expanded", String(open));
});
if(typeof fullscreen !== "undefined") fullscreen.addEventListener("click", () => {
  if(!mapPanel.classList.contains("full"))
    document.documentElement.style.setProperty("--chrome", `${Math.round(document.querySelector(".wrap").getBoundingClientRect().top)}px`);
  const full = mapPanel.classList.toggle("full");
  fullscreen.innerHTML = mi(full ? "fullscreen_exit" : "fullscreen", 19);
  requestAnimationFrame(() => { map.invalidateSize(); if(!full && homeBounds){ lastFit = null; map.fitBounds(homeBounds, FIT); } });
  renderAll();
});
document.addEventListener("keydown", e => { if(e.key === "Escape" && mapPanel.classList.contains("full")) fullscreen.click(); });

// ---------- data + polling ----------
let lastOk = 0;
async function loadGeo(mode){
  if(geoCache[mode]) return geoCache[mode];
  const res = await fetch(CFG[mode].geo); geoCache[mode] = await res.json(); return geoCache[mode];
}
async function fetchBoard(mode){
  const res = await fetch(CFG[mode].api, {cache:"no-store"});
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  raw[mode] = await res.json();
  return raw[mode];
}
function applyActive(){
  board = raw[MODE]; MB = normalize(MODE, board);
  if(MODE === "cycle" && board) { /* cycMin carried in MB */ }
  renderWeather(MB?.weather);
  stamp.className = "stamp";
  stamp.textContent = MB ? `Updated ${to12h(new Date(MB.ts * 1000))}` : "Loading…";
  renderFilters(); renderAll();
}
async function refresh(){
  try{
    await fetchBoard(MODE);
    lastOk = Date.now();
    applyActive();
    // warm the other mode in the background so the toggle is instant
    const other = MODE === "walk" ? "cycle" : "walk";
    fetchBoard(other).catch(() => {}); loadGeo(other).catch(() => {});
    return true;
  }catch(e){
    const age = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
    stamp.className = "stamp " + (lastOk ? "stale" : "err");
    stamp.textContent = lastOk ? `Stale — tap to retry (${age}s)` : `Cannot reach board API — tap to retry`;
    return false;
  }
}
// Self-scheduling refresh: normal cadence when healthy, retry fast while stale (covers a
// failed fetch or a throttled timer on the kiosk). Any tick reschedules the next.
let refreshTimer = null;
function scheduleRefresh(ms){ clearTimeout(refreshTimer); refreshTimer = setTimeout(runRefresh, ms); }
async function runRefresh(){ const ok = await refresh(); scheduleRefresh(ok ? REFRESH_MS : 15000); }
function forceRefresh(){ stamp.textContent = "Refreshing…"; runRefresh(); }

// ---------- mode toggle (in place, no reload) ----------
function reconfigure(mode){
  MODE = mode; C = CFG[mode]; SERVICES = C.lines; DEFAULT_LINES = C.defaultLines;
  selected = new Set(SERVICES); tableAll = false; focus = null; layoutClass = ""; fleet = []; everLive = new Set();
  map.setZoom(C.openZoom, {animate:false});
  for(const a of document.querySelectorAll(".modetog a"))
    a.classList.toggle("on", a.dataset.mode === mode);
}
async function switchMode(mode){
  if(mode === MODE) return;
  history.pushState({}, "", mode === "cycle" ? "/stokey/cycle/" : "/stokey/");
  try{ localStorage.setItem("boardMode", mode); }catch{}
  reconfigure(mode);
  stamp.textContent = "Loading…";
  if(!raw[mode]) await fetchBoard(mode).catch(() => {});
  await loadGeo(mode).catch(() => {});
  buildMap();
  applyActive();
}
for(const a of document.querySelectorAll(".modetog a")){
  a.classList.toggle("on", a.dataset.mode === MODE);
  a.addEventListener("click", e => { e.preventDefault(); switchMode(a.dataset.mode); });
}
window.addEventListener("popstate", () => {
  const m = location.pathname.includes("/cycle") ? "cycle" : "walk";
  if(m !== MODE) switchMode(m);
});

// A wallboard idle for an hour returns to defaults.
let lastTouch = Date.now();
["click","touchstart","keydown"].forEach(ev => document.addEventListener(ev, () => { lastTouch = Date.now(); }, {passive:true}));
setInterval(() => {
  // Planner: re-plan in the background so times stay live, but only ≥30s after the
  // last touch so it never redraws mid-tap; drop back to the board after 15 min idle.
  if(typeof JP !== "undefined" && JP.active){
    const idle = Date.now() - lastTouch;
    if(idle > 900000){ jpExit(); return; }
    if(idle > 30000 && !document.hidden) jpLoad(true);
    return;
  }
  if(Date.now() - lastTouch < 3600000) return;
  if(!focus && !mapNarrowed() && !tableAll) return;
  focus = null; tableAll = false; selected = new Set(SERVICES);
  renderFilters(); renderAll(); if(homeBounds){ lastFit = null; map.fitBounds(homeBounds, FIT); }
}, 60000);

// ---------- journey planner ----------
// Search a destination (address / postcode), then plan from home via TfL: walk or
// cycle access + public transport, plus a full-walk / full-cycle option. In planner
// mode the left cards + filters are replaced by ranked options; every option is
// sketched on the map, and tapping one frames it with per-leg styling + an accordion.
const jpLayer = L.layerGroup().addTo(map);
const JP = { active:false, dest:null, mode:MODE, options:[], sel:-1, expanded:-1, places:[], geoTok:0, loadTok:0, cache:{walk:null, cycle:null}, fast:{cycle:null} };
// White text, or black when the line colour is light (Circle yellow, W&C teal, etc.).
function textOn(hex){
  const c = String(hex||"").replace("#",""); if(c.length < 6) return "#fff";
  const r = parseInt(c.slice(0,2),16), g = parseInt(c.slice(2,4),16), b = parseInt(c.slice(4,6),16);
  return (0.299*r + 0.587*g + 0.114*b) > 150 ? "#111" : "#fff";
}

// Google Material icons (inline SVG, so no external font — works offline in the PWA).
const MI = {
  search:`<path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.49 4.49 0 0 1 9.5 14z"/>`,
  close:`<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>`,
  back:`<path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"/>`,
  walk:`<path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6z"/>`,
  bike:`<path d="M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zm5.8-10 2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V9c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 8.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 14v5h2v-6.2zM19 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>`,
  bus:`<path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12z"/>`,
  train:`<path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h12v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11 10H6V6h5zm2 0V6h5v4zm3.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>`,
  expand:`<path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z"/>`,
  place:`<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>`,
  recent:`<path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8z"/>`,
  restaurant:`<path d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"/>`,
  hotel:`<path d="M7 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9a4 4 0 0 0-4-4z"/>`,
  store:`<path d="M18 6h-2a4 4 0 1 0-8 0H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6-2a2 2 0 0 1 2 2h-4a2 2 0 0 1 2-2z"/>`,
  park:`<path d="M17 12h2L12 3 5 12h2l-3.9 6h6.92v3h3.96v-3H21z"/>`,
  school:`<path d="M5 13.18v4L12 21l7-3.82v-4L12 17zM12 3 1 9l11 6 9-4.91V17h2V9z"/>`,
  airport:`<path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/>`,
  fullscreen:`<path d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z"/>`,
  fullscreen_exit:`<path d="M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z"/>`,
  mylocation:`<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A9 9 0 0 0 13 3.06V1h-2v2.06A9 9 0 0 0 3.06 11H1v2h2.06A9 9 0 0 0 11 20.94V23h2v-2.06A9 9 0 0 0 20.94 13H23v-2zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/>`,
  info:`<path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"/>`,
  route:`<path d="M19 15.18V7c0-2.21-1.79-4-4-4s-4 1.79-4 4v10c0 1.1-.9 2-2 2s-2-.9-2-2V8.82C8.16 8.4 9 7.3 9 6c0-1.66-1.34-3-3-3S3 4.34 3 6c0 1.3.84 2.4 2 2.82V17c0 2.21 1.79 4 4 4s4-1.79 4-4V7c0-1.1.9-2 2-2s2 .9 2 2v8.18c-1.16.42-2 1.52-2 2.82 0 1.66 1.34 3 3 3s3-1.34 3-3c0-1.3-.84-2.4-2-2.82z"/>`,
};
const PLACE_ICON = { station:"train", restaurant:"restaurant", hotel:"hotel", store:"store", park:"park", school:"school", airport:"airport", address:"place", place:"place", recent:"recent" };
const mi = (name, size = 16) => `<svg class="mi" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${MI[name] ?? MI.place}</svg>`;
const LEG_ICON = l => mi(l.kind === "walk" ? "walk" : l.kind === "cycle" ? "bike" : l.mode === "bus" ? "bus" : "train", 15);
// Transit legs use the board's own line colours (so Windrush is its real red, etc.);
// walk/cycle keep the mode colour from the backend.
const legColor = l => l.kind === "transit" && l.line ? colorOf(l.line) : l.color;
// walk / cycle / bus / rail — used to style chips and map lines differently per mode.
const legStyle = l => l.kind !== "transit" ? l.kind : (l.mode === "bus" ? "bus" : "rail");

function injectPlanner(){
  const search = document.createElement("div");
  search.className = "jpsearch";
  search.innerHTML =
    `<div class="jpbar"><span class="jpicon">${mi("search", 18)}</span>
      <input id="jpInput" type="text" placeholder="Search…" autocomplete="off" spellcheck="false">
      <button id="jpClear" class="jpx" hidden title="Clear">${mi("close", 20)}</button></div>
     <div class="jpresults" id="jpResults" hidden></div>`;
  mapPanel.appendChild(search);

  const panel = document.createElement("section");
  panel.className = "panel jppanel"; panel.id = "jpPanel"; panel.hidden = true;
  panel.innerHTML =
    `<div class="jphead"><button class="jpback" id="jpBack" title="Back to board">${mi("back", 20)}</button>
       <div class="jpdest"><div class="jptitle" id="jpTitle"></div><div class="jpsub" id="jpSub"></div></div>
       <div class="jptabs" id="jpTabs">
         <button data-jm="walk" title="Walk + transit">${mi("walk", 17)}</button>
         <button data-jm="cycle" title="Cycle + transit">${mi("bike", 17)}</button></div></div>
     <div class="jpupdated" id="jpUpdated"></div>
     <div class="jpoptions" id="jpOptions"></div>`;
  cols.insertBefore(panel, mapPanel);

  const input = document.getElementById("jpInput");
  const results = document.getElementById("jpResults");
  let timer;
  input.addEventListener("input", () => {
    document.getElementById("jpClear").hidden = !input.value;
    clearTimeout(timer);
    const q = input.value.trim();
    if(q.length < 2){ jpShowRecents(); return; }   // empty/short -> your recent destinations
    timer = setTimeout(() => jpGeocode(q), 220);
  });
  input.addEventListener("focus", () => { if(input.value.trim().length < 2) jpShowRecents(); });
  document.getElementById("jpClear").addEventListener("click", () => { input.value = ""; document.getElementById("jpClear").hidden = true; input.focus(); jpShowRecents(); });
  document.getElementById("jpBack").addEventListener("click", jpExit);
  document.getElementById("jpTabs").addEventListener("click", e => {
    const b = e.target.closest("[data-jm]"); if(!b || b.dataset.jm === JP.mode) return;
    JP.mode = b.dataset.jm; jpSyncTabs();
    // Show whatever we have (full, or the cycle-only interim); only reload if nothing yet.
    const have = JP.mode === "cycle" ? (JP.cache.cycle || JP.fast.cycle) : JP.cache.walk;
    if(have) jpShowMode(false);
    else jpLoad();
  });
  document.addEventListener("click", e => { if(!e.target.closest(".jpsearch")) results.hidden = true; });
}

// A geocoding session groups one autocomplete-then-pick sequence (Google bills per
// session, not per keystroke). New token after each pick.
let jpSession = null;
function jpNewSession(){ jpSession = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.round(Math.random() * 1e9); }

function jpRecents(){ try{ return JSON.parse(localStorage.getItem("jpRecents") || "[]"); }catch{ return []; } }
function jpAddRecent(p){
  if(p.lat == null) return;
  const r = jpRecents().filter(x => Math.abs(x.lat - p.lat) > 1e-5 || Math.abs(x.lon - p.lon) > 1e-5);
  r.unshift({ name: p.name, detail: p.detail || "", lat: p.lat, lon: p.lon, type: p.type || "place" });
  try{ localStorage.setItem("jpRecents", JSON.stringify(r.slice(0, 6))); }catch{}
}
function jpShowRecents(){ jpShowResults(jpRecents(), true); }

function jpShowResults(places, recent){
  const results = document.getElementById("jpResults");
  JP.places = places || [];
  if(!JP.places.length){ results.hidden = true; return; }
  results.innerHTML = JP.places.map((p, i) =>
    `<button class="jpresult" data-i="${i}">${mi(recent ? "recent" : (PLACE_ICON[p.type] || "place"), 18)}
       <span class="jprestxt"><b>${esc(p.name)}</b>${p.detail ? `<span>${esc(p.detail)}</span>` : ""}</span></button>`).join("");
  results.hidden = false;
  for(const b of results.querySelectorAll(".jpresult"))
    b.addEventListener("click", () => jpChoose(JP.places[+b.dataset.i]));
}

async function jpGeocode(q){
  const tok = ++JP.geoTok;
  if(!jpSession) jpNewSession();
  try{
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}&session=${jpSession}`);
    const d = await r.json();
    if(tok !== JP.geoTok) return;
    jpShowResults(d.places || [], false);
  }catch{ /* ignore */ }
}

// Google predictions have no coords until picked — resolve, then plan. Recents and
// Photon results already carry coords.
async function jpChoose(place){
  document.getElementById("jpResults").hidden = true;
  if(place.lat != null){ jpPick(place); jpAddRecent(place); jpNewSession(); return; }
  if(place.placeId){
    document.getElementById("jpInput").value = place.name;
    try{
      const r = await fetch(`/api/place?id=${encodeURIComponent(place.placeId)}&session=${jpSession || ""}`);
      const d = await r.json();
      if(d.place){ const full = { ...place, lat: d.place.lat, lon: d.place.lon }; jpPick(full); jpAddRecent(full); }
    }catch{ /* ignore */ }
    jpNewSession();
  }
}

function jpSyncTabs(){ for(const b of document.querySelectorAll("#jpTabs button")) b.classList.toggle("on", b.dataset.jm === JP.mode); }

function jpPick(place){
  JP.dest = place; JP.mode = MODE; JP.active = true; JP.sel = -1; JP.cache = {walk:null, cycle:null}; JP.fast = {cycle:null};
  document.getElementById("jpInput").value = place.name;
  document.getElementById("jpResults").hidden = true;
  document.getElementById("jpClear").hidden = false;
  document.body.classList.add("planning");
  cols.classList.add("planning");
  document.getElementById("jpPanel").hidden = false;
  document.getElementById("jpTitle").textContent = place.name;
  document.getElementById("jpSub").textContent = place.detail || "";
  jpSyncTabs();
  hideInfo();
  renderPins();               // clears board pins while planning
  applyMapFilter();           // hide board stops/lines
  requestAnimationFrame(() => map.invalidateSize());  // grid switched from 3-col to 2-col
  jpLoad();
}

function jpExit(){
  jpStopMore();
  JP.active = false; JP.dest = null; JP.options = []; JP.sel = -1; JP.expanded = -1; JP.places = []; JP.cache = {walk:null, cycle:null}; JP.fast = {cycle:null};
  document.body.classList.remove("planning");
  cols.classList.remove("planning");
  document.getElementById("jpPanel").hidden = true;
  const input = document.getElementById("jpInput");
  input.value = ""; document.getElementById("jpClear").hidden = true;
  document.getElementById("jpResults").hidden = true;
  document.getElementById("jpOptions").innerHTML = "";
  jpLayer.clearLayers();
  renderAll();
  requestAnimationFrame(() => { map.invalidateSize(); if(homeBounds){ lastFit = null; map.fitBounds(homeBounds, FIT); } });
}

// Plan BOTH modes up front (and on every background refresh) so the walk/cycle
// toggle switches instantly from cache with no new load.
async function jpLoad(keep){
  const tok = ++JP.loadTok;
  const opts = document.getElementById("jpOptions");
  if(!keep){ opts.innerHTML = `<div class="jploading">Planning your journey…</div>`; jpLayer.clearLayers(); }
  const one = (m, stage) => fetch(`/api/journey?to=${JP.dest.lat},${JP.dest.lon}&mode=${m}${stage ? "&stage=" + stage : ""}`).then(r => r.json()).then(d => d.options || []).catch(() => []);
  const live = () => tok === JP.loadTok && JP.active;
  // Walk's transit query is already ~1s; cycle+transit routing is slow, so for cycle we
  // fetch the cycle-only route first (a couple of seconds) and paint it with a "loading
  // cycle + transit" note, then swap in the full result. Both modes load concurrently so
  // the walk/cycle toggle is instant.
  const loadMode = async m => {
    if(m === "cycle"){
      const fast = await one("cycle", "fast");
      if(!live()) return;
      JP.fast.cycle = fast;
      if(JP.mode === "cycle" && !JP.cache.cycle){ JP.updated = Date.now(); jpShowMode(keep); }
      const full = await one("cycle", "full");
      if(!live()) return;
      // A transient empty full result must not wipe the cycle-only options we already
      // showed — keep those (or a prior good result) rather than flashing "no routes".
      JP.cache.cycle = full.length ? full
        : (JP.fast.cycle && JP.fast.cycle.length) ? JP.fast.cycle
        : (JP.cache.cycle && JP.cache.cycle.length) ? JP.cache.cycle : full;
      JP.updated = Date.now();
      if(JP.mode === "cycle") jpShowMode(keep);
    } else {
      const full = await one("walk");
      if(!live()) return;
      if(full.length || !(JP.cache.walk && JP.cache.walk.length)) JP.cache.walk = full;
      JP.updated = Date.now();
      if(JP.mode === "walk") jpShowMode(keep);
    }
  };
  try{ await Promise.all([loadMode(JP.mode), loadMode(JP.mode === "walk" ? "cycle" : "walk")]); }
  catch{ if(tok === JP.loadTok && !keep && !JP.options.length) document.getElementById("jpOptions").innerHTML = `<div class="jperr">Couldn't plan that journey. Try again.</div>`; }
}
// True while the cycle+transit routes are still being fetched (cycle-only shown meanwhile).
function jpCycleLoading(){ return JP.mode === "cycle" && !JP.cache.cycle; }
function jpShowMode(keep){
  JP.options = (JP.mode === "cycle" ? (JP.cache.cycle || JP.fast.cycle) : JP.cache.walk) || [];
  const u = document.getElementById("jpUpdated");
  if(u) u.textContent = JP.updated ? `Updated ${to12h(new Date(JP.updated))}` : "";
  if(keep && JP.sel >= 0){ JP.sel = Math.min(JP.sel, JP.options.length - 1); JP.expanded = JP.sel; }
  else { JP.sel = JP.options.length ? 0 : -1; JP.expanded = JP.sel; }
  jpRenderOptions(); jpDrawMap();
  if(!keep) jpFit();
}

// Elevation sparkline for a full-cycle option, from its sampled profile.
function jpElevSvg(o){
  const p = o.profile;
  if(!p || p.length < 2) return "";
  const min = Math.min(...p), max = Math.max(...p), range = Math.max(1, max - min);
  const W = 280, H = 64, pad = 5;
  const xy = p.map((h,i) => [pad + i*(W-2*pad)/(p.length-1), pad + (H-2*pad)*(1-(h-min)/range)]);
  const line = xy.map(([x,y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pad},${H-pad} ${line} ${W-pad},${H-pad}`;
  return `<div class="jpelev">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="${area}" fill="rgba(32,192,91,.16)"/>
      <polyline points="${line}" fill="none" stroke="#20c05b" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <div class="jpelevlbl"><span>elevation</span><span>${Math.round(min)}–${Math.round(max)} m</span></div>
  </div>`;
}
function jpRenderOptions(){
  jpStopMore();   // any open mini-board is about to be re-rendered away
  const opts = document.getElementById("jpOptions");
  const loading = jpCycleLoading();
  const note = loading ? `<div class="jploading jpmore-note">${mi("route", 18)} Loading cycle + transit routes…</div>` : "";
  if(!JP.options.length){ opts.innerHTML = loading ? note : `<div class="jperr">No routes found for this trip.</div>`; return; }
  opts.innerHTML = JP.options.map((o,i) => {
    const open = i === JP.expanded;
    const chips = o.legs.map(l =>
      `<span class="jplegchip ${legStyle(l)}" style="--c:${legColor(l)};color:${textOn(legColor(l))}">${LEG_ICON(l)}${l.line ? " " + esc(l.line) : ""}</span>`
    ).join(`<span class="jparrow">›</span>`);
    const tag = o.kind === "full-walk" ? "Full walk"
              : o.kind === "full-cycle" ? `${o.label || "Full"} cycle`
              : `${o.changes} change${o.changes === 1 ? "" : "s"}`;
    const extra = [o.walkMins ? `${o.walkMins} min walk` : "", o.cycleMins ? `${o.cycleMins} min cycle` : "",
                   o.km ? `${o.km} km` : "", o.ascent != null ? `↑ ${o.ascent} m` : ""].filter(Boolean).join(" · ");
    const noMer = iso => to12h(new Date(iso)).replace(/\s?[AP]M$/i, "");
    const mer = iso => to12h(new Date(iso)).toLowerCase().replace(/\s/, "");
    const arr = (o.dep && o.arr) ? `${noMer(o.dep)} → ${mer(o.arr)}` : o.arr ? `arrive ${to12h(new Date(o.arr))}` : "";
    const leaveMin = o.dep ? Math.round((Date.parse(o.dep) - Date.now()) / 60000) : null;
    const soon = leaveMin != null && leaveMin <= 5
      ? `<div class="jpsoon">${leaveMin <= 0 ? "Leave now" : `Leave in ${leaveMin} min`}</div>` : "";
    // Full cycle expands to its elevation graph; full walk has nothing to expand.
    const body = o.kind === "full-cycle" ? jpElevSvg(o)
               : o.kind === "full-walk" ? ""
               : o.legs.map((l, li) => jpLegRow(l, i, li)).join("");
    const expandable = !!body;
    return `<div class="jpopt ${i === JP.sel ? "sel" : ""} ${open ? "open" : ""}" data-i="${i}">
      ${soon}
      <div class="jpopthead">
        <div class="jpdur">${o.duration}<span>min</span></div>
        <div class="jpmid"><div class="jpchips">${chips}</div>
          <div class="jpmeta">${tag}${extra ? " · " + extra : ""}${arr ? " · " + arr : ""}</div></div>
        <span class="jpcaret" ${expandable ? "" : "hidden"}>${mi("expand", 20)}</span>
      </div>
      <div class="jplegs" ${open ? "" : "hidden"}>${body}</div>
    </div>`;
  }).join("") + note;
  for(const card of opts.querySelectorAll(".jpopt"))
    card.addEventListener("click", e => { if(e.target.closest(".jplegs")) return; jpToggle(+card.dataset.i); });
  for(const b of opts.querySelectorAll(".jpmore"))
    b.addEventListener("click", e => { e.stopPropagation(); jpSeeMore(+b.dataset.o, +b.dataset.l, b); });
}

// Planner stop names: keep the full first segment. shortStop() strips a leading
// "Stoke Newington", which turns "Stoke Newington Road / Amhurst Road" into "Road".
function jpStopName(s){ return (String(s ?? "").split("/")[0].trim()) || String(s ?? ""); }
function jpLegRow(l, oi, li){
  const to = jpStopName(l.to);
  const verb = l.kind === "cycle" ? "Cycle" : "Walk";
  const title = l.kind === "transit" ? `${l.label}${l.line ? " " + esc(l.line) : ""} → ${esc(shortDest(l.to))}`
              : to ? `${verb} to ${esc(to)}` : verb;   // full walk/cycle has no intermediate stop
  const dep = l.dep ? to12h(new Date(l.dep)) : "";
  const meta = l.kind === "transit" && dep
    ? `<div class="jplegtime">dep ${dep}${l.stops.length ? ` · ${l.stops.length} stop${l.stops.length === 1 ? "" : "s"}` : ""}</div>` : "";
  const more = l.kind === "transit" && l.fromId && l.lineId
    ? `<button class="jpmore" data-o="${oi}" data-l="${li}">See more times</button><div class="jptimes" hidden></div>` : "";
  // Duration is a prominent badge at the start of the segment, not small grey text.
  return `<div class="jpleg" style="--c:${legColor(l)}">
    <div class="jplegdur">${l.duration}<span>m</span></div>
    <div class="jplegrail"><span class="jplegdot"></span></div>
    <div class="jplegbody"><div class="jplegtitle">${LEG_ICON(l)} ${title}</div>${meta}${more}</div>
  </div>`;
}

// Tap an option: expand its legs (accordion — one open at a time) and draw + frame it.
function jpToggle(i){
  if(JP.expanded === i){ JP.expanded = -1; JP.sel = -1; }   // collapse -> back to overview
  else { JP.expanded = i; JP.sel = i; }
  jpRenderOptions(); jpDrawMap(); jpFit();
  if(JP.expanded === i){
    const card = document.querySelector(`.jpopt[data-i="${i}"]`);
    if(card) card.scrollIntoView({block:"nearest", behavior:"smooth"});
  }
}

// "See more" opens a mini board for that leg's line + stop: the live upcoming
// departures (same TfL feed the main board uses, so the times match), ticking down,
// with the one your journey is built around highlighted.
let jpMoreTimer = null;
function jpStopMore(){ if(jpMoreTimer){ clearInterval(jpMoreTimer); jpMoreTimer = null; } }
async function jpSeeMore(oi, li, btn){
  const box = btn.nextElementSibling;
  if(!box.hidden){ box.hidden = true; btn.textContent = "See more times"; jpStopMore(); return; }
  const leg = JP.options[oi]?.legs[li]; if(!leg) return;
  btn.textContent = "Loading…";
  await jpRenderDeps(leg, box);
  btn.textContent = "Hide times";
  jpStopMore();                                              // keep the live board fresh while open
  jpMoreTimer = setInterval(() => { if(box.hidden || !JP.active) jpStopMore(); else jpRenderDeps(leg, box); }, 30000);
}
async function jpRenderDeps(leg, box){
  try{
    const r = await fetch(`/api/departures?stop=${encodeURIComponent(leg.fromId)}&alt=${encodeURIComponent(leg.fromAlt || "")}&line=${encodeURIComponent(leg.lineId)}&from=${encodeURIComponent(leg.from || "")}&to=${encodeURIComponent(leg.to || "")}`);
    const d = await r.json();
    const all = d.departures || [];
    const col = legColor(leg);
    const rec = leg.dep ? Date.parse(leg.dep) : null;
    // Centre the list on the journey's own departure — show one before it so it lands
    // as roughly the 2nd row — rather than always starting from "now".
    const recIdx = rec != null ? all.findIndex(x => Math.abs(Date.parse(x.expected) - rec) < 90000) : -1;
    const deps = (recIdx > 0 ? all.slice(recIdx - 1) : all).slice(0, 6);
    box.innerHTML = deps.length
      ? `<div class="jpminihdr">Live at ${esc(jpStopName(leg.from))}</div>` + deps.map(x => {
          const mine = rec != null && Math.abs(Date.parse(x.expected) - rec) < 90000;
          const clock = x.expected ? to12h(new Date(x.expected)) : "";
          return `<div class="jpdep${mine ? " rec" : ""}">
            <span class="jpbadge ${legStyle(leg)}" style="background:${col};color:${textOn(col)}">${esc(leg.line ?? "")}</span>
            <span class="jpdepto">${esc(shortDest(x.to))}</span>
            <span class="jpdepright"><span class="jpdepeta" data-exp="${x.expected ?? ""}">${countdown(x.expected, x.etaMin).text}</span>
              ${clock ? `<span class="jpdepclock">${esc(clock)}</span>` : ""}</span></div>`;
        }).join("")
      : `<div class="jpnolive">${leg.dep ? `Scheduled ${esc(to12h(new Date(leg.dep)))} · no live times for this service` : "No live departures right now"}</div>`;
    box.hidden = false;
  }catch{ /* keep whatever was shown */ }
}
// Tick the mini-board countdowns each second, like the main board's rows.
setInterval(() => {
  for(const el of document.querySelectorAll(".jpdepeta[data-exp]")){
    if(!el.dataset.exp) continue;
    const c = countdown(el.dataset.exp, null);
    el.textContent = c.text;
    el.closest(".jpdep")?.classList.toggle("gone", c.secs <= 0);
  }
}, 1000);

function jpDrawMap(){
  jpLayer.clearLayers();
  // Overview: every option faint. Expanded: that one bold, styled per leg, labelled.
  JP.options.forEach((o,i) => { if(i !== JP.sel) for(const l of o.legs) jpLeg(l, false); });
  const o = JP.options[JP.sel];
  if(!o){ jpEndpoint(homeLatLng(), "#20c05b"); jpEndpoint([JP.dest.lat, JP.dest.lon], "#e6e8ee"); return; }
  for(const l of o.legs) jpLeg(l, true);
  // Transfer points: a ringed marker at every boundary between legs, so a change
  // (e.g. bus -> bus) reads clearly. Endpoints are home (green) and destination.
  for(let i = 0; i < o.legs.length - 1; i++){
    const a = o.legs[i].path, b = o.legs[i + 1].path;
    const pt = (a.length ? a[a.length - 1] : null) || (b.length ? b[0] : null);
    if(pt) jpTransfer(pt);
  }
  jpEndpoint(homeLatLng(), "#20c05b");
  jpEndpoint([JP.dest.lat, JP.dest.lon], "#e6e8ee");
  // Leg labels sit ABOVE the line (a pill, not a dot on the track) so they read as
  // labels, not stops. Placed a third of the way along to avoid the transfer dots.
  for(const l of o.legs){
    if(l.path.length < 2) continue;
    const at = l.path[Math.floor(l.path.length / 3)];
    const txt = l.line ? `${LEG_ICON(l)} ${esc(l.line)}` : `${LEG_ICON(l)} ${l.duration}m`;
    L.marker(at, {interactive:false, zIndexOffset:1000, icon:L.divIcon({className:"", iconSize:[0,0], html:
      `<div class="jpleglabel ${legStyle(l)}" style="--c:${legColor(l)};color:${textOn(legColor(l))}">${txt}</div>`})}).addTo(jpLayer);
  }
}
function jpTransfer(latlng){
  L.marker(latlng, {zIndexOffset:900, icon:L.divIcon({className:"", iconSize:[15,15], iconAnchor:[7.5,7.5], html:
    `<div style="width:15px;height:15px;background:#0f1115;border:3px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.6)"></div>`})}).addTo(jpLayer);
}
function jpLeg(l, bold){
  if(l.path.length < 2) return;
  // Self-powered legs are dashed (walk = dots, cycle = dashes); transit is solid,
  // with rail drawn heavier than bus so the two read apart at a glance.
  const st = legStyle(l);
  const dash = st === "walk" ? "1 9" : st === "cycle" ? "5 8" : null;
  const weight = bold ? (st === "rail" ? 7 : st === "bus" ? 4.5 : 4) : 3;
  L.polyline(l.path, {color:legColor(l), weight, opacity: bold ? .95 : .28,
    dashArray:dash, lineCap:"round", lineJoin:"round"}).addTo(jpLayer);
}
function jpEndpoint(latlng, color, label){
  L.marker(latlng, {icon:L.divIcon({className:"", iconSize:[16,16], iconAnchor:[8,8], html:
    `<div style="width:16px;height:16px;background:${color};border:3px solid #0f1115;border-radius:50%;box-shadow:0 0 0 2px ${color}"></div>`})}).addTo(jpLayer);
}
function homeLatLng(){ const h = (geoCache[MODE]?.features || []).find(f => f.properties.kind === "home"); return h ? [h.geometry.coordinates[1], h.geometry.coordinates[0]] : HOME; }

function jpFit(){
  const pts = [];
  // Expanded: frame that option. Overview (nothing expanded): frame home + dest so
  // every option is on screen at once.
  const legs = JP.sel >= 0 ? (JP.options[JP.sel]?.legs ?? []) : JP.options.flatMap(o => o.legs);
  for(const l of legs) for(const p of l.path) pts.push(p);
  if(JP.dest) pts.push(homeLatLng(), [JP.dest.lat, JP.dest.lon]);
  if(pts.length >= 2) map.fitBounds(L.latLngBounds(pts), {paddingTopLeft:[16,58], paddingBottomRight:[16,16], maxZoom:16, animate:true});
}

// ---------- init ----------
(async function init(){
  injectPlanner();
  setFabIcons();
  renderFilters();
  await loadGeo(MODE).catch(e => console.error("geo", e));
  buildMap();
  await runRefresh();   // self-schedules the next tick (fast retry while stale)
  document.addEventListener("visibilitychange", () => { if(!document.hidden) forceRefresh(); });
  stamp.style.cursor = "pointer"; stamp.title = "Tap to refresh"; stamp.addEventListener("click", forceRefresh);
  let _rt; addEventListener("resize", () => { clearTimeout(_rt); _rt = setTimeout(() => map.invalidateSize(), 200); });
})();

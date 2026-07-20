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
  "Northern":"#111", "Central":"#e32017", "Elizabeth line":"#6950a1",
  "Greater Anglia":"#d70428", "Great Northern":"#0a493e", "Thameslink":"#e05aa6",
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
  wx.innerHTML = `
    <div class="now"><span class="icon">${wmoIcon(w.code, w.isDay)}</span>
      <span class="temp">${Math.round(w.tempC)}°</span></div>
    <div class="meta">${esc(wmoLabel(w.code))}
      ${w.maxC != null ? `<br><span class="hilo"><span class="hi">H ${Math.round(w.maxC)}°</span>
        &nbsp;<span class="lo">L ${Math.round(w.minC)}°</span></span>` : ""}</div>`;
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
function fitFocus(){
  if(!focus && !mapNarrowed()){
    if(lastFit !== null){ lastFit = null; if(homeBounds) map.fitBounds(homeBounds, {...FIT, animate:true}); }
    return;
  }
  const active = activeLines();
  if(FS.veh){
    const pts = [];
    const v = allPins().find(v => v.vehicleId === FS.veh);
    for(const s of nodeMarkers) if(FS.stops.has(s.id)) pts.push(s.marker.getLatLng());
    if(v) pts.push(L.latLng(v.lat, v.lon));
    fitTo(pts, `veh:${FS.veh}|${v ? "p" : "n"}`);
    return;
  }
  // Whole line(s): the full drawn geometry of every active line.
  const pts = [];
  for(const l of lineLayers) if(active.has(l.line) && onMap(l.line)){
    try{ const b = l.poly.getBounds(); if(b.isValid()) pts.push(b.getNorthEast(), b.getSouthWest()); }catch{}
  }
  // A tapped bus stop has no line geometry of its own — anchor on the stop.
  if(focus && focus.kind === "stop"){
    const n = nodeMarkers.find(s => s.id === focus.id); if(n) pts.push(n.marker.getLatLng());
  }
  fitTo(pts, `lines:${[...active].sort().join(",")}|${focus?.kind || ""}|${focus?.id || ""}`);
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
if(typeof recentre !== "undefined") recentre.addEventListener("click", () => homeBounds && (lastFit = null, map.fitBounds(homeBounds, FIT)));
if(typeof infoclose !== "undefined") infoclose.addEventListener("click", e => { e.stopPropagation(); hideInfo(); });
if(typeof passedBtn !== "undefined") passedBtn.addEventListener("click", () => {
  showPassed = !showPassed;
  passedBtn.setAttribute("aria-pressed", String(showPassed));
  renderPins();
});
if(typeof legendBtn !== "undefined") legendBtn.addEventListener("click", () => {
  const open = maplegend.hidden; maplegend.hidden = !open; legendBtn.setAttribute("aria-expanded", String(open));
});
if(typeof fullscreen !== "undefined") fullscreen.addEventListener("click", () => {
  if(!mapPanel.classList.contains("full"))
    document.documentElement.style.setProperty("--chrome", `${Math.round(document.querySelector(".wrap").getBoundingClientRect().top)}px`);
  const full = mapPanel.classList.toggle("full");
  fullscreen.innerHTML = full ? "&#10531;" : "&#10530;";
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
  }catch(e){
    const age = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
    stamp.className = "stamp " + (lastOk ? "stale" : "err");
    stamp.textContent = lastOk ? `Stale — last update ${age}s ago` : `Cannot reach board API (${e.message})`;
  }
}

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
const JP = { active:false, dest:null, mode:MODE, options:[], sel:-1, expanded:-1, places:[], geoTok:0, loadTok:0 };

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
};
const mi = (name, size = 16) => `<svg class="mi" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${MI[name]}</svg>`;
const LEG_ICON = l => mi(l.kind === "walk" ? "walk" : l.kind === "cycle" ? "bike" : l.mode === "bus" ? "bus" : "train", 15);
// Transit legs use the board's own line colours (so Windrush is its real red, etc.);
// walk/cycle keep the mode colour from the backend.
const legColor = l => l.kind === "transit" && l.line ? colorOf(l.line) : l.color;

function injectPlanner(){
  const search = document.createElement("div");
  search.className = "jpsearch";
  search.innerHTML =
    `<div class="jpbar"><span class="jpicon">${mi("search", 18)}</span>
      <input id="jpInput" type="text" placeholder="Plan a journey — address or postcode" autocomplete="off" spellcheck="false">
      <button id="jpClear" class="jpx" hidden title="Clear">${mi("close", 20)}</button></div>
     <div class="jpresults" id="jpResults" hidden></div>`;
  mapPanel.appendChild(search);

  const panel = document.createElement("section");
  panel.className = "panel jppanel"; panel.id = "jpPanel"; panel.hidden = true;
  panel.innerHTML =
    `<div class="jphead"><button class="jpback" id="jpBack" title="Back to board">${mi("back", 20)}</button>
       <div><div class="jptitle" id="jpTitle"></div><div class="jpsub" id="jpSub"></div></div></div>
     <div class="jptabs" id="jpTabs">
       <button data-jm="walk">${mi("walk", 15)} Walk + transit</button>
       <button data-jm="cycle">${mi("bike", 15)} Cycle + transit</button></div>
     <div class="jpoptions" id="jpOptions"></div>`;
  cols.insertBefore(panel, mapPanel);

  const input = document.getElementById("jpInput");
  const results = document.getElementById("jpResults");
  let timer;
  input.addEventListener("input", () => {
    document.getElementById("jpClear").hidden = !input.value;
    clearTimeout(timer);
    const q = input.value.trim();
    if(q.length < 2){ results.hidden = true; return; }
    timer = setTimeout(() => jpGeocode(q), 220);
  });
  input.addEventListener("focus", () => { if(results.children.length && input.value.trim().length >= 2) results.hidden = false; });
  document.getElementById("jpClear").addEventListener("click", () => { input.value = ""; results.hidden = true; document.getElementById("jpClear").hidden = true; input.focus(); });
  document.getElementById("jpBack").addEventListener("click", jpExit);
  document.getElementById("jpTabs").addEventListener("click", e => {
    const b = e.target.closest("[data-jm]"); if(!b || b.dataset.jm === JP.mode) return;
    JP.mode = b.dataset.jm; jpSyncTabs(); JP.sel = -1; jpLoad();
  });
  document.addEventListener("click", e => { if(!e.target.closest(".jpsearch")) results.hidden = true; });
}

async function jpGeocode(q){
  const tok = ++JP.geoTok;
  try{
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
    const d = await r.json();
    if(tok !== JP.geoTok) return;
    JP.places = d.places || [];
    const results = document.getElementById("jpResults");
    if(!JP.places.length){ results.innerHTML = `<div class="jpnone">No matches</div>`; results.hidden = false; return; }
    results.innerHTML = JP.places.map((p,i) =>
      `<button class="jpresult" data-i="${i}"><b>${esc(p.name)}</b>${p.detail ? `<span>${esc(p.detail)}</span>` : ""}</button>`).join("");
    results.hidden = false;
    for(const b of results.querySelectorAll(".jpresult"))
      b.addEventListener("click", () => jpPick(JP.places[+b.dataset.i]));
  }catch{ /* ignore */ }
}

function jpSyncTabs(){ for(const b of document.querySelectorAll("#jpTabs button")) b.classList.toggle("on", b.dataset.jm === JP.mode); }

function jpPick(place){
  JP.dest = place; JP.mode = MODE; JP.active = true; JP.sel = -1;
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
  JP.active = false; JP.dest = null; JP.options = []; JP.sel = -1; JP.expanded = -1; JP.places = [];
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

async function jpLoad(){
  const tok = ++JP.loadTok;
  const opts = document.getElementById("jpOptions");
  opts.innerHTML = `<div class="jploading">Planning your journey…</div>`;
  jpLayer.clearLayers();
  try{
    const r = await fetch(`/api/journey?to=${JP.dest.lat},${JP.dest.lon}&mode=${JP.mode}`);
    const d = await r.json();
    if(tok !== JP.loadTok) return;
    JP.options = d.options || [];
    JP.sel = -1; JP.expanded = -1;    // options start collapsed; overview shows them all on the map
    jpRenderOptions(); jpDrawMap(); jpFit();
  }catch{ if(tok === JP.loadTok) document.getElementById("jpOptions").innerHTML = `<div class="jperr">Couldn't plan that journey. Try again.</div>`; }
}

function jpRenderOptions(){
  const opts = document.getElementById("jpOptions");
  if(!JP.options.length){ opts.innerHTML = `<div class="jperr">No routes found for this trip.</div>`; return; }
  opts.innerHTML = JP.options.map((o,i) => {
    const open = i === JP.expanded;
    const chips = o.legs.map(l =>
      `<span class="jplegchip" style="--c:${legColor(l)}">${LEG_ICON(l)}${l.line ? " " + esc(l.line) : ""}</span>`
    ).join(`<span class="jparrow">›</span>`);
    const tag = o.kind === "full-walk" ? "Full walk" : o.kind === "full-cycle" ? "Full cycle"
              : `${o.changes} change${o.changes === 1 ? "" : "s"}`;
    const extra = [o.walkMins ? `${o.walkMins} min walk` : "", o.cycleMins ? `${o.cycleMins} min cycle` : ""].filter(Boolean).join(" · ");
    const arr = o.arr ? `arrive ${to12h(new Date(o.arr))}` : "";
    return `<div class="jpopt ${i === JP.sel ? "sel" : ""} ${open ? "open" : ""}" data-i="${i}">
      <div class="jpopthead">
        <div class="jpdur">${o.duration}<span>min</span></div>
        <div class="jpmid"><div class="jpchips">${chips}</div>
          <div class="jpmeta">${tag}${extra ? " · " + extra : ""}${arr ? " · " + arr : ""}</div></div>
        <span class="jpcaret">${mi("expand", 20)}</span>
      </div>
      <div class="jplegs" ${open ? "" : "hidden"}>${o.legs.map((l, li) => jpLegRow(l, i, li)).join("")}</div>
    </div>`;
  }).join("");
  for(const card of opts.querySelectorAll(".jpopt"))
    card.querySelector(".jpopthead").addEventListener("click", () => jpToggle(+card.dataset.i));
  for(const b of opts.querySelectorAll(".jpmore"))
    b.addEventListener("click", e => { e.stopPropagation(); jpSeeMore(+b.dataset.o, +b.dataset.l, b); });
}

function jpLegRow(l, oi, li){
  const to = shortStop(l.to) || shortDest(l.to);
  const title = l.kind === "transit" ? `${l.label}${l.line ? " " + esc(l.line) : ""} → ${esc(shortDest(l.to))}`
              : l.kind === "cycle" ? `Cycle to ${esc(to)}`
              : `Walk to ${esc(to)}`;
  const dep = l.dep ? to12h(new Date(l.dep)) : "";
  const meta = l.kind === "transit" && dep
    ? `<div class="jplegtime">dep ${dep}${l.stops.length ? ` · ${l.stops.length} stop${l.stops.length === 1 ? "" : "s"}` : ""}</div>` : "";
  const more = l.kind === "transit" && l.fromId && l.lineId
    ? `<button class="jpmore" data-o="${oi}" data-l="${li}">See more times</button><div class="jptimes" hidden></div>` : "";
  return `<div class="jpleg" style="--c:${legColor(l)}">
    <div class="jplegrail"><span class="jplegdot"></span></div>
    <div class="jplegbody"><div class="jplegtitle">${LEG_ICON(l)} ${title} <span class="jplegdur">${l.duration}m</span></div>
      ${l.instruction && l.kind !== "transit" ? `<div class="jpleginstr">${esc(l.instruction)}</div>` : ""}${meta}${more}</div>
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

// Live upcoming departures for a transit leg's boarding stop.
async function jpSeeMore(oi, li, btn){
  const box = btn.nextElementSibling;
  if(!box.hidden){ box.hidden = true; btn.textContent = "See more times"; return; }
  const leg = JP.options[oi]?.legs[li]; if(!leg) return;
  btn.textContent = "Loading…";
  try{
    const r = await fetch(`/api/departures?stop=${encodeURIComponent(leg.fromId)}&line=${encodeURIComponent(leg.lineId)}`);
    const d = await r.json();
    const deps = d.departures || [];
    box.innerHTML = deps.length
      ? deps.map(x => `<div class="jptime"><b>${x.etaMin === 0 ? "Due" : x.etaMin + " min"}</b><span>${to12h(new Date(x.expected))} → ${esc(shortDest(x.to))}</span></div>`).join("")
      : `<div class="jptime jpnolive">No live times right now</div>`;
    box.hidden = false; btn.textContent = "Hide times";
  }catch{ btn.textContent = "See more times"; }
}

function jpDrawMap(){
  jpLayer.clearLayers();
  // Overview: every option faint. Expanded: that one bold, styled per leg, labelled.
  JP.options.forEach((o,i) => { if(i !== JP.sel) for(const l of o.legs) jpLeg(l, false); });
  jpEndpoint(homeLatLng(), "#20c05b");
  jpEndpoint([JP.dest.lat, JP.dest.lon], "#e6e8ee");
  const o = JP.options[JP.sel]; if(!o) return;
  for(const l of o.legs) jpLeg(l, true);
  for(const l of o.legs){
    if(l.path.length < 2) continue;
    const mid = l.path[Math.floor(l.path.length / 2)];
    const txt = l.line ? `${LEG_ICON(l)} ${esc(l.line)}` : `${LEG_ICON(l)} ${l.duration}m`;
    L.marker(mid, {interactive:false, icon:L.divIcon({className:"", iconSize:[0,0], html:
      `<div class="jpleglabel" style="--c:${legColor(l)}">${txt}</div>`})}).addTo(jpLayer);
  }
}
function jpLeg(l, bold){
  if(l.path.length < 2) return;
  const dash = l.kind === "walk" ? "1 8" : l.kind === "cycle" ? "2 8" : null;
  L.polyline(l.path, {color:legColor(l), weight: bold ? 6 : 3, opacity: bold ? .95 : .28,
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
  renderFilters();
  await loadGeo(MODE).catch(e => console.error("geo", e));
  buildMap();
  await refresh();
  setInterval(refresh, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if(!document.hidden) refresh(); });
  let _rt; addEventListener("resize", () => { clearTimeout(_rt); _rt = setTimeout(() => map.invalidateSize(), 200); });
})();

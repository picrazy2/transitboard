/* "Get me home" — the mobile companion to the board. You're out somewhere with the
   Brompton; this plans cycle + transit routes back to Stoke Newington. Destination is
   always home; you can only change the origin (defaults to your GPS location).
   Full-screen map + a Google-Maps-style draggable bottom drawer of route options.
   Shares board.css and the same /api journey backend; helpers below mirror board.js. */

const HOME = [51.5611161, -0.0739865];

// ---------- helpers (mirrored from board.js) ----------
const pad = n => String(n).padStart(2, "0");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const to12h = d => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Europe/London" })
  .replace(" ", "").replace("AM", "am").replace("PM", "pm");
function countdown(iso, fallbackMin) {
  if (!iso) return { text: fallbackMin === 0 ? "Due" : `${fallbackMin} min`, secs: (fallbackMin || 0) * 60 };
  const secs = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (secs <= 0) return { text: "Due", secs: 0 };
  return { text: `${Math.floor(secs / 60)}:${pad(secs % 60)}`, secs };
}

const LINE_COLOR = {
  "Weaver": "#823a62", "Mildmay": "#3a6ea5", "Windrush": "#dc241f", "Suffragette": "#57ad6d",
  "Lioness": "#c99e28", "Liberty": "#5d6067", "Victoria": "#0098d4", "Piccadilly": "#0a338c",
  "Northern": "#111", "Central": "#e32017", "Elizabeth line": "#6950a1", "Elizabeth": "#6950a1",
  "Greater Anglia": "#d70428", "Great Northern": "#0a493e", "Thameslink": "#e05aa6",
  "Bakerloo": "#b36305", "Circle": "#ffd300", "District": "#00782a", "Hammersmith & City": "#f3a9bb",
  "Jubilee": "#a0a5a9", "Metropolitan": "#9b0056", "Waterloo & City": "#95cdba", "DLR": "#00a4a7",
  "Tram": "#5fb130", "Heathrow Express": "#532e63", "Southern": "#8cc63f", "Southeastern": "#389cff",
  "South Western Railway": "#24215e", "c2c": "#b6153c", "Chiltern Railways": "#00bfff",
};
function colorOf(line) {
  if (LINE_COLOR[line]) return LINE_COLOR[line];
  if (String(line).startsWith("N")) return "#1b2a6b";
  return "#e1251b";
}
function textOn(hex) {
  const c = String(hex || "").replace("#", ""); if (c.length < 6) return "#fff";
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#111" : "#fff";
}
function shortDest(name) {
  const norm = s => s.replace(/,\s*/g, " ").replace(/\s+/g, " ").trim()
    .replace(/\s+Rail Station$/i, "").replace(/\s+Bus Station$/i, " Bus Stn").replace(/\s+Station$/i, " Stn");
  const s = norm(String(name ?? "—"));
  if (s.length <= 24 || !s.includes("/")) return s;
  const parts = s.split("/").map(norm);
  return parts.find(p => /\bStn\b/.test(p)) ?? parts[0];
}
const jpStopName = s => (String(s ?? "").split("/")[0].trim()) || String(s ?? "");

const MI = {
  search: `<path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.49 4.49 0 0 1 9.5 14z"/>`,
  close: `<path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>`,
  walk: `<path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6z"/>`,
  bike: `<path d="M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zm5.8-10 2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V9c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 8.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 14v5h2v-6.2zM19 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>`,
  bus: `<path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12z"/>`,
  train: `<path d="M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h12v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11 10H6V6h5zm2 0V6h5v4zm3.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>`,
  expand: `<path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z"/>`,
  place: `<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>`,
  recent: `<path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8z"/>`,
  home: `<path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>`,
  mylocation: `<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A9 9 0 0 0 13 3.06V1h-2v2.06A9 9 0 0 0 3.06 11H1v2h2.06A9 9 0 0 0 11 20.94V23h2v-2.06A9 9 0 0 0 20.94 13H23v-2zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/>`,
  route: `<path d="M19 15.18V7c0-2.21-1.79-4-4-4s-4 1.79-4 4v10c0 1.1-.9 2-2 2s-2-.9-2-2V8.82C8.16 8.4 9 7.3 9 6c0-1.66-1.34-3-3-3S3 4.34 3 6c0 1.3.84 2.4 2 2.82V17c0 2.21 1.79 4 4 4s4-1.79 4-4V7c0-1.1.9-2 2-2s2 .9 2 2v8.18c-1.16.42-2 1.52-2 2.82 0 1.66 1.34 3 3 3s3-1.34 3-3c0-1.3-.84-2.4-2-2.82z"/>`,
  recenter: `<path d="M5 15H3v4c0 1.1.9 2 2 2h4v-2H5v-4zM5 5h4V3H5c-1.1 0-2 .9-2 2v4h2V5zm14-2h-4v2h4v4h2V5c0-1.1-.9-2-2-2zm0 16h-4v2h4c1.1 0 2-.9 2-2v-4h-2v4zM12 9c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>`,
};
const PLACE_ICON = { station: "train", restaurant: "place", hotel: "place", store: "place", park: "place", school: "place", airport: "place", address: "place", place: "place", recent: "recent" };
const mi = (name, size = 16) => `<svg class="mi" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${MI[name] ?? MI.place}</svg>`;
const LEG_ICON = l => mi(l.kind === "walk" ? "walk" : l.kind === "cycle" ? "bike" : l.mode === "bus" ? "bus" : "train", 15);
const legColor = l => l.kind === "transit" && l.line ? colorOf(l.line) : l.color;
const legStyle = l => l.kind !== "transit" ? l.kind : (l.mode === "bus" ? "bus" : "rail");

// ---------- state ----------
// PLAN mode (/plan) is a generic anywhere->anywhere planner: no home default for the
// destination. The default view (/home, /stokey/home) is "get me home" — dest defaults home.
const PLAN = /(^|\/)plan\/?$/.test(location.pathname);
const HOME_PLACE = { name: "Home · Stoke Newington", lat: HOME[0], lon: HOME[1], home: true };
// from/to are {name,lat,lon} or null. activeField tracks which input the search applies to.
const H = { from: null, to: PLAN ? null : { ...HOME_PLACE }, mode: "cycle", activeField: "origin", mapPick: null, options: [], sel: -1, expanded: -1, updated: 0, geoTok: 0, loadTok: 0 };
const toPt = () => H.to ? [H.to.lat, H.to.lon] : null;

// ---------- map ----------
const map = L.map("map", { zoomControl: false, attributionControl: false, zoomSnap: 0.25 });
map.setView(HOME, 12);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  subdomains: "abcd", maxZoom: 20, detectRetina: true,
}).addTo(map);
const hLayer = L.layerGroup().addTo(map);

// ---------- route drawing (mirrors board.js jpDrawMap) ----------
function drawRoute() {
  hLayer.clearLayers();
  const o = H.options[H.sel];
  const overview = !o;   // nothing selected -> draw every option at full opacity
  H.options.forEach((opt, i) => { if (i !== H.sel) for (const l of opt.legs) drawLeg(l, overview); });
  if (H.to) endpoint(toPt(), "#20c05b");
  if (H.from) endpoint([H.from.lat, H.from.lon], "#e6e8ee");
  if (!o) return;
  for (const l of o.legs) drawLeg(l, true);
  for (let i = 0; i < o.legs.length - 1; i++) {
    const a = o.legs[i].path, b = o.legs[i + 1].path;
    const pt = (a.length ? a[a.length - 1] : null) || (b.length ? b[0] : null);
    if (pt) transfer(pt);
  }
  for (const l of o.legs) {
    if (l.path.length < 2) continue;
    const at = l.path[Math.floor(l.path.length / 3)];
    const txt = l.line ? `${LEG_ICON(l)} ${esc(l.line)}` : `${LEG_ICON(l)} ${l.duration}m`;
    L.marker(at, { interactive: false, zIndexOffset: 1000, icon: L.divIcon({ className: "", iconSize: [0, 0], html:
      `<div class="jpleglabel ${legStyle(l)}" style="--c:${legColor(l)};color:${textOn(legColor(l))}">${txt}</div>` }) }).addTo(hLayer);
  }
}
function drawLeg(l, bold) {
  if (l.path.length < 2) return;
  const st = legStyle(l);
  const dash = st === "walk" ? "1 9" : st === "cycle" ? "5 8" : null;
  const weight = bold ? (st === "rail" ? 7 : st === "bus" ? 4.5 : 4) : 3;
  L.polyline(l.path, { color: legColor(l), weight, opacity: bold ? .95 : .28, dashArray: dash, lineCap: "round", lineJoin: "round" }).addTo(hLayer);
}
function transfer(latlng) {
  L.marker(latlng, { zIndexOffset: 900, icon: L.divIcon({ className: "", iconSize: [15, 15], iconAnchor: [7.5, 7.5], html:
    `<div style="width:15px;height:15px;background:#0f1115;border:3px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.6)"></div>` }) }).addTo(hLayer);
}
function endpoint(latlng, color) {
  L.marker(latlng, { icon: L.divIcon({ className: "", iconSize: [16, 16], iconAnchor: [8, 8], html:
    `<div style="width:16px;height:16px;background:${color};border:3px solid #0f1115;border-radius:50%;box-shadow:0 0 0 2px ${color}"></div>` }) }).addTo(hLayer);
}
function fit() {
  const pts = [];
  const legs = H.sel >= 0 ? (H.options[H.sel]?.legs ?? []) : H.options.flatMap(o => o.legs);
  for (const l of legs) for (const p of l.path) pts.push(p);
  if (H.to) pts.push(toPt()); if (H.from) pts.push([H.from.lat, H.from.lon]);
  if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts), drawerPadding());
  showFab(false);   // the route is framed now; the recenter FAB is only for after you pan away
}
// Keep the framed route clear of the floating origin panel up top and the drawer below.
function drawerPadding() {
  const dh = document.getElementById("drawer").getBoundingClientRect().height;
  const bar = document.querySelector(".hbar");
  const top = (bar ? bar.getBoundingClientRect().bottom : 0) + 16;
  return { paddingTopLeft: [24, top], paddingBottomRight: [24, Math.min(dh + 16, innerHeight * 0.6)], maxZoom: 16, animate: true };
}
// The recenter FAB only makes sense when there's a selected route AND you've panned off it.
function showFab(v) { const f = document.getElementById("hRecenter"); if (f) f.style.display = (v && H.sel >= 0) ? "" : "none"; }

// ---------- options list ----------
function renderOptions() {
  const box = document.getElementById("hOptions");
  const note = H.loading ? `<div class="jploading jpmore-note">${mi("route", 18)} Loading rail routes…</div>` : "";
  if (!H.options.length) { box.innerHTML = H.loading ? note : `<div class="jperr">No routes home found right now.</div>`; return; }
  const u = document.getElementById("hUpdated");
  if (u) u.textContent = H.updated ? `Updated ${to12h(new Date(H.updated))}` : "";
  box.innerHTML = H.options.map((o, i) => {
    const open = i === H.expanded;
    const chips = o.legs.map(l =>
      `<span class="jplegchip ${legStyle(l)}" style="--c:${legColor(l)};color:${textOn(legColor(l))}">${LEG_ICON(l)}${l.line ? " " + esc(l.line) : ""}</span>`
    ).join(`<span class="jparrow">›</span>`);
    const tag = o.kind === "full-cycle" ? `${o.label || "Full"} cycle` : `${o.changes} change${o.changes === 1 ? "" : "s"}`;
    const extra = [o.cycleMins ? `${o.cycleMins} min cycle` : "", o.walkMins ? `${o.walkMins} min walk` : "",
                   o.km ? `${o.km} km` : "", o.ascent != null ? `↑ ${o.ascent} m` : ""].filter(Boolean).join(" · ");
    const noMer = iso => to12h(new Date(iso)).replace(/\s?[ap]m$/i, "");
    const times = (o.dep && o.arr) ? `${noMer(o.dep)} → ${to12h(new Date(o.arr))}` : o.arr ? `arrive ${to12h(new Date(o.arr))}` : "";
    const leaveMin = o.dep ? Math.round((Date.parse(o.dep) - Date.now()) / 60000) : null;
    const soon = leaveMin != null && leaveMin <= 8
      ? `<div class="jpsoon">${leaveMin <= 0 ? "Leave now" : `Leave in ${leaveMin} min`}</div>` : "";
    const body = o.kind === "full-cycle" ? elevSvg(o) : o.legs.map((l, li) => legRow(l, i, li)).join("");
    const expandable = !!body;
    return `<div class="jpopt ${i === H.sel ? "sel" : ""} ${open ? "open" : ""}" data-i="${i}">
      ${soon}
      <div class="jpopthead">
        <div class="jpdur">${o.duration}<span>min</span></div>
        <div class="jpmid"><div class="jpchips">${chips}</div>
          <div class="jpmeta">${tag}${extra ? " · " + extra : ""}${times ? " · " + times : ""}</div></div>
        <span class="jpcaret" ${expandable ? "" : "hidden"}>${mi("expand", 20)}</span>
      </div>
      <div class="jplegs" ${open ? "" : "hidden"}>${body}</div>
    </div>`;
  }).join("") + note;
  for (const card of box.querySelectorAll(".jpopt"))
    card.addEventListener("click", e => { if (e.target.closest(".jplegs")) return; toggle(+card.dataset.i); });
  for (const b of box.querySelectorAll(".jpmore"))
    b.addEventListener("click", e => { e.stopPropagation(); seeMore(+b.dataset.o, +b.dataset.l, b); });
}
function legRow(l, oi, li) {
  const to = jpStopName(l.to);
  const verb = l.kind === "cycle" ? "Cycle" : "Walk";
  const title = l.kind === "transit" ? `${l.label}${l.line ? " " + esc(l.line) : ""} → ${esc(shortDest(l.to))}`
              : to ? `${verb} to ${esc(to)}` : verb;
  const dep = l.dep ? to12h(new Date(l.dep)) : "";
  const meta = l.kind === "transit" && dep
    ? `<div class="jplegtime">dep ${dep}${l.stops.length ? ` · ${l.stops.length} stop${l.stops.length === 1 ? "" : "s"}` : ""}</div>` : "";
  const more = l.kind === "transit" && l.fromId && l.lineId
    ? `<button class="jpmore" data-o="${oi}" data-l="${li}">See more times</button><div class="jptimes" hidden></div>` : "";
  return `<div class="jpleg" style="--c:${legColor(l)}">
    <div class="jplegdur">${l.duration}<span>m</span></div>
    <div class="jplegrail"><span class="jplegdot"></span></div>
    <div class="jplegbody"><div class="jplegtitle">${LEG_ICON(l)} ${title}</div>${meta}${more}</div>
  </div>`;
}
function elevSvg(o) {
  const p = o.profile;
  if (!p || p.length < 2) return `<div class="jpelev jpelevnone">No elevation data</div>`;
  const min = Math.min(...p), max = Math.max(...p), range = Math.max(1, max - min);
  const W = 280, HT = 64, pd = 5;
  const xy = p.map((h, i) => [pd + i * (W - 2 * pd) / (p.length - 1), pd + (HT - 2 * pd) * (1 - (h - min) / range)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pd},${HT - pd} ${line} ${W - pd},${HT - pd}`;
  return `<div class="jpelev">
    <svg viewBox="0 0 ${W} ${HT}" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="${area}" fill="rgba(32,192,91,.16)"/>
      <polyline points="${line}" fill="none" stroke="#20c05b" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <div class="jpelevlbl"><span>elevation</span><span>${Math.round(min)}–${Math.round(max)} m</span></div>
  </div>`;
}
function toggle(i) {
  if (H.expanded === i) { H.expanded = -1; H.sel = -1; }
  else { H.expanded = i; H.sel = i; }
  renderOptions(); drawRoute(); fit();
  if (H.expanded === i) {
    snapTo("full");
    const card = document.querySelector(`.jpopt[data-i="${i}"]`);
    if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// ---------- live "see more times" (same feed as the board) ----------
let moreTimer = null;
function stopMore() { if (moreTimer) { clearInterval(moreTimer); moreTimer = null; } }
async function seeMore(oi, li, btn) {
  const box = btn.nextElementSibling;
  if (!box.hidden) { box.hidden = true; btn.textContent = "See more times"; stopMore(); return; }
  const leg = H.options[oi]?.legs[li]; if (!leg) return;
  btn.textContent = "Loading…";
  await renderDeps(leg, box);
  btn.textContent = "Hide times";
  stopMore();
  moreTimer = setInterval(() => { if (box.hidden) stopMore(); else renderDeps(leg, box); }, 30000);
}
async function renderDeps(leg, box) {
  try {
    const r = await fetch(`/api/departures?stop=${encodeURIComponent(leg.fromId)}&alt=${encodeURIComponent(leg.fromAlt || "")}&line=${encodeURIComponent(leg.lineId)}&from=${encodeURIComponent(leg.from || "")}&to=${encodeURIComponent(leg.to || "")}`);
    const d = await r.json();
    const all = d.departures || [];
    const col = legColor(leg);
    const rec = leg.dep ? Date.parse(leg.dep) : null;
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
  } catch { /* keep whatever was shown */ }
}
if (!location.search.includes("notick")) setInterval(() => {
  for (const el of document.querySelectorAll(".jpdepeta[data-exp]")) {
    if (!el.dataset.exp) continue;
    const c = countdown(el.dataset.exp, null);
    el.textContent = c.text;
    el.closest(".jpdep")?.classList.toggle("gone", c.secs <= 0);
  }
}, 1000);

// ---------- loading routes ----------
async function loadRoutes(keep) {
  const box = document.getElementById("hOptions");
  if (!H.from || !H.to) { box.innerHTML = `<div class="jploading">${!H.from ? "Set a starting point" : "Enter a destination"} to see routes.</div>`; return; }
  const tok = ++H.loadTok;
  const goingHome = !!H.to.home;
  if (!keep) box.innerHTML = `<div class="jploading">Finding ${goingHome ? "ways home" : "routes"}…</div>`;
  const one = stage => fetch(`/api/route?from=${H.from.lat},${H.from.lon}&to=${H.to.lat},${H.to.lon}&mode=${H.mode}&toName=${encodeURIComponent(H.to.name || "")}${stage ? "&stage=" + stage : ""}`)
    .then(r => r.json()).then(d => d.options || []).catch(() => []);
  const paint = (opts, loading) => {
    if (tok !== H.loadTok) return;
    H.options = opts; H.updated = Date.now(); H.loading = loading;
    // Don't auto-select/expand on load — start in overview (all options shown on the map).
    if (keep && H.sel >= 0) { H.sel = Math.min(H.sel, H.options.length - 1); H.expanded = H.sel; }
    else { H.sel = -1; H.expanded = -1; }
    renderOptions(); drawRoute(); if (!keep && !loading) fit();
  };
  // finalDone is LOCAL to this load (not shared state) so toggling mode mid-load can't
  // clobber a newer load's staging. The token guards make a superseded load a no-op.
  let finalDone = false, shownAny = false;
  try {
    // Fast stage (full-cycle / full-walk) paints in ~1s; the rail routes swap in after.
    const fastP = one("fast").then(opts => { if (tok === H.loadTok && !finalDone && opts.length) { paint(opts, true); shownAny = true; } });
    const full = await one("full");
    if (tok !== H.loadTok) return;   // a newer load (e.g. a toggle) superseded this one
    finalDone = true;
    // A transient empty full result must not wipe out options we already showed — only
    // show "no routes" when we genuinely have nothing.
    if (full.length || !shownAny) paint(full, false);
    else { H.loading = false; renderOptions(); }
    await fastP.catch(() => {});
  } catch {
    if (tok === H.loadTok && !keep && !shownAny) document.getElementById("hOptions").innerHTML = `<div class="jperr">Couldn't plan that route. Try again.</div>`;
  }
}

function updateTitle() { const t = document.querySelector(".drawertitle"); if (t) t.textContent = PLAN ? "Plan a journey" : (H.to && H.to.home ? "Ways home" : "Routes"); }
function setPlace(field, place, refit) {
  if (field === "dest") { H.to = place; document.getElementById("hDest").value = place.name || ""; updateTitle(); }
  else { H.from = place; document.getElementById("hOrigin").value = place.name || "Current location"; }
  H.sel = -1; H.expanded = -1; H.optionsFinal = false;
  loadRoutes(false);
  if (refit) {
    const pts = []; if (H.from) pts.push([H.from.lat, H.from.lon]); if (H.to) pts.push(toPt());
    if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts), drawerPadding()); else map.setView([place.lat, place.lon], 13);
  }
}
const setOrigin = (place, refit) => setPlace("origin", place, refit);

// ---------- geolocation ----------
function locateInto(field) {
  const el = document.getElementById(field === "dest" ? "hDest" : "hOrigin");
  if (!navigator.geolocation) { el.placeholder = "Search a place"; return; }
  el.value = ""; el.placeholder = "Finding your location…";
  navigator.geolocation.getCurrentPosition(
    pos => setPlace(field, { name: "My location", lat: pos.coords.latitude, lon: pos.coords.longitude }, true),
    () => { el.placeholder = "Search a place"; if (field === "origin") document.getElementById("hOptions").innerHTML = `<div class="jperr">Couldn't get your location — search a start point above.</div>`; },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}
const locate = () => locateInto("origin");

// ---------- choose on map ----------
function startMapPick(field) {
  H.mapPick = field;
  document.body.classList.add("picking");
  const hint = document.getElementById("hMapPick");
  hint.textContent = `Tap the map to set your ${field === "dest" ? "destination" : "start"}`;
  hint.hidden = false;
  document.getElementById("hResults").hidden = true;
}
function endMapPick() { H.mapPick = null; document.body.classList.remove("picking"); document.getElementById("hMapPick").hidden = true; }
map.on("click", e => {
  if (!H.mapPick) return;
  const field = H.mapPick; endMapPick();
  setPlace(field, { name: "Pinned location", lat: e.latlng.lat, lon: e.latlng.lng }, false);
});

// ---------- origin search (Google Places via /api/geocode + /api/place) ----------
let geoSession = null;
function newSession() { geoSession = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.round(Math.random() * 1e9); }
function recents() { try { return JSON.parse(localStorage.getItem("jpRecents") || "[]"); } catch { return []; } }
function addRecent(p) {
  if (p.name === "My location" || p.name === "Pinned location" || p.name === "Current location") return;
  const list = recents().filter(x => x.name !== p.name);
  list.unshift({ name: p.name, detail: p.detail || "", lat: p.lat, lon: p.lon, type: p.type || "place" });
  try { localStorage.setItem("jpRecents", JSON.stringify(list.slice(0, 6))); } catch {}
}
// The dropdown always leads with "My location" and "Choose on map", then recents/results.
function showResults(places, isRecent) {
  const box = document.getElementById("hResults");
  H.places = places;
  const special = [["locate", "mylocation", "My location"], ["map", "place", "Choose on map"], ["home", "home", "Home"]]
    .map(([sp, icon, label]) => `<button class="jpresult" data-sp="${sp}">${mi(icon, 18)}<span class="jprestext"><span class="jpresname">${label}</span></span></button>`).join("");
  box.innerHTML = special + places.map((p, i) =>
    `<button class="jpresult" data-i="${i}">${mi((isRecent || p.recent) ? "recent" : (PLACE_ICON[p.type] || "place"), 18)}
      <span class="jprestext"><span class="jpresname">${esc(p.name)}</span>${p.detail ? `<span class="jpresdetail">${esc(p.detail)}</span>` : ""}</span></button>`
  ).join("");
  for (const b of box.querySelectorAll(".jpresult")) {
    if (b.dataset.sp === "locate") b.addEventListener("click", () => { box.hidden = true; locateInto(H.activeField); });
    else if (b.dataset.sp === "map") b.addEventListener("click", () => startMapPick(H.activeField));
    else if (b.dataset.sp === "home") b.addEventListener("click", () => { box.hidden = true; document.getElementById(H.activeField === "dest" ? "hDest" : "hOrigin").blur(); setPlace(H.activeField, { ...HOME_PLACE }, true); });
    else b.addEventListener("click", () => choose(places[+b.dataset.i]));
  }
  box.hidden = false;
}
async function geocode(q) {
  const tok = ++H.geoTok;
  // Matching recents lead the list (they resolve instantly), then the geocode results.
  const ql = q.toLowerCase();
  const rec = recents().filter(p => `${p.name} ${p.detail || ""}`.toLowerCase().includes(ql)).map(p => ({ ...p, recent: true }));
  try {
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}&session=${geoSession || ""}`);
    const d = await r.json();
    if (tok !== H.geoTok) return;
    const seen = new Set(rec.map(p => (p.name || "").toLowerCase()));
    const geo = (d.places || []).filter(p => !seen.has((p.name || "").toLowerCase()));
    showResults([...rec, ...geo], false);
  } catch { if (tok === H.geoTok) showResults(rec, false); }
}
async function choose(place) {
  const field = H.activeField;
  document.getElementById("hResults").hidden = true;
  document.getElementById(field === "dest" ? "hDest" : "hOrigin").blur();
  if (place.lat != null) { setPlace(field, place, true); addRecent(place); newSession(); return; }
  if (place.placeId) {
    try {
      const r = await fetch(`/api/place?id=${encodeURIComponent(place.placeId)}&session=${geoSession || ""}`);
      const d = await r.json();
      if (d.place) { const full = { ...place, lat: d.place.lat, lon: d.place.lon }; setPlace(field, full, true); addRecent(full); }
    } catch {}
    newSession();
  }
}

// ---------- draggable bottom drawer (Google-Maps-style snap points) ----------
// full stops just below the floating origin panel so it never overlaps it.
const SNAPS = {
  peek: 132,
  mid: () => Math.round(innerHeight * 0.46),
  full: () => { const bar = document.querySelector(".hbar"); const top = bar ? bar.getBoundingClientRect().bottom : 64; return Math.round(innerHeight - top - 12); },
};
function snapPx(name) { const v = SNAPS[name]; return typeof v === "function" ? v() : v; }
function setDrawerH(h) {
  const d = document.getElementById("drawer");
  d.style.height = h + "px";
  const fab = document.getElementById("hRecenter");
  if (fab) fab.style.bottom = Math.round(h + 14) + "px";   // keep the FAB just above the drawer
}
function snapTo(name) {
  const d = document.getElementById("drawer");
  d.dataset.snap = name;
  setDrawerH(snapPx(name));
  requestAnimationFrame(() => map.invalidateSize());
}
// The whole drawer is draggable: a vertical drag collapses/expands it, EXCEPT when the
// gesture should scroll the options list instead (dragging up while already full, or
// dragging down while the list isn't scrolled to the top). Decided once per gesture.
function initDrawer() {
  const d = document.getElementById("drawer");
  const handle = document.getElementById("dragHandle");
  const box = document.getElementById("hOptions");
  snapTo("mid");
  let pressed = false, moved = false, startY = 0, startH = 0, mode = null;   // mode: null -> undecided, "drawer", "scroll"
  const onDown = e => { pressed = true; moved = false; mode = null; startY = (e.touches ? e.touches[0].clientY : e.clientY); startH = d.getBoundingClientRect().height; d.style.transition = "none"; };
  const onMove = e => {
    if (!pressed) return;
    const y = (e.touches ? e.touches[0].clientY : e.clientY);
    const dy = startY - y;   // up positive
    if (mode === null) {
      if (Math.abs(dy) < 5) return;
      const onHandle = e.target && e.target.closest && e.target.closest(".draghandle");
      const full = d.dataset.snap === "full";
      const atTop = box.scrollTop <= 0;
      // Handle always drags. Otherwise: dragging down drags the drawer only when the list
      // is at the top; dragging up drags the drawer unless it's already full (then scroll).
      mode = onHandle ? "drawer" : (dy < 0 ? (atTop ? "drawer" : "scroll") : (full ? "scroll" : "drawer"));
    }
    if (mode === "drawer") {
      moved = true;
      setDrawerH(Math.max(SNAPS.peek - 20, Math.min(snapPx("full") + 20, startH + dy)));
      if (e.cancelable) e.preventDefault();
    }
  };
  const onUp = () => {
    if (!pressed) return; pressed = false;
    d.style.transition = "";
    if (mode !== "drawer") { mode = null; return; }
    mode = null;
    const h = d.getBoundingClientRect().height;
    let best = "mid", bd = Infinity;
    for (const n of ["peek", "mid", "full"]) { const dist = Math.abs(snapPx(n) - h); if (dist < bd) { bd = dist; best = n; } }
    snapTo(best);
  };
  d.addEventListener("touchstart", onDown, { passive: true });
  d.addEventListener("touchmove", onMove, { passive: false });
  d.addEventListener("touchend", onUp);
  d.addEventListener("mousedown", onDown);
  addEventListener("mousemove", onMove);
  addEventListener("mouseup", onUp);
  // Tap the handle to cycle the drawer down a level and collapse (full -> mid -> peek -> full).
  handle.addEventListener("click", () => {
    if (moved) return;   // that was a drag, not a tap
    const order = ["full", "mid", "peek"];
    snapTo(order[(order.indexOf(d.dataset.snap) + 1) % order.length]);
  });
  addEventListener("resize", () => snapTo(d.dataset.snap));
}

// ---------- wire up ----------
function init() {
  newSession();
  initDrawer();
  document.getElementById("hRecenter").innerHTML = mi("recenter", 22);
  showFab(false);
  document.getElementById("hRecenter").addEventListener("click", fit);   // re-frame the selected route
  // Show the recenter FAB once you pan/zoom off a selected route (not on programmatic fits).
  map.on("dragstart", () => showFab(true));

  // Cycle / Walk toggle (defaults to cycle+transit).
  for (const b of document.querySelectorAll("#hModeTog button")) b.addEventListener("click", () => {
    if (b.dataset.m === H.mode) return;
    H.mode = b.dataset.m;
    for (const x of document.querySelectorAll("#hModeTog button")) x.classList.toggle("on", x.dataset.m === H.mode);
    H.sel = -1; H.expanded = -1; H.optionsFinal = false;
    loadRoutes(false);
  });

  // Wire both the origin and destination inputs. The search results apply to whichever
  // field is focused (H.activeField).
  const origin = document.getElementById("hOrigin"), dest = document.getElementById("hDest");
  let timer;
  const wireField = (el, field) => {
    el.addEventListener("input", () => {
      clearTimeout(timer);
      const q = el.value.trim();
      if (q.length < 2) { showResults(recents(), true); return; }
      timer = setTimeout(() => geocode(q), 220);
    });
    const selectAll = () => setTimeout(() => { try { el.select(); } catch {} }, 0);   // easy clear+retype (iOS timeout)
    // On focus always open the dropdown (with My location / Choose on map + recents).
    el.addEventListener("focus", () => { H.activeField = field; selectAll(); showResults(el.value.trim().length >= 2 ? H.places || [] : recents(), el.value.trim().length < 2); });
    el.addEventListener("click", () => { H.activeField = field; selectAll(); });
  };
  wireField(origin, "origin");
  wireField(dest, "dest");
  if (PLAN) { origin.placeholder = "Start"; dest.placeholder = "Where to?"; }
  document.addEventListener("click", e => { if (!e.target.closest(".hbar")) document.getElementById("hResults").hidden = true; });

  // ?from / ?to pin start / destination (shareable link / testing); else GPS for origin.
  const qp = new URLSearchParams(location.search);
  const parse = s => { const c = (s || "").split(",").map(Number); return c.length === 2 && c.every(Number.isFinite) ? c : null; };
  const tc = parse(qp.get("to"));
  if (tc) H.to = { name: qp.get("toName") || "Destination", lat: tc[0], lon: tc[1] };
  document.getElementById("hDest").value = H.to ? H.to.name : "";
  updateTitle();
  const fc = parse(qp.get("from"));
  if (fc) setOrigin({ name: "Pinned start", lat: fc[0], lon: fc[1] }, true);
  else locate();
  // Keep routes fresh, but never yank the list around while it's being read.
  setInterval(() => { if (!document.hidden && H.from) loadRoutes(true); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && H.from) loadRoutes(true); });
}
init();

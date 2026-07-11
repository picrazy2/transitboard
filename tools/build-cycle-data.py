#!/usr/bin/env python3
"""Regenerate the Stoke Newington *cycle* datasets — trains only.

Writes:
  src/cycle-stops.json          kept stations + the (line, direction) pairs each is nearest for
  public/stokey/cycle/geo.json  map: station points, home

Same "nearest station per (line, direction)" dedup as the walk board, but on a
10-minute *cycle* time (Valhalla bicycle) and restricted to rail. A station is
kept only if no nearer station serves one of its (line, direction) pairs.

Direction (into/out of London) is decided per station, not per line terminus:
of the two ways a line runs through a station, the one whose next stop is closer
to Charing Cross is "in". That is correct for lines that pass *through* the
centre (Piccadilly, Victoria), where a nearest-terminus rule would mislabel.

Usage: python3 tools/build-cycle-data.py
"""
import json, math, pathlib, re, time, urllib.error, urllib.parse, urllib.request

HOME = (51.5611161, -0.0739865)     # 149 Stoke Newington High St, N16 0NY
CHARING_CROSS = (51.5074, -0.1278)
CYCLE_LIMIT_S = 600                 # 10 minutes; 15 was measured to add no lines
SEARCH_RADIUS_M = 4000              # 10 min at ~15 km/h is ~2.5 km; margin for routing
RAIL_MODES = "tube,overground,dlr,elizabeth-line,national-rail"

# One OpenStreetMap route relation per line: a full end-to-end "spine" that
# passes through our station. TfL publishes no usable rail lineStrings (they come
# back empty for tube, 1 km chords for rail), so the drawn line AND the live-train
# position both ride this OSM geometry — a pin can never float off the track,
# because it is snapped to the very polyline that is drawn. Branch relations that
# diverge far from home (Heathrow vs Uxbridge, the East London Line's southern
# forks) are omitted; a train never reaches them within a few minutes of us.
SPINE = {
    "victoria":    6354920,   # Brixton <-> Walthamstow Central
    "piccadilly":  102788,    # Cockfosters <-> Heathrow T5, via Manor House
    "mildmay":     6413186,   # Stratford <-> Richmond, via Dalston Kingsland
    "windrush":    959677,    # Highbury & Islington <-> Crystal Palace, via Dalston Jn
    "suffragette": 419512,    # Gospel Oak <-> Barking Riverside, via South Tottenham
    "weaver":      9105028,   # Liverpool Street <-> Enfield Town, via Stoke Newington
}
SNAP_M = 220                        # a stop further than this from the spine is off-branch

# National Rail has no live TfL predictions and no vehicle positions anywhere in
# the public feeds, so those lines get departures from Darwin (LDBWS) at runtime
# and no live pins — there is nothing to place. Within a 10-minute cycle only one
# National Rail station is genuinely useful: Finsbury Park (Great Northern +
# Thameslink). Every other in-range "National Rail" line TfL lists is a phantom —
# checked against Darwin, Stoke Newington etc. only ever run London Overground.
#
# Direction is decided geographically: Finsbury Park is in north London, so a
# train is heading *into* London exactly when its destination lies south of the
# station (toward the central termini, or through them for Thameslink). Latitudes
# of the destinations Darwin actually returns from here — anything not listed
# defaults to "out", which is almost always right (the unknowns are outer termini).
NR_STATIONS = [{
    "crs": "FPK", "naptan": "910GFNPK", "name": "Finsbury Park",
    "lat": 51.564302, "lon": -0.106285,
    "opLines": {"GN": ("great-northern", "Great Northern"), "TL": ("thameslink", "Thameslink")},
}]
NR_DEST_LAT = {   # destination CRS -> latitude; "in" iff south of Finsbury Park (51.5643)
    "MOG": 51.5186, "KGX": 51.5308, "STP": 51.5320, "LBG": 51.5050, "BFR": 51.5117,  # central (in)
    "BTN": 50.8291, "HRH": 51.0648, "TBD": 51.1172, "GTW": 51.1565, "SEV": 51.2769,  # south (in)
    "SUO": 51.3596, "ORP": 51.3479, "RAI": 51.3610,
    "WGC": 51.8017, "SVG": 51.9017, "LET": 51.9789, "HIT": 51.9500, "GDN": 51.6559,  # north (out)
    "HFN": 51.7990, "CBG": 52.1943, "PBO": 52.5747, "KLN": 52.7510, "ELY": 52.3993,
    "LTN": 51.8783, "BDM": 52.1360, "ALX": 51.5980,
}

UA = {"User-Agent": "transitboard/1.0 (+https://board.akguo.com)"}
ROOT = pathlib.Path(__file__).resolve().parent.parent
TFL_KEY = re.search(r'TFL_APP_KEY="?([^"\n]+)"?', (ROOT / ".dev.vars").read_text()).group(1)


def haversine_km(a, b):
    R, p = 6371.0, math.pi / 180
    return 2 * R * math.asin(math.sqrt(
        math.sin((b[0] - a[0]) * p / 2) ** 2
        + math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2))


def get_json(url, data=None, headers=None, attempts=4):
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            code = getattr(e, "code", None)
            if attempt == attempts - 1 or code not in (429, 500, 502, 503, 504, None):
                raise
            time.sleep(3 * (attempt + 1))


def tfl(path, **params):
    if TFL_KEY:
        params["app_key"] = TFL_KEY
    return get_json(f"https://api.tfl.gov.uk{path}?{urllib.parse.urlencode(params)}",
                    headers={"User-Agent": "Mozilla/5.0"})


def cycle_times(targets):
    body = json.dumps({
        "sources": [{"lat": HOME[0], "lon": HOME[1]}],
        "targets": [{"lat": la, "lon": lo} for la, lo in targets],
        "costing": "bicycle", "units": "kilometers",
    }).encode()
    r = get_json("https://valhalla1.openstreetmap.de/sources_to_targets", body,
                 {"Content-Type": "application/json"})
    return [t["time"] for t in r["sources_to_targets"][0]]


is_bus = lambda name: bool(re.fullmatch(r"N?\d+", name or ""))
cc_km = lambda lat, lon: haversine_km((lat, lon), CHARING_CROSS)

OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]


def overpass(query, attempts=8):
    for a in range(attempts):
        try:
            return get_json(OVERPASS[a % len(OVERPASS)],
                            urllib.parse.urlencode({"data": query}).encode(),
                            {"Content-Type": "application/x-www-form-urlencoded"}, attempts=1)
        except Exception as e:
            if a == attempts - 1:
                raise
            time.sleep(4 * (a + 1))


def stitch(members, start_near):
    """One contiguous polyline through a route relation, oriented from `start_near`.

    Ways arrive in member order and are endpoint-contiguous, though a way may be
    digitised backwards. Cut at any discontinuity and keep the longest single run.
    (Lifted from build-stokey-data.py, which does the same for the Weaver line.)
    """
    ways = [[[n["lon"], n["lat"]] for n in m["geometry"]]
            for m in members if m["type"] == "way" and m.get("geometry") and len(m["geometry"]) >= 2]
    if not ways:
        return []
    gap = lambda a, b: haversine_km((a[1], a[0]), (b[1], b[0])) * 1000
    joins = lambda a, b: gap(a, b) < 8

    poly = ways[0][:]
    if len(ways) > 1:
        nxt = ways[1]
        if min(gap(poly[0], nxt[0]), gap(poly[0], nxt[-1])) < min(gap(poly[-1], nxt[0]), gap(poly[-1], nxt[-1])):
            poly.reverse()
    runs = [poly]
    for w in ways[1:]:
        cur = runs[-1]
        if joins(cur[-1], w[-1]) and not joins(cur[-1], w[0]):
            w = w[::-1]
        if joins(cur[-1], w[0]):
            cur.extend(w[1:])
        else:
            runs.append(w[:])
    length = lambda r: sum(gap(r[i], r[i + 1]) for i in range(len(r) - 1))
    best = max(runs, key=length)
    if gap(best[-1], start_near) < gap(best[0], start_near):
        best.reverse()
    return best


def cumulate(poly):
    c = [0.0]
    for i in range(1, len(poly)):
        c.append(c[-1] + haversine_km((poly[i - 1][1], poly[i - 1][0]), (poly[i][1], poly[i][0])) * 1000)
    return c


def snap(poly, cum, lat, lon):
    """Nearest point on `poly` to (lat,lon): returns (offset_along_m, perp_m)."""
    best = (1e18, 0.0)   # (perp, offset)
    for i in range(len(poly) - 1):
        ax, ay = poly[i]; bx, by = poly[i + 1]
        # local equirectangular metres, good enough at this scale
        kx = math.cos(math.radians(lat)) * 111320.0; ky = 110540.0
        px, py = (lon - ax) * kx, (lat - ay) * ky
        dx, dy = (bx - ax) * kx, (by - ay) * ky
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, (px * dx + py * dy) / seg2))
        perp = math.hypot(px - t * dx, py - t * dy)
        if perp < best[0]:
            best = (perp, cum[i] + t * math.sqrt(seg2))
    return best[1], best[0]

# TfL only serves live predictions for tube / Overground / DLR / Elizabeth. National
# Rail lines (Greater Anglia, Great Northern, Thameslink) come back empty from
# StopPoint/Arrivals — they need Darwin — so cycle mode leaves them out.
SERVED = {l["id"] for l in tfl("/Line/Mode/tube,overground,dlr,elizabeth-line")}
print(f"TfL-served lines available: {len(SERVED)}")

# ---------- 1. rail stations within cycle range ----------
print(f"rail stations within {SEARCH_RADIUS_M} m ...", flush=True)
raw = tfl("/StopPoint", lat=HOME[0], lon=HOME[1], stopTypes="NaptanMetroStation,NaptanRailStation",
          radius=SEARCH_RADIUS_M, modes=RAIL_MODES, returnLines="true")["stopPoints"]

stations = []
for s in raw:
    lines = [(l["id"], l["name"]) for l in (s.get("lines") or [])
             if not is_bus(l.get("name")) and l["id"] in SERVED]
    if not lines:
        continue
    stations.append({"id": s["naptanId"], "name": s["commonName"].replace(" Rail Station", "")
                     .replace(" Underground Station", "").replace(" Rail", "").strip(),
                     "lat": s["lat"], "lon": s["lon"], "lines": lines,
                     "modes": sorted(set(s.get("modes", [])) - {"bus"})})

for s, secs in zip(stations, cycle_times([(s["lat"], s["lon"]) for s in stations])):
    s["cyc_s"] = secs
    s["cyc_min"] = round(secs / 60, 1)

near = sorted([s for s in stations if s["cyc_s"] <= CYCLE_LIMIT_S], key=lambda s: (s["cyc_s"], s["id"]))
print(f"  {len(near)}/{len(stations)} within {CYCLE_LIMIT_S // 60} min cycle")

# ---------- 2. per line: where each station sits, and which way is "in" ----------
LINES = {}   # line id -> {"name", "seq": {naptan: index}, "dist": {naptan: km_to_CC}, ...}
line_ids = {lid for s in near for lid, _ in s["lines"]}
print(f"resolving {len(line_ids)} rail lines ...", flush=True)
seq_of = {}   # (lineId, direction) -> [naptanId in order]
name_of = {}
for lid in sorted(line_ids):
    for d in ("inbound", "outbound"):
        try:
            r = tfl(f"/Line/{lid}/Route/Sequence/{d}", serviceTypes="Regular")
        except Exception:
            continue
        name_of[lid] = r.get("lineName", lid)
        order = []
        for block in r.get("stopPointSequences") or []:
            for p in block.get("stopPoint") or []:
                nid = p.get("id") or p.get("stationId")
                if nid:
                    order.append((nid, p.get("lat"), p.get("lon")))
        if len(order) >= 2:
            seq_of[(lid, d)] = order


def direction_at(lid, d, naptan):
    """'in' if travelling this direction from the station heads toward central London.

    `order` runs in travel order (index increases toward the terminus). Let m be
    the index of the line's closest approach to Charing Cross. Leaving the station
    at index i, you head *into* London exactly when the centre-most point is still
    ahead of you (m > i): you have yet to pass through the middle of the line. When
    m <= i the centre is behind and you are running out to a terminus.

    This is correct for every shape: a through-line (Victoria, Piccadilly) has its
    centre mid-sequence, so the two ends classify oppositely; a radial terminating
    in the centre has m at the end, so every stop reads "in" toward it; and an
    orbital end (Windrush at Dalston, both neighbours nearer the centre) no longer
    misfires, because it is the position of the centre *relative to travel*, not a
    single-neighbour comparison, that decides.
    """
    order = seq_of.get((lid, d))
    if not order:
        return None
    ids = [n for n, _, _ in order]
    if naptan not in ids:
        return None
    i = ids.index(naptan)
    withcc = [(cc_km(lat, lon) if lat else 1e9) for _, lat, lon in order]
    m = min(range(len(order)), key=lambda k: withcc[k])
    return "in" if m > i else "out"


# Every (station, line, tfl-direction) that stops here, with the "into/out of
# London" sense of that direction *at this station*. `london` can differ between
# the two ends of a through-line, which is why it is computed per stop.
candidates = []   # (station, lineId, lineName, tflDir, london)
for s in near:
    for lid, lname in s["lines"]:
        for d in ("inbound", "outbound"):
            order = seq_of.get((lid, d))
            if not order or s["id"] not in [n for n, _, _ in order]:
                continue
            lon = direction_at(lid, d, s["id"])
            if lon:
                candidates.append((s, lid, lname, d, lon))

# ---------- 3. dedup: nearest station per (line, into/out of London) ----------
nearest = {}   # "lineId|london" -> station id  (first seen = nearest, `near` is sorted)
for s, lid, lname, d, lon in candidates:
    nearest.setdefault(f"{lid}|{lon}", s["id"])

# what each kept station serves: the arrival's (lineId, tfl-direction) -> london,
# but only the pairs it actually won the dedup for.
serve = {}       # station id -> { "lineId|inbound": "in", ... }
primary_ll = {}  # station id -> ["lineId|in", ...]  (line, london) it is nearest for
names = {}
for s, lid, lname, d, lon in candidates:
    if nearest.get(f"{lid}|{lon}") != s["id"]:
        continue
    serve.setdefault(s["id"], {})[f"{lid}|{d}"] = lon
    primary_ll.setdefault(s["id"], set()).add(f"{lid}|{lon}")
    names[lid] = lname

board = [s for s in near if s["id"] in serve]
print(f"  {len(near)} stations -> {len(board)} after dedup, "
      f"{len({p.split('|')[0] for p in nearest})} lines")
for s in board:
    lines = sorted({names[k.split('|')[0]] for k in primary_ll[s["id"]]})
    print(f"  {s['cyc_min']:>4}min  {s['name'][:24]:<25} {', '.join(lines)}")

# ---------- 3b. National Rail stations (Darwin at runtime, no live pins) ----------
nr_min = {}
if NR_STATIONS:
    for st, secs in zip(NR_STATIONS, cycle_times([(s["lat"], s["lon"]) for s in NR_STATIONS])):
        nr_min[st["crs"]] = round(secs / 60, 1)
        lines = ", ".join(n for _, n in st["opLines"].values())
        print(f"  {nr_min[st['crs']]:>4}min  {st['name'][:24]:<25} {lines}  (Darwin/{st['crs']})")

# Every station carries the same keys so cycle.ts sees one shape. TfL stations
# fill the National-Rail fields with empties; NR stations fill serve with empties.
station_objs = [{
    "id": s["id"], "name": s["name"], "lat": s["lat"], "lon": s["lon"],
    "cycMin": s["cyc_min"], "modes": s["modes"],
    # arrival.lineId + "|" + arrival.direction -> "in" / "out". A live train is
    # shown here only if this map has its key.
    "serve": serve[s["id"]],
    "lineNames": {k.split("|")[0]: names[k.split("|")[0]] for k in primary_ll[s["id"]]},
    "nr": False, "crs": "", "opLines": {}, "destDir": {},
} for s in board]
for st in NR_STATIONS:
    dest_dir = {crs: ("in" if lat < st["lat"] else "out") for crs, lat in NR_DEST_LAT.items()}
    station_objs.append({
        "id": st["naptan"], "name": st["name"], "lat": st["lat"], "lon": st["lon"],
        "cycMin": nr_min[st["crs"]], "modes": ["national-rail"],
        "serve": {}, "lineNames": {lid: nm for lid, nm in st["opLines"].values()},
        # Darwin returns operatorCode + destination CRS, no line or direction.
        "nr": True, "crs": st["crs"],
        "opLines": {op: {"lineId": lid, "name": nm} for op, (lid, nm) in st["opLines"].items()},
        "destDir": dest_dir,
    })

# ---------- 4. write ----------
(ROOT / "src").mkdir(exist_ok=True)
(ROOT / "src" / "cycle-stops.json").write_text(json.dumps({
    "home": {"lat": HOME[0], "lon": HOME[1]},
    "mode": "cycle",
    "limitMin": CYCLE_LIMIT_S // 60,
    "stations": station_objs,
}, indent=2) + "\n")

features = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(s["lon"], 5), round(s["lat"], 5)]},
            "properties": {"kind": "station", "id": s["id"], "name": s["name"],
                           "cyc_min": s["cyc_min"], "modes": s["modes"],
                           "lines": sorted({names[k.split('|')[0]] for k in primary_ll[s["id"]]}),
                           "onBoard": True}} for s in board]
# other in-range stations that the dedup dropped: show as faint dots
for s in near:
    if s["id"] not in serve:
        features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(s["lon"], 5), round(s["lat"], 5)]},
                         "properties": {"kind": "station", "id": s["id"], "name": s["name"],
                                        "cyc_min": s["cyc_min"], "onBoard": False}})
# National Rail board stations get a labelled dot like the others; no line is
# drawn (National Rail has no live positions, so nothing rides it).
for st in NR_STATIONS:
    features.append({"type": "Feature",
                     "geometry": {"type": "Point", "coordinates": [round(st["lon"], 5), round(st["lat"], 5)]},
                     "properties": {"kind": "station", "id": st["naptan"], "name": st["name"],
                                    "cyc_min": nr_min[st["crs"]], "modes": ["national-rail"],
                                    "lines": sorted(n for _, n in st["opLines"].values()), "onBoard": True}})

features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [HOME[1], HOME[0]]},
                 "properties": {"kind": "home", "name": "149 Stoke Newington High St"}})

# ---------- OSM spine geometry: one polyline per line, drawn and snapped ----------
# The same polyline is drawn on the map (LineString features above) and used to
# position live trains (src/cycle.ts), so a pin is always exactly on the line.
print("rail geometry (OpenStreetMap spines) ...", flush=True)
kept_lines = {k.split("|")[0] for k in nearest}
spine_poly = {}   # lineId -> [[lon,lat], ...]  (undirected, as digitised)
for lid in sorted(kept_lines):
    rel_id = SPINE.get(lid)
    if not rel_id:
        print(f"  !! {lid}: no SPINE relation configured, skipping geometry")
        continue
    rel = overpass(f"[out:json][timeout:120];rel({rel_id});out geom;")["elements"][0]
    poly = stitch(rel["members"], (HOME[1], HOME[0]))
    spine_poly[lid] = poly
    km = cumulate(poly)[-1] / 1000 if len(poly) > 1 else 0
    features.append({"type": "Feature",
                     "geometry": {"type": "LineString", "coordinates": [[round(x, 5), round(y, 5)] for x, y in poly]},
                     "properties": {"kind": "rail", "line": names[lid], "lineId": lid}})
    print(f"  {names[lid]:<12} rel {rel_id}: {len(poly)} vertices, {km:.1f} km")

out = ROOT / "public" / "stokey" / "cycle" / "geo.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")) + "\n")

# ---------- routes for live positions: track + each stop's offset along it ----------
# routes["lineId|tflDir"] = {track: [[lon,lat],...], stops: [[lon,lat,naptan,offset_m],...]}
# The track is the spine oriented to the direction's travel; stops are the TfL
# sequence snapped onto it (off-branch stops that snap too far are dropped).
routes = {}
for (lid, d), order in seq_of.items():
    if lid not in spine_poly:
        continue
    coords = [(nid, lat, lon) for nid, lat, lon in order if lat is not None]
    if len(coords) < 2:
        continue
    poly = spine_poly[lid][:]
    first = (coords[0][1], coords[0][2])
    if haversine_km((poly[-1][1], poly[-1][0]), first) < haversine_km((poly[0][1], poly[0][0]), first):
        poly = poly[::-1]
    cum = cumulate(poly)
    stops = []
    for nid, lat, lon in coords:
        off, perp = snap(poly, cum, lat, lon)
        if perp <= SNAP_M:
            stops.append([round(lon, 5), round(lat, 5), nid, round(off)])
    stops.sort(key=lambda s: s[3])
    dedup = []
    for s in stops:
        if not dedup or s[2] != dedup[-1][2]:
            dedup.append(s)
    if len(dedup) >= 2:
        routes[f"{lid}|{d}"] = {"track": [[round(x, 5), round(y, 5)] for x, y in poly], "stops": dedup}

(ROOT / "src" / "cycle-routes.json").write_text(json.dumps(routes, separators=(",", ":")) + "\n")
print(f"wrote src/cycle-routes.json ({len(routes)} route-directions, "
      f"{sum(len(r['stops']) for r in routes.values())} snapped stops)")
print(f"wrote src/cycle-stops.json ({len(board)} stations)")
print(f"wrote {out.relative_to(ROOT)} ({len(features)} features)")

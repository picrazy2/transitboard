#!/usr/bin/env python3
"""Regenerate the static Stoke Newington datasets.

Writes:
  src/stokey-stops.json   stop list + the (line, direction) pairs each stop is nearest for
  src/stokey-routes.json  per route-direction: polyline + where each stop sits on it,
                          used to estimate live bus positions (see src/vehicles.ts)
  public/stokey/geo.json  map geometry: bus routes, Weaver line, stops, home

Nothing is clipped: routes and stops run to the ends of their lines so the map
can be panned. Bus geometry comes from TfL (~27 m between vertices, road-following).
Rail geometry comes from OpenStreetMap (~16 m); TfL's rail lineStrings are
straight chords between stations (~1200 m) and look wrong on a map.

Walk times are pedestrian routes from Valhalla, not crow-flies: a 900 m radius
around home reaches route 488, but no 488 stop is actually within a 10 min walk.

Usage: python3 tools/build-stokey-data.py
"""
import json, math, pathlib, sys, time, urllib.error, urllib.parse, urllib.request

HOME = (51.5611161, -0.0739865)  # 149 Stoke Newington High St, N16 0NY
CHARING_CROSS = (51.5074, -0.1278)  # the conventional centre of London
WALK_LIMIT_S = 600               # 10 minutes
SEARCH_RADIUS_M = 900            # safe superset: 600 s at Valhalla's 5.1 km/h is 850 m
RAIL_NAPTAN = "910GSTKNWNG"      # Stoke Newington Rail Station (Weaver), CRS SKW
RAIL_LINE_ID = "weaver"
RAIL_IN_DIRECTION = "inbound"    # verified: Weaver inbound = London Liverpool Street
RAIL_IN_DESTINATION = "910GLIVST"  # ArrivalDepartures carries no direction, only destination
# Both Weaver branches that call at Stoke Newington (Enfield Town, Cheshunt).
WEAVER_OSM_RELS = (9105028, 9105027)
MAP_HOME_ZOOM_PAD = 0.18         # initial framing only; the map pans freely

UA = {"User-Agent": "transitboard/1.0 (+https://board.akguo.com)"}
ROOT = pathlib.Path(__file__).resolve().parent.parent


# TfL's inbound/outbound says nothing about London: the 67's *inbound* runs to
# Wood Green (out) while the 149's *outbound* runs to London Bridge (in). So we
# classify per line: of its two termini, the one nearer Charing Cross is "in".
# A plain distance threshold would not do — both of the 106's termini are nearer
# the centre than we are.
#
# That rule is meaningless for orbital routes, which never approach the centre.
# Those are named here explicitly.
MANUAL_DIRECTION = {
    # 276 runs Stoke Newington Common <-> Newham Hospital, entirely east of us.
    "276|inbound": "out",   # -> Gateway Surgical Centre, Newham
    "276|outbound": "out",  # -> Stoke Newington Common, terminates 400 m away
}


def haversine_km(a, b):
    R, p = 6371.0, math.pi / 180
    return 2 * R * math.asin(math.sqrt(
        math.sin((b[0] - a[0]) * p / 2) ** 2
        + math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2))


def get_json(url, data=None, headers=None, attempts=4):
    """Overpass and TfL both throttle; a plain 504 should not lose 3 minutes of work."""
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            code = getattr(e, "code", None)
            retryable = code in (429, 502, 503, 504) or code is None
            if attempt == attempts - 1 or not retryable:
                raise
            wait = 3 * (attempt + 1)
            print(f"  retry {attempt + 1}/{attempts - 1} after {code or type(e).__name__}, waiting {wait}s", flush=True)
            time.sleep(wait)


def tfl(path, **params):
    return get_json(f"https://api.tfl.gov.uk{path}?{urllib.parse.urlencode(params)}")


_seq_cache = {}


def sequence(line, direction):
    """Route sequence for a line+direction. Fetched once; used three times."""
    key = (line, direction)
    if key not in _seq_cache:
        _seq_cache[key] = tfl(f"/Line/{line}/Route/Sequence/{direction}", serviceTypes="Regular")
    return _seq_cache[key]


def walk_times(targets):
    """One-to-many pedestrian matrix from HOME."""
    body = json.dumps({
        "sources": [{"lat": HOME[0], "lon": HOME[1]}],
        "targets": [{"lat": lat, "lon": lon} for lat, lon in targets],
        "costing": "pedestrian", "units": "kilometers",
    }).encode()
    r = get_json("https://valhalla1.openstreetmap.de/sources_to_targets", body,
                 {"Content-Type": "application/json"})
    return [t["time"] for t in r["sources_to_targets"][0]]



# ---------- 1. bus stops within a 10 minute walk ----------
print(f"stops within {SEARCH_RADIUS_M} m ...", flush=True)
raw = tfl("/StopPoint", lat=HOME[0], lon=HOME[1], stopTypes="NaptanPublicBusCoachTram",
          radius=SEARCH_RADIUS_M, returnLines="true")["stopPoints"]

stops = []
for s in raw:
    lines = sorted({l["name"] for l in (s.get("lines") or [])})
    if not lines:
        continue
    towards = next((p["value"] for p in (s.get("additionalProperties") or [])
                    if p.get("key") == "Towards"), "")
    stops.append({"id": s["naptanId"], "name": s["commonName"], "letter": s.get("stopLetter") or "",
                  "lat": s["lat"], "lon": s["lon"], "towards": towards, "lines": lines})

for s, secs in zip(stops, walk_times([(s["lat"], s["lon"]) for s in stops])):
    s["walk_s"] = secs
    s["walk_min"] = round(secs / 60, 1)

near = sorted([s for s in stops if s["walk_s"] <= WALK_LIMIT_S], key=lambda s: (s["walk_s"], s["id"]))
excluded_lines = {l for s in stops for l in s["lines"]} - {l for s in near for l in s["lines"]}
print(f"  {len(near)}/{len(stops)} within {WALK_LIMIT_S // 60} min"
      + (f"; dropped line(s) {sorted(excluded_lines)} (in radius, not in walk time)" if excluded_lines else ""))

# ---------- 2. which direction does each line run at each stop ----------
BUS_LINES = sorted({l for s in near for l in s["lines"]})
print(f"resolving directions for {len(BUS_LINES)} lines ...", flush=True)
stop_dirs, terminus, term_km = {}, {}, {}
for ln in BUS_LINES:
    for d in ("inbound", "outbound"):
        seq = sequence(ln, d)
        for block in seq.get("stopPointSequences") or []:
            sp = block.get("stopPoint") or []
            if sp and f"{ln}|{d}" not in terminus:
                terminus[f"{ln}|{d}"] = sp[-1].get("name", "?")
                term_km[f"{ln}|{d}"] = haversine_km((sp[-1]["lat"], sp[-1]["lon"]), CHARING_CROSS)
            for p in sp:
                nid = p.get("id") or p.get("stationId")
                if nid:
                    stop_dirs.setdefault(nid, {}).setdefault(ln, set()).add(d)

# ---------- 2b. into London, or out of it? ----------
london = {}
for ln in BUS_LINES:
    pair = {d: f"{ln}|{d}" for d in ("inbound", "outbound")}
    if all(p in term_km for p in pair.values()):
        nearer = min(pair.values(), key=lambda p: term_km[p])
        for p in pair.values():
            london[p] = "in" if p == nearer else "out"
london.update({p: v for p, v in MANUAL_DIRECTION.items() if p in terminus})

home_km = haversine_km(HOME, CHARING_CROSS)
print(f"  into/out of London (home is {home_km:.1f} km from Charing Cross):")
for p in sorted(london, key=lambda p: (london[p], p)):
    flag = " [manual]" if p in MANUAL_DIRECTION else ""
    print(f"    {london[p]:<3} {p:<14} {terminus[p][:32]:<33} {term_km[p]:5.1f} km{flag}")

for s in near:
    s["pairs"] = sorted(f"{l}|{d}" for l in s["lines"] for d in stop_dirs.get(s["id"], {}).get(l, ()))

# ---------- 3. keep only stops that are nearest for some (line, direction) ----------
nearest = {}
for s in near:                      # already sorted by walk time
    for p in s["pairs"]:
        nearest.setdefault(p, s["id"])

primary = {}
for pair, sid in nearest.items():
    primary.setdefault(sid, []).append(pair)

board = [{**s, "primary": sorted(primary[s["id"]])} for s in near if s["id"] in primary]
covered = set(nearest)
assert covered == {p for s in near for p in s["pairs"]}, "lost a line/direction pair"
print(f"  {len(near)} stops -> {len(board)} on the board, covering all {len(covered)} (line, direction) pairs")

(ROOT / "src").mkdir(exist_ok=True)
(ROOT / "src" / "stokey-stops.json").write_text(json.dumps({
    "home": {"lat": HOME[0], "lon": HOME[1]},
    "rail": {"naptan": RAIL_NAPTAN, "line": "Weaver", "lineId": RAIL_LINE_ID,
             "inDirection": RAIL_IN_DIRECTION, "inDestinationNaptan": RAIL_IN_DESTINATION},
    "terminus": terminus,
    "london": london,
    "stops": [{k: s[k] for k in ("id", "name", "letter", "lat", "lon", "walk_min", "primary")} for s in board],
}, indent=2) + "\n")

# ---------- 4. map geometry ----------
# Nothing is clipped: the map opens framed on the flat, but you can pan out to
# either end of any route.
rnd = lambda path: [[round(x, 5), round(y, 5)] for x, y in path]

print("bus route geometry (TfL) ...", flush=True)
features = []
for ln in BUS_LINES:
    for d in ("inbound", "outbound"):
        for s in sequence(ln, d).get("lineStrings") or []:
            for path in json.loads(s):
                if len(path) < 2:
                    continue
                features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": rnd(path)},
                                 "properties": {"kind": "bus", "line": ln, "dir": d, "night": ln.startswith("N")}})

print("rail geometry (OpenStreetMap) ...", flush=True)
# Both branches that call at Stoke Newington. They share track most of the way,
# so ways are deduplicated by id.
seen_ways, rail_ways = set(), []
for rel in WEAVER_OSM_RELS:
    q = f"[out:json][timeout:90];rel({rel});way(r);out geom;"
    for w in get_json("https://overpass-api.de/api/interpreter",
                      urllib.parse.urlencode({"data": q}).encode(),
                      {"Content-Type": "application/x-www-form-urlencoded"})["elements"]:
        if w["id"] not in seen_ways:
            seen_ways.add(w["id"])
            rail_ways.append(w)
for w in rail_ways:
    path = [[n["lon"], n["lat"]] for n in w.get("geometry", [])]
    if len(path) >= 2:
        features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": rnd(path)},
                         "properties": {"kind": "rail", "line": "Weaver"}})
print(f"  {len(rail_ways)} ways across {len(WEAVER_OSM_RELS)} branches")

# Every stop on every route we show, so panning down the line still has stops on
# it. The ones within a 10 min walk carry their walk time; the board's 7 are
# flagged onBoard and are the only ones the map labels.
walkable = {s["id"]: s for s in near}
all_stops = {}
for ln in BUS_LINES:
    for d in ("inbound", "outbound"):
        blocks = sequence(ln, d).get("stopPointSequences") or []
        for sp in (blocks[0].get("stopPoint") or []) if blocks else []:
            sid = sp.get("id")
            if not sid:
                continue
            e = all_stops.setdefault(sid, {"lat": sp["lat"], "lon": sp["lon"],
                                           "name": sp.get("name", ""), "letter": sp.get("stopLetter") or "",
                                           "lines": set()})
            e["lines"].add(ln)

for sid, s in all_stops.items():
    w = walkable.get(sid)
    props = {"kind": "stop", "id": sid, "name": w["name"] if w else s["name"],
             "letter": s["letter"], "lines": sorted(s["lines"]),
             "onBoard": sid in primary, "near": bool(w)}
    if w:
        props["walk_min"] = w["walk_min"]
        props["towards"] = w["towards"]
    features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(s["lon"], 5), round(s["lat"], 5)]},
                     "properties": props})
print(f"  {len(all_stops)} bus stops on the map, {len(walkable)} within a 10 min walk, {len(primary)} on the board")

# Every Weaver station gets a dot; only the one with departures gets a label.
# Rectory Road is a 7.7 min walk but every train calls at Stoke Newington first.
weaver_stops = tfl(f"/Line/{RAIL_LINE_ID}/StopPoints")
station_walk = walk_times([(s["lat"], s["lon"]) for s in weaver_stops])
for s, w in zip(weaver_stops, station_walk):
    props = {"kind": "station", "line": "Weaver", "id": s["naptanId"],
             "name": s["commonName"].replace(" Rail Station", ""),
             "onBoard": s["naptanId"] == RAIL_NAPTAN, "near": w <= WALK_LIMIT_S}
    if w <= WALK_LIMIT_S:
        props["walk_min"] = round(w / 60, 1)
    features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(s["lon"], 5), round(s["lat"], 5)]},
                     "properties": props})
print(f"  {len(weaver_stops)} Weaver stations, "
      f"{sum(1 for w in station_walk if w <= WALK_LIMIT_S)} within a 10 min walk")

features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [HOME[1], HOME[0]]},
                 "properties": {"kind": "home", "name": "149 Stoke Newington High St"}})

# ---------- 5. route polylines + stop offsets, for estimating live bus positions ----------
# TfL publishes no bus coordinates (`currentLocation` is always empty), so
# src/vehicles.ts back-projects a bus from its next stop along the route. That
# needs the full, unclipped polyline and each stop's vertex on it.
print("route polylines for vehicle positions ...", flush=True)
routes = {}
for ln in BUS_LINES:
    for d in ("inbound", "outbound"):
        seq = sequence(ln, d)
        paths = [p for s in (seq.get("lineStrings") or []) for p in json.loads(s)]
        poly = max(paths, key=len) if paths else []
        blocks = seq.get("stopPointSequences") or []
        sp = (blocks[0].get("stopPoint") or []) if blocks else []
        if len(poly) < 2 or len(sp) < 2:
            print(f"  !! {ln}|{d}: no usable geometry, skipping")
            continue

        # Walk forward only, so stop offsets stay monotonic along the route even
        # where the polyline doubles back on itself.
        idx, cursor = [], 0
        for st in sp:
            best, best_d = cursor, None
            for i in range(cursor, len(poly)):
                dd = (poly[i][0] - st["lon"]) ** 2 + (poly[i][1] - st["lat"]) ** 2
                if best_d is None or dd < best_d:
                    best_d, best = dd, i
            idx.append(best)
            cursor = best
        routes[f"{ln}|{d}"] = {
            "poly": [[round(x, 5), round(y, 5)] for x, y in poly],
            "stops": [s["id"] for s in sp],
            "idx": idx,
        }

(ROOT / "src" / "stokey-routes.json").write_text(
    json.dumps(routes, separators=(",", ":")) + "\n")
rj = ROOT / "src" / "stokey-routes.json"
print(f"  {len(routes)} route-directions, {rj.stat().st_size // 1024} KB")

out = ROOT / "public" / "stokey" / "geo.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")) + "\n")
print(f"\nwrote src/stokey-stops.json ({len(board)} stops)")
print(f"wrote public/stokey/geo.json ({len(features)} features, {out.stat().st_size // 1024} KB)")

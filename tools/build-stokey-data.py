#!/usr/bin/env python3
"""Regenerate the static Stoke Newington datasets.

Writes:
  src/stokey-stops.json   stop list + the (line, direction) pairs each stop is nearest for
  public/stokey/geo.json  map geometry: bus routes, Weaver line, stops, home

Bus geometry comes from TfL (~27 m between vertices, road-following).
Rail geometry comes from OpenStreetMap (~16 m); TfL's rail lineStrings are
straight chords between stations (~1200 m) and look wrong on a map.

Walk times are pedestrian routes from Valhalla, not crow-flies: a 900 m radius
around home reaches route 488, but no 488 stop is actually within a 10 min walk.

Usage: python3 tools/build-stokey-data.py
"""
import json, math, pathlib, sys, urllib.request, urllib.parse

HOME = (51.5611161, -0.0739865)  # 149 Stoke Newington High St, N16 0NY
WALK_LIMIT_S = 600               # 10 minutes
SEARCH_RADIUS_M = 900            # safe superset: 600 s at Valhalla's 5.1 km/h is 850 m
RAIL_NAPTAN = "910GSTKNWNG"      # Stoke Newington Rail Station (Weaver)
WEAVER_OSM_REL = 9105028         # "Weaver Line: Liverpool Street -> Enfield Town"
BBOX = (51.5476, -0.0955, 51.5746, -0.0525)  # ~1.5 km around home

UA = {"User-Agent": "transitboard/1.0 (+https://board.akguo.com)"}
ROOT = pathlib.Path(__file__).resolve().parent.parent


def get_json(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def tfl(path, **params):
    return get_json(f"https://api.tfl.gov.uk{path}?{urllib.parse.urlencode(params)}")


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


def clip(coords):
    """Split a [lon,lat] path into the runs that fall inside BBOX."""
    s, w, n, e = BBOX
    inside = lambda p: w <= p[0] <= e and s <= p[1] <= n
    runs, cur = [], []
    for i, p in enumerate(coords):
        near = inside(p) or (i and inside(coords[i - 1])) or (i + 1 < len(coords) and inside(coords[i + 1]))
        if near:
            cur.append(p)
        elif cur:
            runs.append(cur); cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2]


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
stop_dirs, terminus = {}, {}
for ln in BUS_LINES:
    for d in ("inbound", "outbound"):
        seq = tfl(f"/Line/{ln}/Route/Sequence/{d}", serviceTypes="Regular")
        for block in seq.get("stopPointSequences") or []:
            sp = block.get("stopPoint") or []
            if sp:
                terminus.setdefault(f"{ln}|{d}", sp[-1].get("name", "?"))
            for p in sp:
                nid = p.get("id") or p.get("stationId")
                if nid:
                    stop_dirs.setdefault(nid, {}).setdefault(ln, set()).add(d)

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
    "rail": {"naptan": RAIL_NAPTAN, "line": "Weaver"},
    "terminus": terminus,
    "stops": [{k: s[k] for k in ("id", "name", "letter", "lat", "lon", "walk_min", "primary")} for s in board],
}, indent=2) + "\n")

# ---------- 4. map geometry ----------
print("bus route geometry (TfL) ...", flush=True)
features = []
for ln in BUS_LINES:
    for d in ("inbound", "outbound"):
        for s in tfl(f"/Line/{ln}/Route/Sequence/{d}", serviceTypes="Regular").get("lineStrings") or []:
            for path in json.loads(s):
                for run in clip(path):
                    features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": run},
                                     "properties": {"kind": "bus", "line": ln, "dir": d, "night": ln.startswith("N")}})

print("rail geometry (OpenStreetMap) ...", flush=True)
q = f"[out:json][timeout:90];rel({WEAVER_OSM_REL});way(r);out geom;"
ways = get_json("https://overpass-api.de/api/interpreter",
                urllib.parse.urlencode({"data": q}).encode(),
                {"Content-Type": "application/x-www-form-urlencoded"})["elements"]
for w in ways:
    path = [[n["lon"], n["lat"]] for n in w.get("geometry", [])]
    for run in clip(path):
        features.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": run},
                         "properties": {"kind": "rail", "line": "Weaver"}})

for s in near:
    features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
                     "properties": {"kind": "stop", "id": s["id"], "name": s["name"], "letter": s["letter"],
                                    "walk_min": s["walk_min"], "lines": s["lines"],
                                    "onBoard": s["id"] in primary, "towards": s["towards"]}})

rail_stop = tfl(f"/StopPoint/{RAIL_NAPTAN}")
features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [rail_stop["lon"], rail_stop["lat"]]},
                 "properties": {"kind": "station", "name": "Stoke Newington", "line": "Weaver"}})
features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [HOME[1], HOME[0]]},
                 "properties": {"kind": "home", "name": "149 Stoke Newington High St"}})

out = ROOT / "public" / "stokey" / "geo.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"type": "FeatureCollection", "bbox": [BBOX[1], BBOX[0], BBOX[3], BBOX[2]],
                           "features": features}, separators=(",", ":")) + "\n")
print(f"\nwrote src/stokey-stops.json ({len(board)} stops)")
print(f"wrote public/stokey/geo.json ({len(features)} features, {out.stat().st_size // 1024} KB)")

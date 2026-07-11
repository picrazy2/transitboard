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

# ---------- 1. rail stations within cycle range ----------
print(f"rail stations within {SEARCH_RADIUS_M} m ...", flush=True)
raw = tfl("/StopPoint", lat=HOME[0], lon=HOME[1], stopTypes="NaptanMetroStation,NaptanRailStation",
          radius=SEARCH_RADIUS_M, modes=RAIL_MODES, returnLines="true")["stopPoints"]

stations = []
for s in raw:
    lines = [(l["id"], l["name"]) for l in (s.get("lines") or []) if not is_bus(l.get("name"))]
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
    """'in' if the next stop this direction is closer to Charing Cross, else 'out'."""
    order = seq_of.get((lid, d))
    if not order:
        return None
    ids = [n for n, _, _ in order]
    if naptan not in ids:
        return None
    i = ids.index(naptan)
    here = order[i]
    nxt = order[i + 1] if i + 1 < len(order) else order[i - 1]
    d_here = cc_km(here[1], here[2]) if here[1] else 1e9
    d_next = cc_km(nxt[1], nxt[2]) if nxt[1] else 1e9
    toward = d_next < d_here
    # for the last stop we compared backwards, so flip
    if i + 1 >= len(order):
        toward = not toward
    return "in" if toward else "out"


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

# ---------- 4. write ----------
(ROOT / "src").mkdir(exist_ok=True)
(ROOT / "src" / "cycle-stops.json").write_text(json.dumps({
    "home": {"lat": HOME[0], "lon": HOME[1]},
    "mode": "cycle",
    "limitMin": CYCLE_LIMIT_S // 60,
    "stations": [{
        "id": s["id"], "name": s["name"], "lat": s["lat"], "lon": s["lon"],
        "cycMin": s["cyc_min"], "modes": s["modes"],
        # arrival.lineId + "|" + arrival.direction -> "in" / "out". A live train
        # is shown here only if this map has its key.
        "serve": serve[s["id"]],
        "lineNames": {k.split("|")[0]: names[k.split("|")[0]] for k in primary_ll[s["id"]]},
    } for s in board],
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
features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [HOME[1], HOME[0]]},
                 "properties": {"kind": "home", "name": "149 Stoke Newington High St"}})

out = ROOT / "public" / "stokey" / "cycle" / "geo.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")) + "\n")
print(f"\nwrote src/cycle-stops.json ({len(board)} stations)")
print(f"wrote {out.relative_to(ROOT)} ({len(features)} features)")

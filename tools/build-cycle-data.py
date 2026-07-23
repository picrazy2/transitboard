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

# Extra branch geometry for positioning trains a line's main spine doesn't cover.
# The Weaver spine is the Enfield branch, so a Chingford train (caught at Clapton)
# has no track to ride; this gives it one, emitted as "weaver|<dir>|chingford".
BRANCH_SPINE = {"weaver": {"chingford": 9683729}}

# Prefer a specific station for a line over the marginally-nearer one, when it is a
# much better interchange for the way you actually travel. Finsbury Park (Victoria,
# Great Northern, Thameslink — a real gateway into London) is preferred for the
# Piccadilly over Manor House, which is a shade closer but a dead-end for onward
# travel. Its Piccadilly (TfL) and Great Northern/Thameslink (RTT) merge into one
# station. naptan is the Underground stop so /StopPoint arrivals return the tube.
# Victoria is also served from Finsbury Park rather than its marginally-nearer Seven
# Sisters: Finsbury Park is one stop inbound (you usually travel into London) and the
# cycle time is within ~1 min, so it's the better boarding point — and it's already the
# station serving the Piccadilly, so the two consolidate.
PREFER = {"piccadilly": "940GZZLUFPK", "victoria": "940GZZLUFPK"}   # lineId -> station naptan to serve it from

# For *drawing* the whole line, every branch — not just the spine. One relation
# per distinct branch; shared trunk ways are de-duplicated by OSM way id, so
# overlap is free. The spine above still positions the pins (a train near us is
# on the trunk, so one polyline is enough). Discovered from OSM route relations.
BRANCHES = {
    "victoria":    [6354920],                              # no branches
    "suffragette": [419512],                               # no branches
    "weaver":      [9105028, 9105027, 9683729],            # Enfield Town + Cheshunt + Chingford
    "mildmay":     [6413186, 9674325],                     # Richmond + Clapham Junction
    "piccadilly":  [102788, 7703380, 7703382],             # Heathrow T5 + T4 loop + Uxbridge
    "windrush":    [959677, 660463, 660462, 2755611, 10028997],  # Crystal Palace/New Cross/W Croydon/Clapham Jn/Battersea
}

# National Rail is enumerated live from the Realtime Trains API (data.rtt.io), not
# hand-curated: for every in-range station we ask RTT which operators genuinely run
# there, so phantoms (TfL lists NR where no train actually stops) fall out on their
# own. Direction is geographic — a destination south of the station heads "into
# London". Station and destination coordinates come from a public CRS dataset.
# See the rtt-api / transitboard-data-sources memories.
NR_TOC = {"GN": ("great-northern", "Great Northern"),
          "TL": ("thameslink", "Thameslink"),
          "LE": ("greater-anglia", "Greater Anglia")}   # LO (Overground) / XR (Elizabeth) are TfL-served
STATIONS_CSV = "https://raw.githubusercontent.com/davwheat/uk-railway-stations/refs/heads/main/stations.csv"
RTT_REFRESH = re.search(r'RTT_TOKEN="?([^"\n]+)', (pathlib.Path(__file__).resolve().parent.parent / ".dev.vars").read_text()).group(1)

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
    """One polyline through a route relation, oriented from `start_near`.

    Two phases. First, chain ways that actually touch (small threshold) into
    maximal contiguous *runs* — this alone gives the right line for a cleanly
    mapped relation, ignoring spurs and sidings. Then merge only *substantial*
    runs across bigger gaps, to bridge genuine OSM mapping breaks (e.g. Piccadilly
    has a ~2 km gap around Wood Green) without vacuuming up nearby junk the way a
    single large threshold did (it ballooned Mildmay and Suffragette).
    """
    ways = [[[n["lon"], n["lat"]] for n in m["geometry"]]
            for m in members if m["type"] == "way" and m.get("geometry") and len(m["geometry"]) >= 2]
    if not ways:
        return []
    gap = lambda a, b: haversine_km((a[1], a[0]), (b[1], b[0])) * 1000
    length = lambda r: sum(gap(r[i], r[i + 1]) for i in range(len(r) - 1))
    SMALL, BRIDGE, SUBSTANTIAL = 40, 2600, 800  # metres

    # phase 1: contiguous runs
    pool, runs = ways[:], []
    while pool:
        chain = pool.pop(0)
        grew = True
        while grew and pool:
            grew = False
            for i, w in enumerate(pool):
                if gap(chain[-1], w[0]) < SMALL: chain = chain + w[1:]
                elif gap(chain[-1], w[-1]) < SMALL: chain = chain + w[::-1][1:]
                elif gap(chain[0], w[-1]) < SMALL: chain = w[:-1] + chain
                elif gap(chain[0], w[0]) < SMALL: chain = w[::-1][:-1] + chain
                else: continue
                pool.pop(i); grew = True; break
        runs.append(chain)

    # phase 2: merge substantial runs across bigger gaps
    runs = sorted((r for r in runs if length(r) > SUBSTANTIAL), key=length, reverse=True)
    best = runs.pop(0) if runs else []
    grew = True
    while grew and runs:
        grew = False
        bi, bd, bmerge = -1, BRIDGE, None
        for i, r in enumerate(runs):
            for cand in (r, r[::-1]):
                if gap(best[-1], cand[0]) < bd: bd, bi, bmerge = gap(best[-1], cand[0]), i, ("tail", cand)
                if gap(best[0], cand[-1]) < bd: bd, bi, bmerge = gap(best[0], cand[-1]), i, ("head", cand)
        if bi < 0: break
        runs.pop(bi); side, cand = bmerge
        best = best + cand[1:] if side == "tail" else cand[:-1] + best
        grew = True
    if best and gap(best[-1], start_near) < gap(best[0], start_near):
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


# ---------- National Rail via Realtime Trains ----------
def get_bytes(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def rtt_access_token():
    return get_json("https://data.rtt.io/api/get_access_token",
                    headers={"Authorization": f"Bearer {RTT_REFRESH}"})["token"]


def norm_name(s):
    s = re.sub(r"\(.*?\)", "", s or "").lower()
    s = re.sub(r"[^a-z ]", " ", s)
    return re.sub(r"\s+", " ", s).replace("rail station", "").strip()


def load_crs_ref():
    """davwheat CRS dataset -> (list of (crs,name,lat,lon), norm_name->lat)."""
    import csv
    cache = ROOT / "tools" / "cache" / "uk-stations.csv"
    if not cache.exists():
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(get_bytes(STATIONS_CSV))
    ref, name2lat = [], {}
    for r in csv.DictReader(cache.open()):
        if not r["crsCode"]:
            continue
        lat, lon = float(r["lat"]), float(r["long"])
        ref.append((r["crsCode"], r["stationName"], lat, lon))
        name2lat[norm_name(r["stationName"])] = lat
    return ref, name2lat


def nearest_crs(lat, lon, ref):
    best = min(ref, key=lambda c: haversine_km((lat, lon), (c[2], c[3])))
    return best[0] if haversine_km((lat, lon), (best[2], best[3])) * 1000 < 250 else None


def nr_services(crs, at):
    """RTT location board -> [(opCode, opName, destDescription)], genuine NR only."""
    try:
        d = get_json(f"https://data.rtt.io/gb-nr/location?code={crs}",
                     headers={"Authorization": f"Bearer {at}"})
    except Exception:
        return []
    out = []
    for svc in (d.get("services") or []):
        op = (svc.get("scheduleMetadata") or {}).get("operator") or {}
        if op.get("code") not in NR_TOC:
            continue
        dest = ((svc.get("destination") or [{}])[0].get("location") or {})
        out.append((op["code"], op.get("name"), dest.get("description") or ""))
    return out


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

# ---------- 1b. National Rail stations, enumerated live from Realtime Trains ----------
# For every in-range NR station we ask RTT which operators actually run: phantoms
# (TfL lists NR at Overground-only stations) return nothing and drop out. Each real
# service classifies into/out of London by whether its destination is south of us.
print("National Rail (Realtime Trains) ...", flush=True)
crs_ref, name2lat = load_crs_ref()
rtt_at = rtt_access_token()
nr_raw = tfl("/StopPoint", lat=HOME[0], lon=HOME[1], stopTypes="NaptanRailStation",
             radius=SEARCH_RADIUS_M, modes="national-rail", returnLines="true")["stopPoints"]
nr_pts = [{"id": s["naptanId"], "name": s["commonName"].replace(" Rail Station", "").strip(),
           "lat": s["lat"], "lon": s["lon"], "modes": ["national-rail"]} for s in nr_raw]
for s, secs in zip(nr_pts, cycle_times([(p["lat"], p["lon"]) for p in nr_pts])):
    s["cyc_s"], s["cyc_min"] = secs, round(secs / 60, 1)

nr_stations = []   # in-range stations with genuine NR service
for s in sorted([p for p in nr_pts if p["cyc_s"] <= CYCLE_LIMIT_S], key=lambda p: p["cyc_s"]):
    crs = nearest_crs(s["lat"], s["lon"], crs_ref)
    if not crs:
        continue
    op_lines, dest_dir, served = {}, {}, set()   # served = {(lineId, london)}
    for code, opname, destname in nr_services(crs, rtt_at):
        lid, lname = NR_TOC[code]
        dlat = name2lat.get(norm_name(destname))
        if dlat is None:
            continue                                  # unknown destination — can't place a direction
        london = "in" if dlat < s["lat"] else "out"
        op_lines[code] = {"lineId": lid, "name": lname}
        dest_dir[destname] = london
        served.add((lid, london))
    if not served:
        continue                                      # phantom: no genuine NR departures
    s.update({"crs": crs, "opLines": op_lines, "destDir": dest_dir, "served": served,
              "names": {NR_TOC[c][0]: NR_TOC[c][1] for c in op_lines}})
    nr_stations.append(s)
    print(f"  {s['cyc_min']:>4}min  {s['name'][:22]:<23} {crs}  {sorted({l for l, _ in served})}")
print(f"  {len(nr_stations)} National Rail stations with live service")

# ---------- 2. per line: where each station sits, and which way is "in" ----------
LINES = {}   # line id -> {"name", "seq": {naptan: index}, "dist": {naptan: km_to_CC}, ...}
line_ids = {lid for s in near for lid, _ in s["lines"]}
print(f"resolving {len(line_ids)} rail lines ...", flush=True)
seq_of = {}       # (lineId, direction) -> [(naptan, lat, lon) in order]  (branches flattened)
branches_of = {}  # (lineId, direction) -> [ branch block [(naptan, lat, lon), ...], ... ]
name_of = {}
for lid in sorted(line_ids):
    for d in ("inbound", "outbound"):
        try:
            r = tfl(f"/Line/{lid}/Route/Sequence/{d}", serviceTypes="Regular")
        except Exception:
            continue
        name_of[lid] = r.get("lineName", lid)
        order, blocks = [], []
        for block in r.get("stopPointSequences") or []:
            stops = [(p.get("id") or p.get("stationId"), p.get("lat"), p.get("lon"))
                     for p in (block.get("stopPoint") or []) if p.get("id") or p.get("stationId")]
            order += stops
            if len(stops) >= 2:
                blocks.append(stops)
        if len(order) >= 2:
            seq_of[(lid, d)] = order
            branches_of[(lid, d)] = blocks


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


# Every (station, line, tfl-direction, branch-terminus) the station can catch a
# train for. `london` (into/out of London) is computed per stop for the panel
# split; the terminus is what the dedup keys on, so a branch station a nearer
# station doesn't reach survives.
candidates = []   # (station, lineId, lineName, tflDir, london, terminus)
for s in near:
    for lid, lname in s["lines"]:
        for d in ("inbound", "outbound"):
            lon = direction_at(lid, d, s["id"])
            if not lon:
                continue
            for block in branches_of.get((lid, d), []):
                ids = [n for n, _, _ in block]
                if s["id"] in ids and len(ids) >= 2:
                    candidates.append((s, lid, lname, d, lon, ids[-1]))

# ---------- 3. dedup: nearest station per (line, direction, branch terminus) ----------
# Keying on the terminus, not just into/out of London, keeps a branch station a
# nearer one never reaches — e.g. Clapton for the Weaver's Chingford branch, which
# Stoke Newington (Enfield/Cheshunt) can't catch. National Rail keeps its simpler
# (line, direction) key — RTT gives no branch topology — and competes in the same
# pool by cycle time.
names, sta, dir_london, nearest = {}, {}, {}, {}
nr_ids = {s["id"] for s in nr_stations}
def offer(key, sid, cyc_s):
    if key not in nearest or cyc_s < nearest[key][0]:
        nearest[key] = (cyc_s, sid)

for s, lid, lname, d, lon, term in candidates:
    if s["id"] in nr_ids:
        continue                       # a National Rail station is served via RTT, not TfL
    sta[s["id"]] = s; names[lid] = lname; dir_london[(s["id"], lid, d)] = lon
    offer(f"{lid}|{d}|{term}", s["id"], s["cyc_s"])
for s in nr_stations:
    sta[s["id"]] = s
    for lid, lon in s["served"]:
        names[lid] = s["names"][lid]
        offer(f"nr|{lid}|{lon}", s["id"], s["cyc_s"])
nearest = {k: v[1] for k, v in nearest.items()}

# Apply PREFER overrides: hand a line's wins to the preferred station (which must be
# a real candidate for that line + direction), dropping the nearest one.
for k in list(nearest):
    if k.startswith("nr|"):
        continue
    lid, d = k.split("|", 2)[0], k.split("|", 2)[1]
    pref = PREFER.get(lid)
    if pref and (pref, lid, d) in dir_london:
        nearest[k] = pref

serve, primary_ll = {}, {}
for key, sid in nearest.items():
    serve.setdefault(sid, {})
    if key.startswith("nr|"):
        _, lid, lon = key.split("|")
        primary_ll.setdefault(sid, set()).add(f"{lid}|{lon}")
    else:
        lid, d, _term = key.split("|", 2)
        lon = dir_london[(sid, lid, d)]
        serve[sid][f"{lid}|{d}"] = lon
        primary_ll.setdefault(sid, set()).add(f"{lid}|{lon}")

# Merge co-located Finsbury Park before building the board: the TfL Piccadilly
# winner absorbs the National Rail one, so there is one station (and one map dot)
# that fetches Piccadilly via TfL and GN/Thameslink via RTT.
FP_TUBE, FP_NR = "940GZZLUFPK", "910GFNPK"
nr_extra = {}   # tube naptan -> the absorbed NR station dict (crs / opLines / served)
if FP_TUBE in primary_ll and FP_NR in primary_ll:
    primary_ll[FP_TUBE] |= primary_ll.pop(FP_NR)
    nr_extra[FP_TUBE] = sta[FP_NR]
    print("  merged Finsbury Park: Piccadilly (TfL) + Great Northern/Thameslink (RTT)")

board = sorted((sta[i] for i in primary_ll), key=lambda s: s["cyc_s"])
lines_won = {k.split("|")[0] for pl in primary_ll.values() for k in pl}
print(f"  dedup -> {len(board)} stations, {len(lines_won)} lines")
for s in board:
    lines = sorted({names[k.split('|')[0]] for k in primary_ll[s["id"]]})
    tag = "NR" if (s["id"] in nr_ids or s["id"] in nr_extra) else "  "
    print(f"  {tag} {s['cyc_min']:>4}min  {s['name'][:22]:<23} {', '.join(lines)}")

# Every station carries the same keys so cycle.ts sees one shape. `serve` drives
# the TfL fetch, the National-Rail fields drive the RTT fetch; a merged station has
# both. `nrst` is the National Rail source (the station itself, or the absorbed one).
station_objs = []
for s in board:
    sid = s["id"]
    nrst = sta[sid] if sid in nr_ids else nr_extra.get(sid)
    won = sorted({k.split("|")[0] for k in primary_ll[sid]})
    station_objs.append({
        "id": sid, "name": s["name"], "lat": s["lat"], "lon": s["lon"],
        "cycMin": s["cyc_min"], "modes": s.get("modes", []),
        "serve": serve.get(sid, {}),
        "lineNames": {lid: names[lid] for lid in won},
        "nr": nrst is not None, "crs": nrst["crs"] if nrst else "",
        # RTT runtime: operatorCode -> line, destination name -> in/out, and the
        # (line, london) pairs actually won (so a station shows only those).
        "opLines": {op: v for op, v in nrst["opLines"].items() if v["lineId"] in won} if nrst else {},
        "destDir": nrst["destDir"] if nrst else {},
        "nrServe": sorted(f"{lid}|{lon}" for lid, lon in nrst["served"]) if nrst else [],
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
features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [HOME[1], HOME[0]]},
                 "properties": {"kind": "home", "name": "149 Stoke Newington High St"}})

# ---------- OSM spine geometry: one polyline per line, drawn and snapped ----------
# The same polyline is drawn on the map (LineString features above) and used to
# position live trains (src/cycle.ts), so a pin is always exactly on the line.
print("rail geometry (OpenStreetMap) ...", flush=True)
# lineIds actually on the board (nearest keys are "lid|d|term" for TfL and
# "nr|lid|lon" for National Rail, so derive lineIds from primary_ll instead).
kept_lines = {k.split("|")[0] for pl in primary_ll.values() for k in pl}
rel_cache = {}   # rel id -> overpass element (each fetched once, reused)


def get_rel(rel_id):
    # Overpass is slow and flaky; cache each relation's geometry to disk (gitignored)
    # so re-runs are instant and only new relations hit the network.
    if rel_id not in rel_cache:
        f = ROOT / "tools" / "cache" / "osm" / f"rel-{rel_id}.json"
        if f.exists():
            rel_cache[rel_id] = json.loads(f.read_text())
        else:
            el = overpass(f"[out:json][timeout:180];rel({rel_id});out geom;")["elements"][0]
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(el))
            rel_cache[rel_id] = el
    return rel_cache[rel_id]


spine_poly = {}   # lineId -> [[lon,lat], ...] trunk, for positioning pins
for lid in sorted(kept_lines):
    if lid not in SPINE:
        print(f"  !! {lid}: no SPINE relation configured, skipping geometry")
        continue
    # draw every branch: emit each distinct OSM way once as a LineString
    seen_ways, drawn = set(), 0
    for rel_id in BRANCHES.get(lid, [SPINE[lid]]):
        for m in get_rel(rel_id)["members"]:
            if m["type"] == "way" and m.get("geometry") and m["ref"] not in seen_ways and len(m["geometry"]) >= 2:
                seen_ways.add(m["ref"])
                features.append({"type": "Feature",
                                 "geometry": {"type": "LineString",
                                              "coordinates": [[round(n["lon"], 5), round(n["lat"], 5)] for n in m["geometry"]]},
                                 "properties": {"kind": "rail", "line": names[lid], "lineId": lid}})
                drawn += 1
    # spine for positioning
    poly = stitch(get_rel(SPINE[lid])["members"], (HOME[1], HOME[0]))
    spine_poly[lid] = poly
    print(f"  {names[lid]:<12} {len(BRANCHES.get(lid, [1]))} branch(es), {drawn} ways drawn, "
          f"spine {len(poly)} vertices")

# ---------- National Rail geometry: drawn + snapped by CRS for live pins ----------
# Great Northern and Greater Anglia are drawn from their OSM spine. Thameslink shares
# the Great Northern corridor through Finsbury Park near home (its own route diverges far
# to the south, outside the board's view), so it's drawn along that same corridor — now
# that its departures show, a missing track would look inconsistent.
NR_DRAW = {"great-northern": 6336420, "greater-anglia": 9107254, "thameslink": 6336420}
NR_PIN = {"great-northern": 6336420, "greater-anglia": 9107254, "thameslink": 6336420}
nr_routes = {}   # lineId -> {track: [...], crs: {CRS: offset_m}}
for lid, rel_id in NR_PIN.items():
    if lid not in kept_lines:
        continue
    rel = get_rel(rel_id)
    if lid in NR_DRAW:
        for m in rel["members"]:
            if m["type"] == "way" and m.get("geometry") and len(m["geometry"]) >= 2:
                features.append({"type": "Feature",
                                 "geometry": {"type": "LineString",
                                              "coordinates": [[round(n["lon"], 5), round(n["lat"], 5)] for n in m["geometry"]]},
                                 "properties": {"kind": "rail", "line": names[lid], "lineId": lid}})
    poly = stitch(rel["members"], (HOME[1], HOME[0]))
    cum = cumulate(poly)
    crs_off = {crs: round(off) for crs, nm, lat, lon in crs_ref
               for off, perp in [snap(poly, cum, lat, lon)] if perp <= 400}
    nr_routes[lid] = {"track": [[round(x, 5), round(y, 5)] for x, y in poly], "crs": crs_off}
    print(f"  {names[lid]:<14} NR spine {len(poly)} vertices, {len(crs_off)} CRS snapped")

# ---------- all stops on every line (faint dots), like the walk board ----------
print("all stops on each line ...", flush=True)
board_ids = {s["id"] for s in board}
seen_ids = {f["properties"].get("id") for f in features if f["properties"].get("kind") == "station"}
allstops = {}   # id -> {lat, lon, name, lines:set}
for lid in sorted(kept_lines):
    if lid in NR_PIN:
        continue
    try:
        sps = tfl(f"/Line/{lid}/StopPoints")
    except Exception:
        continue
    for sp in sps:
        nid = sp.get("naptanId")
        if not nid or sp.get("lat") is None:
            continue
        e = allstops.setdefault(nid, {"lat": sp["lat"], "lon": sp["lon"], "lines": set(),
            "name": sp["commonName"].replace(" Underground Station", "").replace(" Rail Station", "").replace(" Station", "").strip()})
        e["lines"].add(names.get(lid, lid))
for lid in NR_DRAW:                          # National Rail stations along the spine
    for crs in nr_routes.get(lid, {}).get("crs", {}):
        row = next((c for c in crs_ref if c[0] == crs), None)
        if not row:
            continue
        e = allstops.setdefault(f"crs:{crs}", {"lat": row[2], "lon": row[3], "lines": set(),
            "name": row[1].replace(" Rail Station", "").strip()})
        e["lines"].add(names.get(lid, lid))
n_added = 0
for nid, e in allstops.items():
    if nid in seen_ids or nid in board_ids:
        continue
    features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(e["lon"], 5), round(e["lat"], 5)]},
                     "properties": {"kind": "station", "id": nid, "name": e["name"], "lines": sorted(e["lines"]), "onBoard": False}})
    n_added += 1
print(f"  {n_added} additional line stops drawn")

# ---------- line-to-line transfer matrix (share a station => one transfer) ----------
# The router uses this to prioritise which (origin-station, dest-station) pairs to spend a
# TfL query on: 0 transfers if their lines share (tier 1), 1 transfer if their lines share
# an interchange station (tier 2). Derived from each line's StopPoints — two lines that
# call at the same naptan interchange. Regenerated here so it tracks TfL line changes.
print("line transfer matrix ...", flush=True)
# Match stations by NAME, not naptan: the same interchange has different naptans for its
# tube vs Overground/rail parts (Liverpool Street 940GZZLULVT vs 910GLIVST), so naptan
# intersection misses Overground<->tube transfers.
def norm_sta(nm):
    for suf in (" Underground Station", " Rail Station", " DLR Station", " Station"):
        nm = nm.replace(suf, "")
    return nm.strip().lower()
line_stops = {}   # TfL lineId -> set(normalised station name)
try:
    tfl_lines = tfl("/Line/Mode/tube,overground,elizabeth-line,dlr,tram")
except Exception:
    tfl_lines = []
for ln in tfl_lines:
    lid = ln.get("id")
    if not lid:
        continue
    try:
        sps = tfl(f"/Line/{lid}/StopPoints")
    except Exception:
        continue
    line_stops[lid] = {norm_sta(sp["commonName"]) for sp in sps if sp.get("commonName")}
transfers = {}
for a in line_stops:
    transfers[a] = sorted({b for b in line_stops if b != a and (line_stops[a] & line_stops[b])})
# National Rail lines (our GN / Thameslink / Greater Anglia) aren't in the TfL StopPoints
# set, so seed their key interchanges by hand (symmetric). These change very rarely.
NR_TRANSFERS = {
    "great-northern": ["victoria", "piccadilly", "northern", "circle", "hammersmith-city", "metropolitan", "elizabeth"],
    "thameslink":     ["victoria", "piccadilly", "northern", "circle", "hammersmith-city", "metropolitan", "elizabeth", "bakerloo"],
    "greater-anglia": ["central", "circle", "hammersmith-city", "elizabeth", "weaver", "windrush", "mildmay", "suffragette"],
}
for lid, conn in NR_TRANSFERS.items():
    transfers[lid] = sorted(set(transfers.get(lid, [])) | set(conn))
    for c in conn:
        transfers[c] = sorted(set(transfers.get(c, [])) | {lid})
(ROOT / "src" / "line-transfers.json").write_text(json.dumps(transfers, separators=(",", ":")) + "\n")
print(f"  wrote src/line-transfers.json ({len(transfers)} lines)")

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

# Branch routes: snap a line's stops onto an extra branch spine, so trains on a
# branch the main spine can't reach (Chingford) can still be positioned. Keyed
# "lineId|dir|branch"; src/cycle.ts tries these when the main route doesn't fit.
for lid, branches in BRANCH_SPINE.items():
    if lid not in spine_poly:
        continue
    for bname, rel_id in branches.items():
        bpoly = stitch(get_rel(rel_id)["members"], (HOME[1], HOME[0]))
        if len(bpoly) < 2:
            continue
        for d in ("inbound", "outbound"):
            coords = [(nid, lat, lon) for nid, lat, lon in seq_of.get((lid, d), []) if lat is not None]
            if len(coords) < 2:
                continue
            poly = bpoly[:]
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
                routes[f"{lid}|{d}|{bname}"] = {"track": [[round(x, 5), round(y, 5)] for x, y in poly], "stops": dedup}

# National Rail routes are keyed by lineId alone (no direction): {track, crs offsets}.
routes.update(nr_routes)
(ROOT / "src" / "cycle-routes.json").write_text(json.dumps(routes, separators=(",", ":")) + "\n")
print(f"wrote src/cycle-routes.json ({len(routes)} routes, "
      f"{sum(len(r.get('stops', r.get('crs', []))) for r in routes.values())} snapped points)")
print(f"wrote src/cycle-stops.json ({len(board)} stations)")
print(f"wrote {out.relative_to(ROOT)} ({len(features)} features)")

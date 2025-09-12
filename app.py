# app.py
import os, time, asyncio, re
from typing import Dict, Any, List, Optional
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from bs4 import BeautifulSoup

load_dotenv()

# === Config from env ===
TFL_APP_KEY = os.getenv("TFL_APP_KEY", "").strip()
TFL_STOPPOINTS = [s.strip() for s in os.getenv("TFL_STOPPOINTS", "").split(",") if s.strip()]

DARWIN_TOKEN = os.getenv("DARWIN_TOKEN", "").strip()
DARWIN_STATIONS = [s.strip().upper() for s in os.getenv("DARWIN_STATIONS", "").split(",") if s.strip()]

if not TFL_APP_KEY or not TFL_STOPPOINTS:
    raise RuntimeError("Missing TFL_APP_KEY or TFL_STOPPOINTS in environment")

# Cache (simple in-mem with TTL)
_cache: Dict[str, Dict[str, Any]] = {}
_cache_lock = asyncio.Lock()
TTL_TFL = 25
TTL_DARWIN = 25
TTL_JUBILEE = 50  # scraped page cache

# Known IDs
DLR_STRATFORD_INTL = "940GZZDLSIT"  # Stratford International (DLR) StopPoint

app = FastAPI(title="Stratford Wallboard API")

# CORS (relax for now)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)

# ---------- Cache helpers ----------
def cache_get(key: str, ttl: int):
    item = _cache.get(key)
    if item and (time.time() - item["t"]) < ttl:
        return item["v"]
    return None

async def cache_set(key: str, value: Any):
    async with _cache_lock:
        _cache[key] = {"v": value, "t": time.time()}

# ---------- TfL (REST/JSON) ----------
TFL_BASE = "https://api.tfl.gov.uk"

async def tfl_get_json(client: httpx.AsyncClient, url: str, params: Optional[dict] = None):
    qp = {"app_key": TFL_APP_KEY}
    if params:
        qp.update(params)
    r = await client.get(url, params=qp, timeout=20)
    r.raise_for_status()
    return r.json()

def _is_blocked_tfl_line_or_mode(line_name: str | None, mode_name: str | None) -> bool:
    ln = (line_name or "").strip().lower()
    md = (mode_name or "").strip().lower()
    # Block Jubilee, Elizabeth line, and Overground/Mildmay at source
    if ln in ("jubilee", "elizabeth line") or md in ("elizabeth-line", "overground"):
        return True
    return False

def summarise_tfl(preds: List[dict]) -> List[dict]:
    # Sort by soonest
    preds = sorted(preds, key=lambda x: x.get("timeToStation", 10**9))
    out: List[dict] = []
    for p in preds[:60]:
        line = p.get("lineName")
        mode = p.get("modeName")
        if _is_blocked_tfl_line_or_mode(line, mode):
            continue  # 🚫 drop Jubilee/Elizabeth/Mildmay here

        out.append({
            "line": line,
            "mode": mode,
            "platform": p.get("platformName") or p.get("platformNumber") or "—",
            "to": p.get("destinationName") or p.get("towards") or "—",
            "etaMin": max(0, round((p.get("timeToStation") or 0) / 60)),
            "expected": p.get("expectedArrival"),   # ISO string when present (frontend handles)
            "direction": p.get("direction"),
            "stopId": p.get("naptanId") or p.get("stationNaptan") or "",
        })
    return out

async def fetch_tfl_stop(client: httpx.AsyncClient, stop_id: str) -> dict:
    sid = (stop_id or "").strip()
    # 🚫 Do not fetch Stratford International (DLR) at all
    if sid.upper() == DLR_STRATFORD_INTL:
        return {"stopId": sid, "rows": []}

    # For National Rail NaPTANs (910G...), we previously fetched Elizabeth/Overground.
    # We now skip those entirely (handled from Darwin; and Elizabeth/Mildmay are blocked).
    if sid.upper().startswith("910G"):
        return {"stopId": sid, "rows": []}

    url = f"{TFL_BASE}/StopPoint/{sid}/Arrivals"
    data = await tfl_get_json(client, url, params=None)
    rows = summarise_tfl(data)

    # As a double-safety, remove any rows that somehow slipped through:
    filtered = []
    for r in rows:
        if _is_blocked_tfl_line_or_mode(r.get("line"), r.get("mode")):
            continue
        # also make sure this isn't the SIT DLR stop (shouldn't be, since we didn't fetch it)
        if sid.upper() == DLR_STRATFORD_INTL:
            continue
        filtered.append(r)

    return {"stopId": sid, "rows": filtered}

# ---------- Darwin (RDM REST/JSON) ----------
DARWIN_BASE = "https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120"
DARWIN_NUM_ROWS = 150       # up to 150 per call with GetDepartureBoard
DARWIN_TIME_WINDOW = 120    # minutes ahead

async def fetch_darwin_board(client: httpx.AsyncClient, crs: str) -> dict:
    """
    Calls GetDepartureBoard for a CRS and flattens to our row shape.
    Returns: {"crs": "...", "rows": [ {to, plat, sched, est, operator} ... ] }
    """
    url = f"{DARWIN_BASE}/GetDepartureBoard/{crs}"
    params = {
        "numRows": str(DARWIN_NUM_ROWS),
        "timeWindow": str(DARWIN_TIME_WINDOW),
    }
    headers = {"x-apikey": DARWIN_TOKEN}
    r = await client.get(url, params=params, headers=headers, timeout=20.0)
    r.raise_for_status()
    data = r.json()

    rows: List[dict] = []
    services = data.get("trainServices") or []
    if not services and "GetStationBoardResult" in data:
        services = data["GetStationBoardResult"].get("trainServices") or []

    for svc in services[:DARWIN_NUM_ROWS]:
        dests = svc.get("destination") or []
        if isinstance(dests, dict) and "location" in dests:
            loc = dests["location"]
            dests = loc if isinstance(loc, list) else [loc]

        to = ", ".join(d.get("locationName") or "" for d in dests if isinstance(d, dict)) or "—"

        rows.append({
            "to": to,
            "plat": svc.get("platform") or "—",
            "sched": svc.get("std") or "—",
            "est": svc.get("etd") or "—",
            "operator": svc.get("operator") or "",
        })

    return {"crs": crs, "rows": rows}

# ---------- Jubilee scraper (Whoosh page) ----------
JUBILEE_URL = "https://nr.whoosh.media/app/stations/SRA/tube#"

def _round_down_to_minute(ts: float) -> int:
    # Return integer epoch seconds with seconds truncated
    return int(ts // 60 * 60)

def _parse_eta_to_minutes(txt: str) -> Optional[int]:
    t = (txt or "").strip().lower().replace("\xa0", " ")
    if t == "now":
        return 0
    m = re.search(r"(\d+)\s*mins?", t)
    if m:
        return int(m.group(1))
    # Some pages show "1 min"
    m = re.search(r"(\d+)\s*min\b", t)
    if m:
        return int(m.group(1))
    return None

async def fetch_jubilee() -> List[dict]:
    key = "scrape_jubilee"
    cached = cache_get(key, TTL_JUBILEE)
    if cached is not None:
        return cached

    async with httpx.AsyncClient() as client:
        r = await client.get(JUBILEE_URL, timeout=20.0)
        r.raise_for_status()
        html = r.text

    soup = BeautifulSoup(html, "html.parser")

    # Find the tube departures table section by its header row:
    # Expect headers like: Time | Destination | Line | Platform
    header = None
    for div in soup.find_all("div"):
        txt = div.get_text(strip=True)
        if txt == "Time":
            parent = div.parent
            if parent and parent.get_text(" | ", strip=True) == "Time | Destination | Line | Platform":
                header = parent
                break

    rows: List[dict] = []
    if header is None:
        await cache_set(key, rows)
        return rows

    # Iterate sibling rows until the next section
    now = time.time()
    sib = header.find_next_sibling()
    while sib and sib.name == "div":
        text = sib.get_text(" | ", strip=True)
        # Expect shape: "{eta} | {destination} | {line} | {platform}"
        parts = [p.strip() for p in text.split("|")]
        if len(parts) < 4:
            break
        eta_txt, dest_txt, line_txt, plat_txt = parts[:4]

        # Only keep Jubilee line rows
        if line_txt.lower() != "jubilee":
            sib = sib.find_next_sibling()
            continue

        eta_min = _parse_eta_to_minutes(eta_txt)
        if eta_min is None:
            sib = sib.find_next_sibling()
            continue

        expected = _round_down_to_minute(now + eta_min * 60)

        rows.append({
            "svc": "jubilee",
            "to": dest_txt or "—",
            "plat": plat_txt or "—",
            "etaMin": eta_min,
            "expected": expected,  # epoch seconds, rounded down to minute
        })

        sib = sib.find_next_sibling()

    await cache_set(key, rows)
    return rows

# ---------- API endpoints ----------
@app.get("/health")
def health():
    rail_enabled = bool(DARWIN_TOKEN and DARWIN_STATIONS)
    return {
        "ok": True,
        "tflStops": TFL_STOPPOINTS,
        "railEnabled": rail_enabled,
        "railCRS": DARWIN_STATIONS if rail_enabled else [],
        "darwinBase": DARWIN_BASE if rail_enabled else None,
        "jubileeScrape": JUBILEE_URL,
    }

@app.get("/tfl")
async def tfl_all():
    key = "tfl_all_filtered"
    cached = cache_get(key, TTL_TFL)
    if cached is not None:
        return cached
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*[fetch_tfl_stop(client, sid) for sid in TFL_STOPPOINTS])
    await cache_set(key, results)
    return results

@app.get("/rail")
async def rail_all():
    """Returns [] if DARWIN is not configured (or unauthorized)."""
    if not DARWIN_TOKEN or not DARWIN_STATIONS:
        return []
    key = "rail_all"
    cached = cache_get(key, TTL_DARWIN)
    if cached is not None:
        return cached
    try:
        async with httpx.AsyncClient() as client:
            results = await asyncio.gather(*[fetch_darwin_board(client, crs) for crs in DARWIN_STATIONS])
        await cache_set(key, results)
        return results
    except httpx.HTTPStatusError as e:
        if e.response is not None and e.response.status_code in (401, 403):
            return []
        raise

@app.get("/jubilee")
async def jubilee_only():
    return await fetch_jubilee()

@app.get("/board")
async def board():
    """Combined payload for the front-end."""
    try:
        tfl_task = tfl_all()
        rail_task = rail_all()
        jubilee_task = fetch_jubilee()
        tfl, rail, jubilee = await asyncio.gather(tfl_task, rail_task, jubilee_task)
        return {"tfl": tfl, "rail": rail, "jubilee": jubilee, "ts": int(time.time())}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ----------------- (disabled legacy fetch notes) -----------------
# The front-end now consumes Jubilee from /jubilee (scraped) instead of TfL.
# The following older approaches are intentionally disabled:
# - Fetching Jubilee via TfL StopPoint Arrivals
# - Fetching Elizabeth line and Overground (Mildmay) via TfL from National Rail NaPTANs (910G...)
# - Fetching Stratford International (DLR) StopPoint (940GZZDLSIT)
# Keeping this reminder here for future reference.

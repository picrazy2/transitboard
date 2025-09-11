# app.py
import os, time, asyncio
from typing import Dict, Any, List
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

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

app = FastAPI(title="Stratford Wallboard API")

# CORS (relax now, tighten later)
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

async def tfl_get_json(client: httpx.AsyncClient, url: str, params: dict | None = None):
    # TfL expects the app_key as a query param (not a header)
    qp = {"app_key": TFL_APP_KEY}
    if params:
        qp.update(params)
    r = await client.get(url, params=qp, timeout=20)
    r.raise_for_status()
    return r.json()

def summarise_tfl(preds: List[dict]) -> List[dict]:
    preds = sorted(preds, key=lambda x: x.get("timeToStation", 10**9))
    out = []
    for p in preds[:30]:
        out.append({
            "line": p.get("lineName"),
            "mode": p.get("modeName"),
            "platform": p.get("platformName") or p.get("platformNumber") or "—",
            "to": p.get("destinationName") or p.get("towards") or "—",
            "etaMin": max(0, round((p.get("timeToStation") or 0) / 60)),
            "expected": p.get("expectedArrival"),
            "direction": p.get("direction"),
        })
    return out

async def fetch_tfl_stop(client: httpx.AsyncClient, stop_id: str) -> dict:
    params = {}
    # For National Rail NaPTANs (910G...), only pull TfL-managed modes (Elizabeth/Overground)
    if stop_id.upper().startswith("910G"):
        params["modes"] = "elizabeth-line,overground"
    url = f"{TFL_BASE}/StopPoint/{stop_id}/Arrivals"
    data = await tfl_get_json(client, url, params=params)
    return {"stopId": stop_id, "rows": summarise_tfl(data)}

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

    rows = []
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
    }

@app.get("/tfl")
async def tfl_all():
    key = "tfl_all"
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
        # If unauthorized or any Darwin hiccup, just return empty so /board still works
        if e.response is not None and e.response.status_code in (401, 403):
            return []
        raise

@app.get("/board")
async def board():
    """Combined payload for the front-end."""
    try:
        tfl_task = tfl_all()
        rail_task = rail_all()
        tfl, rail = await asyncio.gather(tfl_task, rail_task)
        return {"tfl": tfl, "rail": rail, "ts": int(time.time())}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

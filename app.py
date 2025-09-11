import os, time, asyncio
from typing import Dict, Any, List
import httpx, xmltodict
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

# --- Config from env ---
TFL_APP_KEY = os.getenv("TFL_APP_KEY", "")
TFL_STOPPOINTS = [s.strip() for s in os.getenv("TFL_STOPPOINTS", "").split(",") if s.strip()]

DARWIN_TOKEN = os.getenv("DARWIN_TOKEN", "").strip()  # may be empty for now
DARWIN_STATIONS = [s.strip().upper() for s in os.getenv("DARWIN_STATIONS", "").split(",") if s.strip()]

# We only *require* TfL to start up
if not TFL_APP_KEY or not TFL_STOPPOINTS:
    raise RuntimeError("Missing TFL_APP_KEY or TFL_STOPPOINTS in .env")

# --- Simple in-memory cache with TTL ---
_cache: Dict[str, Dict[str, Any]] = {}
_cache_lock = asyncio.Lock()
TTL_TFL = 25      # seconds
TTL_DARWIN = 25   # seconds (used only if DARWIN_TOKEN provided)

app = FastAPI(title="Stratford Wallboard API")

# Allow your front-end to call this API (tighten origins later)
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
TFL_HEADERS = {"app_key": TFL_APP_KEY}

async def tfl_get_json(client: httpx.AsyncClient, url: str, params: dict = None):
    r = await client.get(url, params=params, headers=TFL_HEADERS, timeout=20)
    r.raise_for_status()
    return r.json()

def summarise_tfl(preds: List[dict]) -> List[dict]:
    preds = sorted(preds, key=lambda x: x.get("timeToStation", 10**9))
    out = []
    for p in preds[:30]:  # keep payload tidy
        out.append({
            "line": p.get("lineName"),
            "mode": p.get("modeName"),
            "platform": p.get("platformName") or p.get("platformNumber") or "—",
            "to": p.get("destinationName") or p.get("towards") or "—",
            "etaMin": max(0, round((p.get("timeToStation") or 0)/60)),
            "expected": p.get("expectedArrival"),
            "direction": p.get("direction"),
        })
    return out

async def fetch_tfl_stop(client: httpx.AsyncClient, stop_id: str) -> dict:
    params = {}
    # For NaPTAN rail node (910G...), filter to EL + Overground (we don't pull National Rail via TfL)
    if stop_id.upper().startswith("910G"):
        params["modes"] = "elizabeth-line,overground"
    url = f"{TFL_BASE}/StopPoint/{stop_id}/Arrivals"
    data = await tfl_get_json(client, url, params=params)
    return {"stopId": stop_id, "rows": summarise_tfl(data)}

# ---------- Darwin (SOAP/XML) — OPTIONAL ----------
DARWIN_URL = "https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb11.asmx"

def darwin_envelope(inner_xml: str) -> str:
    return f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <AccessToken xmlns="http://thalesgroup.com/RTTI/2017-10-01/ldb/">
      <TokenValue>{DARWIN_TOKEN}</TokenValue>
    </AccessToken>
  </soap:Header>
  <soap:Body>{inner_xml}</soap:Body>
</soap:Envelope>"""

async def darwin_post(client: httpx.AsyncClient, inner_xml: str) -> dict:
    r = await client.post(DARWIN_URL, content=darwin_envelope(inner_xml),
                          headers={"Content-Type": "text/xml"}, timeout=20)
    r.raise_for_status()
    return xmltodict.parse(r.text)

def summarise_darwin(doc: dict, crs: str) -> dict:
    try:
        body = doc["soap:Envelope"]["soap:Body"]
        board = (body.get("GetDepartureBoardResponse") or
                 body.get("GetArrivalBoardResponse") or
                 {}).get("GetStationBoardResult")
    except Exception:
        return {"crs": crs, "rows": [], "error": "Unexpected SOAP structure"}

    if not board:
        return {"crs": crs, "rows": []}

    services = (board.get("trainServices") or {}).get("service")
    if not services:
        return {"crs": crs, "rows": []}
    if isinstance(services, dict):
        services = [services]

    rows = []
    for s in services[:20]:
        dest = s.get("destination", {}).get("location", {})
        if isinstance(dest, list):
            dest_name = (dest[0] or {}).get("locationName")
        else:
            dest_name = dest.get("locationName")
        rows.append({
            "sched": s.get("std") or s.get("sta"),
            "est": s.get("etd") or s.get("eta"),
            "plat": s.get("platform") or "—",
            "to": dest_name or "—",
            "operator": s.get("operator"),
            "serviceID": s.get("serviceID"),
        })
    return {"crs": crs, "rows": rows}

async def fetch_darwin_board(client: httpx.AsyncClient, crs: str) -> dict:
    inner = f"""
<GetDepartureBoardRequest xmlns="http://thalesgroup.com/RTTI/2017-10-01/ldb/">
  <numRows>12</numRows>
  <crs>{crs}</crs>
</GetDepartureBoardRequest>"""
    doc = await darwin_post(client, inner)
    return summarise_darwin(doc, crs)

# ---------- API endpoints ----------
@app.get("/health")
def health():
    rail_enabled = bool(DARWIN_TOKEN and DARWIN_STATIONS)
    return {
        "ok": True,
        "tflStops": TFL_STOPPOINTS,
        "railEnabled": rail_enabled,
        "railCRS": DARWIN_STATIONS if rail_enabled else [],
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
        # Re-raise other errors
        raise

@app.get("/board")
async def board():
    """Combined payload for your iPad."""
    try:
        tfl_task = tfl_all()
        rail_task = rail_all()
        tfl, rail = await asyncio.gather(tfl_task, rail_task)
        return {"tfl": tfl, "rail": rail, "ts": int(time.time())}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

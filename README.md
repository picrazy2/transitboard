# transitboard

Live departure boards, run full-screen on an iPad. Deployed to
[board.akguo.com](https://board.akguo.com) on Cloudflare Pages.

| Board | Path | Shows |
|---|---|---|
| Stoke Newington | `/stokey` | Weaver line, 10 bus routes, weather, neighbourhood map |
| Stratford | `/stratford` | Central, Jubilee, Elizabeth, Mildmay, DLR, National Rail |

## Layout

```
public/            static assets — this is the Pages build output directory
  index.html         landing page: pick a board
  stokey/            board + generated geo.json for the map
  stratford/         board (unchanged from the old stratfordboard repo)
functions/
  api/board/[board].ts   the only API route: /api/board/{stokey,stratford}
src/                 board logic, imported by the function
  tfl.ts   weather.ts   stokey.ts   stratford.ts
  stokey-stops.json      generated — do not edit by hand
tools/
  build-stokey-data.py   regenerates stokey-stops.json + public/stokey/geo.json
```

Frontend and API are same-origin, so there is no CORS and no separate backend
service to keep alive.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in TFL_APP_KEY
npm run dev                      # http://127.0.0.1:8788
npm run typecheck
```

## Secrets

Set in the Cloudflare Pages dashboard (Settings → Environment variables), or via
`npx wrangler pages secret put NAME`:

| Name | Required | Used by |
|---|---|---|
| `TFL_APP_KEY` | yes | both boards |
| `DARWIN_TOKEN` | no | Stratford's National Rail rows only |

The working `DARWIN_TOKEN` is the one set in the old Render service's dashboard,
not the one in the old repo's `.env`, which is stale and returns
`Invalid ApiKey`. Copy it across from Render before retiring that service.

Without `DARWIN_TOKEN` — or with an expired one — `/api/board/stratford` returns
`rail: []` and the board shows no National Rail departures. It does not error.
New keys come from the [Rail Data Marketplace](https://raildata.org.uk).

## Regenerating the Stoke Newington data

```sh
npm run data     # python3 tools/build-stokey-data.py
```

Re-run this if you move house, or if TfL changes a bus route. It rebuilds both
`src/stokey-stops.json` and `public/stokey/geo.json` from scratch. Notes on why
it does what it does:

- **Walk times are real pedestrian routes** (Valhalla), not crow-flies. A 900 m
  radius around the flat reaches route 488, but no 488 stop is within a 10 minute
  walk of it — a radius filter would put a bus on the board you can't catch.
- **Stops are deduplicated per (line, direction), not per line.** Dropping a stop
  because a nearer one serves "the same lines" would delete your journey home.
  A stop earns a place on the board only if it is the nearest stop for at least
  one (line, direction) pair. That takes 31 walkable stops down to 7 while
  keeping all 20 pairs.
- **Bus geometry comes from TfL** (~27 m between vertices, follows the road).
  **Rail geometry comes from OpenStreetMap** (~16 m); TfL's rail `lineStrings`
  are straight chords between stations (~1200 m apart) and look wrong drawn on
  a map.
- **"Into London" is computed, not taken from TfL.** TfL's `inbound`/`outbound`
  has nothing to do with the centre — the 67's *inbound* runs to Wood Green
  while the 149's *outbound* runs to London Bridge. So for each line we compare
  its two termini and call the one nearer Charing Cross "in". A simple distance
  threshold would not work: both of the 106's termini are nearer the centre than
  the flat is. Orbital routes that never approach the centre are listed in
  `MANUAL_DIRECTION` — currently just the 276, which runs Stoke Newington
  Common to Newham Hospital and goes "out" in both directions.

Weaver is the one case where TfL's own direction is trustworthy and used
directly: `inbound` is Liverpool Street, `outbound` is Enfield Town / Cheshunt.

## Delays, and why only the Weaver has one

`StopPoint/{naptan}/ArrivalDepartures` returns `scheduledTimeOfDeparture`,
`estimatedTimeOfDeparture` and `departureStatus`. It works for National-Rail-style
modes, so the Weaver gets a real delay and real cancellations. A late train
strikes its scheduled time and prints the expected one in red; an on-time train
prints its scheduled time in green. Delay is floored, not rounded: a 45-second
difference is not "1 min late", and rounding it up would strike a time and
replace it with itself.

Not every Weaver row is live. The feed runs ~110 minutes ahead, but a platform is
only assigned about 35 minutes out; beyond that the rows are timetable, with
`estimated == scheduled`. Bus rows, by contrast, are always live — each carries a
`vehicleId` (the real registration), and a route simply vanishes for a minute
when no vehicle is being tracked.

Buses get nothing from `ArrivalDepartures`.

There is no honest bus delay to show:

- TfL's bus predictions carry no scheduled time, and TfL staff have confirmed the
  `vehicleId` in a prediction does not correspond to anything in the timetable.
  So a live bus cannot be joined to a scheduled trip.
- `Line/{id}/Timetable/{stopId}` does publish scheduled times, but every daytime
  route here runs a **7–12 minute headway**. TfL regulates such routes on excess
  wait time, not punctuality. Matching a prediction to the nearest scheduled slot
  would routinely flip sign: on a 7-minute headway a bus 6 minutes late is
  indistinguishable from the next bus 1 minute early.

So bus rows show only ETAs. Three of them at a glance ("1 · 12 · 14") reveals
bunching far more truthfully than a fabricated delay figure would.

## Interacting with the board

- **Chips** (header) narrow the board and the map to a set of lines, using the
  same state machine as the Stratford board: from "everything shown" the first
  tap *isolates* that line, after which taps toggle, and clearing the last
  selected line restores everything. The board can never end up empty.
  With every line shown there is no room per departure, so rows are grouped per
  route with the next three ETAs; the moment chips narrow it, rows become one
  per vehicle with clock times.
- **Tapping a row, or a labelled stop on the map**, dims everything else rather
  than removing it. Tap again, or tap the map background, to clear.
- Both reset themselves after an hour with no interaction — it is a wallboard,
  and it should not still be filtered the next morning.
- The map opens framed on the seven board stops, the station and home, but pans
  and zooms freely: routes and stops run the full length of every line. Only the
  board's own stops are labelled; every other stop is a dot with a popup.
  Rectory Road is a 7.7 min walk, but every train calls at Stoke Newington
  first, so it gets a dot and no row.

## Live bus pins

TfL publishes no bus coordinates: `currentLocation` is always empty and the
dedicated bus-location API was shelved in 2021. The only sanctioned live source
is **BODS SIRI-VM, operator `TFLO`**, which needs its own (free) API key.

Until then `src/vehicles.ts` estimates. For the next bus on each board row it
reads `/Vehicle/{ids}/Arrivals`, which gives that bus's predicted arrival at
every stop still ahead of it. It derives the bus's current speed from the gap to
the stop after next, then walks backwards along the route polyline by
`time × speed`, never going back past the stop it has already left. Accurate to
about a block; pins are labelled *estimated*. Roughly a quarter of pins saturate
at the previous stop, which is why two buses sometimes share a point.

## History

This repo is a subtree merge of two older repos, both of whose commits are
preserved:

- `picrazy2/stratfordboard` → `public/stratford/`
- `picrazy2/stratfordboard-backend` → ported to `src/` and `functions/`

The original FastAPI backend was removed once the port was verified. To read it:

```sh
git show 6bfaa9c:app.py
```

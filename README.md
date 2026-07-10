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
  one (line, direction) pair. That takes 31 walkable stops down to 7. Pairs never
  worth catching are named in `EXCLUDE_PAIRS` — currently the 73's outbound,
  which terminates at Stoke Newington Common a few minutes' walk away.
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
`estimated == scheduled`.

`ArrivalDepartures` carries the schedule but no `vehicleId`; the live predictions
carry the `vehicleId` but no schedule. They are joined on destination and expected
time — a 90-second window matches 16 of 17 rows uniquely with no ambiguity, and a
row that matches more than one train is left unmatched rather than guessed. That
join is what lets a rail row be focused down to a single train. Bus rows, by contrast, are always live — each carries a
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

- **The board opens on the Weaver alone**, in a single stacked column, with the
  map taking the rest of the space. The train is the departure you cannot
  substitute; the buses you already know.
  Every chip starts lit — `selected` is what the **map** draws. What the **table**
  lists is narrower, and while all chips are lit a `Default | All` switch chooses
  between the Weaver alone and everything. Deselect any chip and the table can
  only be that selection, so the switch greys out in place rather than vanishing
  and shuffling the chips sideways.
- **Chips** narrow the board and the map to a set of lines, using the same state
  machine as the Stratford board: from "everything shown" the first tap
  *isolates* that line, after which taps toggle, and clearing the last selected
  line returns to the default. The board can never end up empty.
  With every line shown there is no room per departure, so rows are grouped per
  route with the next three ETAs; the moment chips narrow it, rows become one
  per vehicle with clock times.
- **Only**, in a column header, focuses a whole direction.
- Tapping a row focuses its whole route while the table groups by route. Once the
  table lists one row per vehicle, a row *is* a vehicle: it focuses that one bus,
  frames it, dims every other row in **both** tables, and leaves the layout alone
  — collapsing a column there would just duplicate `Only`.
- Vehicles that have already gone past appear only in full screen, where there is
  room for context.
- Clearing the last filter, or the focus, recentres on the opening frame — once,
  on the way out, so a manual pan while unfiltered is never yanked back.
- Map fits use a fixed pixel inset (`FIT`), not `bounds.pad(fraction)` — padding
  by a fraction of the bounds means two stops a block apart get a tight frame
  while a bus 3 km out drags a kilometre of margin along. The map also runs
  `zoomSnap: 0.25`; with integer zoom levels `fitBounds` can only land on a power
  of two, which leaves a screenful of slack that looks like padding but is not.
- Marker detail opens in a panel pinned to the map's corner rather than a popup
  over whatever you just tapped. There are no zoom buttons: pinch.
- **Tapping a row, or a labelled stop on the map**, dims everything else rather
  than removing it: the other routes, stops, pins, the Weaver line, home, and
  the basemap tiles all fall away to near-invisible (see `DIM` in the page),
  and the focused route thickens and brightens. Tap again, or tap the map
  background, to clear.
- Everything resets to that default after an hour with no interaction — it is a
  wallboard, and it should not still be filtered the next morning.
- Tapping a stop stacks the columns and shows *only* its rows. Note that a stop
  is only ever the nearest for one direction, so one half of the stack collapses.
- A route calls at stops the board never uses. With the 76 up, Rectory Road (L)
  is drawn like any other stop the 76 passes — small, grey, unlabelled — because
  you would catch the 76 at Northwold Road. It gets its ring and label back under
  the 276, which it *is* the nearest stop for.
- The map opens framed on the seven board stops, the station and home, but pans
  and zooms freely: routes and stops run the full length of every line. Buttons
  give full screen, recentre, and a legend that stays out of the way until asked
  for. Only the board's own stops are labelled; every other stop is a dot with a
  popup.
  Rectory Road is a 7.7 min walk, but every train calls at Stoke Newington
  first, so it gets a dot and no row. Bus rows name their stop and its walk
  time; Weaver rows show only the platform and time, since there is one station
  and it is a 6 min walk.

## Countdowns

`expectedArrival` is a full timestamp, not a rounded minute, so the board counts
down in seconds (`0:41`, `12:07`) and re-renders every second. Rows are sorted on
that timestamp, never on `etaMin`: a bus 58 s away and one 86 s away both round
to `1`, and sorting by the rounded value ordered them by luck.

Map pins count down from the same timestamp, floored to whole minutes, so a row
reading `11:03` has a pin reading `11m`. They used to carry the rounded `etaMin`
frozen at fetch time, which drifted up to a refresh behind the row and rounded
the wrong way. Rail estimates are
only minute-precise upstream, so those tick to `:00`.

A row turns amber and grows a warning triangle when its countdown drops below
the walk time to its stop — you can no longer get there on foot. That is
re-evaluated on every tick, not just on each fetch.

## One-way arrows, and which lines are running

The map draws a small arrow where a bus route runs down a one-way street. The
one-way-ness comes from OSM (`oneway=yes` on a drivable road), not inferred from
the routes: candidate points come from the route geometry, and one survives only
if it sits within 12 m of such a road and runs within 35 degrees of it.

An arrow belongs to a **road, not a line**, and is tagged with the exact
route-directions that drive it, so focusing one row hides arrows on streets that
row never touches. They are thinned across OSM ways, not within them (a street is
usually many ways), and two arrows merge only if they also point the same way, so
both carriageways of a gyratory keep an arrow. Junction geometry is excluded —
`*_link` ways, roundabouts, unnamed stubs, and anything under 60 m — which took
52 arrows down to 14 corridors.

`geo.json` also carries each line's operating windows, from
`Line/{id}/Timetable/{stopId}`. The map hides a line that is not running, so the
N73 does not sit there all afternoon and the day buses vanish at 3 a.m. Selecting
a line by chip overrides this — ask for the night bus at noon and you get it.
Schedule names are not consistent across lines ("Monday to Friday" for the 106,
"Monday to Thursday" + "Friday" for the 67, "Mo-Th Nights/Tu-Fr Morning" for the
N73), so the windows are the union of every scheduled departure regardless of day
type. That is enough to answer "is it running now"; it does not know that a
Saturday-night journey should not make Monday 01:00 look served.

## Narrowing the map

Focus a row — or press **Only** in a column header to take a whole direction —
and the opposite column slides away; narrow by chip and the two columns stack.
The transitions are animated by interpolating the grid tracks, so a dropped panel
collapses to `0fr` and fades rather than vanishing. Either way the map roughly
doubles in width, recentres on the focused stop and the next vehicle heading for
it, and becomes *about* one or more route-directions:

- every stop on those routes lights up, with their termini labelled
- one-way arrows survive only on roads those routes actually drive
- `/api/fleet/stokey?lines=...` fetches **every vehicle on those lines**, not just
  the next one per row. Vehicles still due at your stop keep their colour; the
  ones that have already gone past are grey. Full screen does the same for every
  running line — 147 vehicles across 9 lines costs one 35 KB response.

With the board showing everything, none of this fires: lighting 900 stops would
say nothing, and the fleet is not fetched at all.

## Live pins

TfL publishes no vehicle coordinates: `currentLocation` is always empty and the
dedicated bus-location API was shelved in 2021. BODS SIRI-VM (operator `TFLO`)
carries real bus positions but needs its own key, and nothing comparable exists
for rail — Network Rail's TD feed reports signalling berths, not coordinates.

TfL also rejects a URL path segment over 255 characters with a bare `400`. A bus
registration is 7 characters and a train id is 15, so the batched
`/Vehicle/{ids}/Arrivals` call silently blew that limit once there were enough
live vehicles — losing *every* pin, buses and trains, and only on a busy board.
`idChunks` splits the ids so no segment exceeds 240, and one failed chunk cannot
cost the others their pins.

So `src/vehicles.ts` estimates, for buses *and* Weaver trains alike. For the next
vehicle on each board row it reads `/Vehicle/{ids}/Arrivals`, which gives that
vehicle's predicted arrival at every stop still ahead of it. It derives the
current speed from the gap to the stop after next, then walks backwards along the
route polyline by `time × speed`, never going back past the stop already left.
Pins are labelled *estimated*. Roughly a quarter saturate at the previous stop,
which is why two vehicles sometimes share a point.

Trains need a routed polyline to sit on, which `tools/build-stokey-data.py`
stitches from the OSM route relations in member order. Watch out: the Cheshunt
relation is an out-and-back — 43 km of path between endpoints 0 km apart — so the
stitch is cut at discontinuities and the longest one-way leg is kept. Both
branches are stored and `vehicles.ts` picks whichever contains the train's next
two stations.

## History

This repo is a subtree merge of two older repos, both of whose commits are
preserved:

- `picrazy2/stratfordboard` → `public/stratford/`
- `picrazy2/stratfordboard-backend` → ported to `src/` and `functions/`

The original FastAPI backend was removed once the port was verified. To read it:

```sh
git show 6bfaa9c:app.py
```

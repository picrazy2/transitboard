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

Without `DARWIN_TOKEN` — or with an expired one — `/api/board/stratford` returns
`rail: []` and the board simply shows no National Rail departures. It does not
error. Get a key from the [Rail Data Marketplace](https://raildata.org.uk).

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

## History

This repo is a subtree merge of two older repos, both of whose commits are
preserved:

- `picrazy2/stratfordboard` → `public/stratford/`
- `picrazy2/stratfordboard-backend` → ported to `src/` and `functions/`

The original FastAPI backend was removed once the port was verified. To read it:

```sh
git show 6bfaa9c:app.py
```

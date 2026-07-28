# ComEd Outage Analyzer

[![Tests](https://github.com/pesachzirkind/comed-outage-analyzer/actions/workflows/test.yml/badge.svg)](https://github.com/pesachzirkind/comed-outage-analyzer/actions/workflows/test.yml)
[![Poll](https://github.com/pesachzirkind/comed-outage-analyzer/actions/workflows/poll.yml/badge.svg)](https://github.com/pesachzirkind/comed-outage-analyzer/actions/workflows/poll.yml)

Polls the [ComEd outage map](https://outagemap.comed.com/), saves a snapshot each
time, and tells you what changed: **how many customers and how many outages were
fixed, how fast, and which areas are recovering faster than others.**

Zero dependencies. Node 18+ (uses built-in `fetch`).

> ## ⚠️ Status: not yet pulling live ComEd data
>
> Everything in this repo works and is tested — the tile crawler, the gross/net
> analysis, the dashboard, and the scheduled workflow have all run green against
> a real KUBRA Storm Center instance end to end.
>
> What is unresolved is locating **ComEd's** instance. `outagemap.comed.com` is a
> 733-byte redirect stub; the real page loads *iFactor-era* Storm Center scripts
> (`IFactorLayersHandler.js`, `IFactorDataMonitor.js`), which is an older product
> generation than the `kubra.io/stormcenter/api/v1/…` API this client is built
> against. Twenty GUIDs were harvested from those pages and none of their
> combinations answer `currentState`, so ComEd's map may not use that API at all.
>
> Until that is resolved the scheduled poll fails deliberately rather than
> publishing anything, and there is no Pages site. A guard rejects any instance
> whose service area falls outside northern Illinois — added after a pair
> published online as "ComEd's" turned out to serve Michigan and briefly produced
> a dashboard of Detroit outages labelled as ComEd.
>
> **If you have the map open in a browser:** DevTools → Network, reload, and look
> at which data URLs the map requests (filter for `kubra`, `json`, or `.json`).
> That one observation would resolve it. Set the answer as the `COMED_INSTANCE_ID`
> and `COMED_VIEW_ID` repository variables, or pass `--instance` / `--view`.
>
> To see the dashboard itself in the meantime: `npm run demo -- --open`.

---

## Why it exists

A single number — "48,000 customers out" — tells you nothing on its own. What
you actually want to know during a storm is whether it's getting better, how
fast, and whether your neighborhood is being worked on or forgotten. That needs
history, and it needs the right arithmetic.

The one thing this tool insists on is separating **gross** from **net**. If
crews restore 5,000 customers in an hour while a new feeder drops 4,000, the
headline moves by 100. That does not mean the crews did nothing. So every window
reports three figures:

| | meaning |
|---|---|
| **fixed** | customers on outages that disappeared or shrank — actual crew progress |
| **new** | customers on outages that appeared or grew — fresh damage |
| **net** | `new − fixed` — the change you'd see on the map |

The same split applies to outage counts. Windows are rolled up from consecutive
snapshot pairs rather than by comparing the two endpoints, so an outage that
opens *and* closes inside a window still counts as one fixed.

---

## Quick start

Try it on synthetic data first — no network needed:

```bash
git clone https://github.com/pesachzirkind/comed-outage-analyzer.git
cd comed-outage-analyzer
npm run demo -- --open
```

That writes 19 fake snapshots of a six-hour storm and opens the dashboard, so
you can see exactly what the real thing produces. It's clearly labelled as
synthetic so it can't be mistaken for a real outage.

Then run it for real:

```bash
rm -rf data                    # clear the demo snapshots first
npm run serve -- --interval 5 --open
```

One process: it polls in the background and serves a dashboard at
<http://localhost:8080> that **refreshes itself** when a new snapshot lands.
Open the tab once and leave it.

If a poll fails (ComEd's map goes down exactly when a storm makes it
interesting), the last good dashboard stays up and the error shows in
`/api.json`.

| Route | |
|---|---|
| `/` | the live dashboard |
| `/api.json` | current totals, last poll time, last error |
| `POST /refresh` | force a poll now |

It binds to `127.0.0.1` — this machine only. `--host 0.0.0.0` exposes it to your
network, which it will warn you about; there's no authentication.

---

## Commands

| Command | What it does |
|---|---|
| `serve` | Poll in the background, serve a self-refreshing dashboard. **The main one.** |
| `check` | Poll once, print what changed, rebuild the dashboard |
| `watch` | Run `check` on a timer (`--interval <minutes>`) |
| `poll` | Fetch and save a snapshot, no report |
| `report` | Re-analyze saved snapshots and print (no network) |
| `html` | Rebuild the dashboard from saved snapshots (no network) |
| `demo` | Generate synthetic snapshots to try it offline |
| `status` | How much history has been collected |

```
--port <n>          Port for serve (default 8080)
--host <addr>       Bind address for serve (default 127.0.0.1)
--interval <min>    Polling interval for serve/watch (default 10)
--since <when>      Totals fixed since an earlier point: "first", "90m", "3h",
                    a snapshot count back ("5"), or an ISO timestamp
--keep-hours <h>    Delete snapshots older than this after each poll
--zones <path>      Custom area definitions (see zones.example.json)
--data-dir <path>   Where snapshots live (default ./data)
--out <path>        Dashboard path (default ./dashboard.html)
--max-zoom <n>      Tile crawl depth 7–14 (default 11)
--max-requests <n>  Per-poll request cap (default 1500)
--json              Machine-readable output instead of the text report
--open              Open the dashboard when it's built
```

```bash
node comed.js report --since first        # everything fixed since you started
node comed.js report --since 90m --json   # last 90 minutes, as JSON
node comed.js check --max-zoom 13         # finer per-incident tracking
```

Snapshots are kept as whole JSON files under `data/snapshots/`, so `report` and
`html` can re-analyze the entire history at any time without re-fetching.

---

## Time windows

Rates are broken out at 5m / 15m / 30m / 1h / 3h / 6h / 24h. A window can only
be as fine as your polling interval: if you poll every 20 minutes, the "5 min"
row actually measures 20 minutes and is flagged with `*`. Poll every 5 minutes
if you want the 5-minute number to mean what it says.

## "Which areas are faster?"

Ranking by raw customers restored just finds the biggest areas. The ranking uses
**share restored** — customers fixed ÷ customers that were out at the start of
the window — so an area clearing 500 of 1,000 outranks one clearing 900 of
50,000. Areas under 50 customers are excluded; a zone going 3 → 0 is "100%
restored" and means nothing.

Areas come from nearest-centroid assignment against a built-in list of ComEd
counties, with Cook County split into sub-areas — it holds most of the
customers, and one "Cook" bucket would hide exactly the differences worth
seeing. Override it with your own: copy `zones.example.json` to `zones.json`,
edit, and pass `--zones zones.json`. A `bbox` zone lets you carve out one
precise area — your block, a specific suburb — and it beats any centroid.

---

## The hosted dashboard

`.github/workflows/poll.yml` runs every 10 minutes: it polls, rebuilds the
dashboard, and deploys it to GitHub Pages. Public repos get free Actions minutes
and free Pages, so this costs nothing. (See the status note at the top — the poll
step currently fails on purpose until ComEd's Storm Center instance is identified.)

Pages also has to be switched on once by hand: **Settings → Pages → Source →
GitHub Actions**. The workflow asks `configure-pages` to enable it automatically,
but that call needs a permission the default Actions token does not carry.

Snapshot history lives on an orphan `data` branch, force-pushed as a single
commit each run. Committing to `main` instead would grow the repo forever — 144
commits a day, each carrying a full outage list — so the workflow keeps a rolling
72 hours (`--keep-hours 72`) and no history behind it.

**Setup:** the workflow enables Pages itself on the first run. Just run the
*Poll ComEd* workflow once from the Actions tab; it picks up the schedule after
that.

GitHub delays scheduled workflows under load, so snapshots land at irregular
intervals. That's handled — every rate is computed from the span actually
measured, and windows finer than the real interval get flagged — but it's why
the sub-hour rows will usually carry a `*` on the hosted version. Run `serve`
locally if you want honest 5-minute resolution.

### Running it somewhere else

**Your own machine** is the best fit for watching a storm:
`npm run serve -- --interval 5`. Free, reliable, no cron delays. The machine has
to be awake.

**An always-on box** — a Raspberry Pi, a home server, a $4–6/month VPS — same
command plus a `systemd` unit or `pm2` so it survives reboots. This is the move
if you want history to accumulate across a multi-day storm.

---

## How it gets the data

The map is a KUBRA Storm Center instance. Nothing about it is documented, and
the data paths rotate on every refresh cycle, so each poll walks the chain:

1. scrape the map page for the instance + view GUIDs (cached after the first success)
2. `currentState` → the current data paths and deployment id
3. `configuration/{deploymentId}` → the cluster layer name
4. `summary-1/data.json` → ComEd's own system-wide totals
5. crawl the quadkey tile pyramid → individual outages with lat/lon, customers,
   cause, crew status, start time, and ETR

Headline totals come from step 4 and are exact. The per-area breakdown and the
fixed/new counts come from step 5, and the report says so whenever crawl
coverage is incomplete.

### If auto-discovery fails

The GUIDs only change when ComEd redeploys, so pasting them once is a fine
escape hatch — and the tool tells you how when it can't find them:

1. Open <https://outagemap.comed.com/> in a browser
2. DevTools → Network, filter for `currentState`
3. The URL looks like
   `kubra.io/stormcenter/api/v1/stormcenters/<INSTANCE>/views/<VIEW>/currentState`
4. Run once with `--instance <INSTANCE> --view <VIEW>`; they're cached in
   `data/config.json` afterwards

---

## Known limits

- **Cluster resolution.** At low zoom the map returns clusters rather than
  individual incidents. The crawl descends into them, but anything still
  clustered at `--max-zoom` gets a synthetic id derived from its location and
  start time. That id is stable between polls, but it makes fixed/new counts
  approximate. The report warns when more than 30% of features are clusters.
- **Request cost.** Depth 11 is a good default. Depth 13–14 gives true
  per-incident tracking at the cost of many more requests; `--max-requests`
  caps it, and the report tells you when the cap tripped.
- **Projections are a floor, not a promise.** The all-clear estimate
  extrapolates the recent net rate. Real restorations tail off — the last 5% of
  customers takes far longer than the first 50%.
- **Areas are approximate.** Zones are centroid-based, not real county
  polygons. An outage near a boundary can land in the neighbouring bucket. Use
  `bbox` zones where you need precision.

---

## Tests

```bash
npm test
```

46 tests covering polyline and quadkey math, zone assignment, the gross/net diff
engine, window roll-ups, `--since` parsing, retention pruning, the tile crawl
(cluster descent, id stability, request cap), timestamp normalization, the HTTP
server, and report rendering.

The dashboard's three series colours are validated against the all-pairs
colour-vision-deficiency list in both light and dark themes. Changing a hex
means re-running that check.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by ComEd or Exelon. It reads the same public
outage map anyone can open in a browser.

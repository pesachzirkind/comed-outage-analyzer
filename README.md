# ComEd Outage Analyzer

Polls the [ComEd outage map](https://www.comed.com/Outages/CheckOutageStatus/Pages/OutageMap.aspx),
saves a snapshot each time, and tells you what changed: how many customers and
how many outages were fixed, how fast, and **which areas are recovering faster
than others**.

Run `check` every 5–10 minutes and you get a running picture of the restoration
effort instead of a single number that means nothing on its own.

Zero dependencies. Node 18+ (uses built-in `fetch`).

---

## Quick start

Try it on synthetic data first — no network needed:

```bash
cd tools/comed-outage-analyzer
node comed.js demo --open
```

That writes 19 fake snapshots of a six-hour storm and opens the dashboard, so
you can see exactly what the real thing produces.

Then point it at the real map:

```bash
rm -rf data                 # clear the demo snapshots first
node comed.js check         # poll, report, rebuild the dashboard
```

Repeat `check` whenever you want an update, or let it run itself:

```bash
node comed.js watch --interval 5 --open
```

The first poll only establishes a baseline — rates need at least two.

---

## What you get

**In the terminal**, after each check:

```
  3,662 customers out   ·   31 outages
  ▼ 1,275 customers · ▼ 3 outages (vs 20 min ago)

  Trend   █▇▆▅▄▄▃▃▃▂▂▂▁▁▁▁▁▁▁   65,070 → 3,662
          peak 65,070 at 6:46 PM

  Since last check  (20 min)
    fixed        1,275 customers      3 outages   (3,825 cust/hr, 9 outages/hr)
    new              0 customers      0 outages   (0 cust/hr, 0 outages/hr)
    net         -1,275 customers     -3 outages

  Rates by window
    window      measured    customers/hr   outages/hr    net cust/hr
    5 min     *    20 min           3,825            9         -3,825
    15 min    *    20 min           3,825            9         -3,825
    30 min    *    40 min           2,402            6         -2,401
    1 hour    *    1h 20m           1,945            5         -1,945
    3 hours        3h 20m           4,326           11         -4,326

  Recovering fastest  (share of customers restored, last 3h 20m)
    Lake County                  94%    3,365 customers,   6 outages fixed  ·  198 still out
    McHenry County               84%    1,749 customers,   6 outages fixed  ·  345 still out
    ...
```

**In `dashboard.html`** — a self-contained page (works offline, light and dark
theme, hover tooltips): headline tiles, the fixed-per-window table, a customers-
out trend chart, restored-vs-new bars per interval, area rankings, causes, and
ETR health.

---

## How the numbers work

The one thing this tool insists on is separating **gross** from **net**.

If crews restore 5,000 customers in an hour while a new feeder drops 4,000, the
headline total moves by 100. That does not mean the crews did nothing. So every
window reports three figures:

| | meaning |
|---|---|
| **fixed** | customers on outages that disappeared or shrank — actual crew progress |
| **new** | customers on outages that appeared or grew — fresh damage |
| **net** | `new − fixed` — the change you'd see on the map |

The same split applies to outage counts (outages closed vs. opened).

Windows are rolled up from consecutive snapshot pairs rather than by comparing
the two endpoints, so an outage that opens *and* closes inside the window still
counts as one fixed.

### "Which areas are faster?"

Ranking by raw customers restored just finds the biggest areas. The ranking uses
**share restored** — customers fixed ÷ customers that were out at the start of
the window — so an area clearing 500 of 1,000 outranks one clearing 900 of
50,000. Areas under 50 customers are excluded; a zone going 3 → 0 is "100%
restored" and means nothing.

Areas come from nearest-centroid assignment against a built-in list of ComEd
counties, with Cook County split into sub-areas (it holds most of the customers,
and one "Cook" bucket would hide exactly the differences worth seeing). Override
it with your own: copy `zones.example.json` to `zones.json`, edit, and pass
`--zones zones.json`. A `bbox` zone lets you carve out one precise area — your
block, a specific suburb — and it beats any centroid.

### Window resolution

Rates are broken out at 5m / 15m / 30m / 1h / 3h / 6h / 24h. A window can only
be as fine as your polling interval: if you poll every 20 minutes, the "5 min"
row actually measures 20 minutes and is flagged with `*`. Poll every 5 minutes
if you want the 5-minute number to mean what it says.

---

## Commands

| Command | What it does |
|---|---|
| `check` | Poll once, print what changed, rebuild the dashboard. **The main one.** |
| `watch` | Run `check` on a timer (`--interval <minutes>`, default 10) |
| `poll` | Fetch and save a snapshot, no report |
| `report` | Re-analyze saved snapshots and print (no network) |
| `html` | Rebuild `dashboard.html` from saved snapshots (no network) |
| `demo` | Generate synthetic snapshots to try the tool offline |
| `status` | How much history has been collected |

Useful options:

```
--since <when>      Totals fixed since an earlier point: "first", "90m", "3h",
                    a snapshot count back ("5"), or an ISO timestamp
--zones <path>      Custom area definitions
--data-dir <path>   Where snapshots live (default ./data)
--out <path>        Dashboard path (default ./dashboard.html)
--max-zoom <n>      Tile crawl depth 7–14 (default 11)
--max-requests <n>  Per-poll request cap (default 1500)
--json              Machine-readable output instead of the text report
--open              Open the dashboard when it's built
```

Examples:

```bash
node comed.js report --since first          # everything fixed since you started
node comed.js report --since 90m --json     # last 90 minutes, as JSON
node comed.js check --max-zoom 13           # finer per-incident tracking
```

Snapshots are kept as whole JSON files under `data/snapshots/`, so `report` and
`html` can re-analyze the entire history at any time without re-fetching.

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
  approximate. The report warns when more than 30% of features are clusters —
  raise `--max-zoom` if you see it.
- **Request cost.** Depth 11 is a good default. Depth 13–14 gives true
  per-incident tracking at the cost of many more requests; `--max-requests`
  caps it, and the report tells you when the cap tripped.
- **Projections are a floor, not a promise.** The all-clear estimate
  extrapolates the recent net rate. Real restorations tail off — the last 5% of
  customers takes far longer than the first 50%.
- **Areas are approximate.** Zones are centroid-based, not real county
  polygons. An outage near a boundary can land in the neighbouring bucket. Use
  `bbox` zones where you need precision.
- **Not verified against the live endpoint.** This was built from the
  documented KUBRA Storm Center request chain and tested against synthetic
  fixtures modeled on it; the sandbox it was written in could not reach
  `comed.com` or `kubra.io`. The first real `check` is the true smoke test —
  if the shape has drifted, the errors point at which step failed.

---

## Tests

```bash
npm test
```

41 tests covering polyline and quadkey math, zone assignment, the gross/net diff
engine, window roll-ups, `--since` parsing, the tile crawl (including cluster
descent, id stability, and the request cap), timestamp normalization, and report
rendering.

# Endpoint field notes

Everything here was observed from a machine with open egress (a GitHub Actions
runner), via `node comed.js diagnose`. It is recorded because working it out
took nine CI rounds and several wrong turns, and the next person — including a
future me — should not repeat them.

## ComEd is not a modern KUBRA deployment

The tool was first built against KUBRA Storm Center's documented chain:

```
kubra.io/stormcenter/api/v1/stormcenters/{instance}/views/{view}/currentState
```

ComEd's map has **no GUIDs in it at all**. Its scripts are iFactor-era Storm
Center on Bing Maps v8 (`Microsoft.Maps`, `IFactorLayersHandler`,
`TileSource({uriConstructor})`), a product generation predating instance/view
identifiers.

Twenty GUIDs *are* reachable from `www.comed.com` and `secure.comed.com`, and
none of them are Kubra ids — they are SharePoint web-part identifiers on the
surrounding page furniture. Probing their combinations is a dead end.

## The iFactor protocol (outagemap.comed.com)

Configuration lives in:

- `scripts/mobile_impl/IFactorDataMonitor_config.js` — polling and data sources
- `scripts/mobile_impl/IFactorLayersHandler_config.js` — layers and directories

The map polls a pointer rather than calling an API:

```
data/interval_generation_data/metadata.xml     -> current {directory}
{directory}/data.js                            -> storm_mode, total_outages,
                                                  total_customers, date_generated
{directory}/thematic/thematic_areas.js         -> per-county aggregates
{directory}/thematiczip/thematic_areas.js      -> per-ZIP aggregates
{directory}/outages/*.js                       -> individual outages (indexvectorlayer)
datastatic/serviceareastilespurple/{quadkey}.png -> service-area tiles
```

Path composition is `data/interval_generation_data/{directory}/…`.
`IFactorDataMonitor.timerInterval = 120`, so the map itself refreshes every two
minutes — 5-minute polling is well within what the source supports.

### Payload shape

`thematic_areas.js` is JSON despite the `.js` extension:

```json
{"file_title":"thematic","file_data":[
  {"id":"DU PAGE","title":"DU PAGE",
   "desc":[{"n_out":"6","cust_s":"0","cust_a":"19",
            "etr":"Nov 17, 12:00 AM",
            "href":"zoomToThematicArea(41.83956,-88.08863)"}],
   "geom":[{"a":"gbo}FhfhxOzMIf_A…"}]}
]}
```

Details that will bite an implementer:

- **`cust_a` is not always a number.** Small outages report the string
  `"Less than 5"`. Coercing it yields `NaN`.
- `n_out` and `cust_s` are strings too.
- `etr` is a human-formatted local string (`"Nov 17, 12:00 AM"`) with no year.
- The centroid is embedded in a **JavaScript call inside `href`**:
  `zoomToThematicArea(lat,lon)` — parse it, do not evaluate it.
- `geom[].a` is an encoded polyline (`coord_compress: true`), the same encoding
  `src/polyline.js` already decodes.
- `outages/{index}.js` returned 404 for every name tried
  (`index.js`, `data.js`, `0.js`, `03.js`, `030.js`); the index scheme for the
  `indexvectorlayer` is still unknown.

## Why this host cannot be used

`metadata.xml` has pointed at `2020_11_16_18_00_46` for years. Every request
succeeds and the data is well-formed — it is simply from November 2020.
`outagemap.comed.com` is a decommissioned deployment still serving its last
snapshot.

**This is the important lesson of the whole exercise.** A source that responds
correctly is not thereby the right source. Two independent guards exist because
both ways of getting this wrong have already happened:

- a **territory check** — the service area must overlap northern Illinois
  (caught a Michigan utility being reported as ComEd)
- **staleness detection** — iFactor directory names are timestamped, so age is
  checkable (`directoryAgeHours` in `src/diagnose.js`)

## Where to look next

ComEd's live map is the Angular application under
`www.comed.com/Outages/CheckOutageStatus/`. Its hashed bundles
(`main.*.js`, `runtime.*.js`) cannot be fetched by path: the server returns the
8421-byte SPA shell for any unknown path, so the real asset base has to be found
first. Loading the page in a browser and watching the network panel remains the
fastest way to identify its data endpoint.

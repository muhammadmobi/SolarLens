# Changelog

All notable changes to SolarLens are recorded here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

A note on why this file exists rather than only GitHub Releases: the changelog
is the durable record and ships with the code, so a checkout at any commit can
tell you what it contains. Each tagged release then copies the matching section
into its release notes on GitHub, which is where the download links and the
"what changed since you last looked" view live. One is the source, the other is
the announcement.

## [Unreleased]

### Added

- **Light / dark theme toggle** in the top-right corner. Three states — follow
  the system, force light, force dark — remembered in `localStorage`. The
  choice is applied before first paint, so the page never flashes the wrong
  theme.
- **Labelled header totals.** The bare "20 W" is now `Producing now`, beside
  `Produced today`, `Consumed today` and `Weather`, each with a tooltip saying
  what it covers. Every system card carries the same labels, and the hero
  figure reads "of 12 kW rated" so a small number is legible against the size
  of the array.
- **Site weather from the Google Maps Platform Weather API.** SolisCloud ships
  a condition and a min/max with its station payload; SolarMan ships none. One
  lookup per site now stamps condition, current temperature, today's range and
  sunrise/sunset onto both systems. Cached for 30 minutes so the five-minute
  poll does not bill a call each time. Optional: without `GOOGLE_WEATHER_KEY`
  the vendor's own weather stands.
- **Battery panel on the overview** for hybrid systems: charge level ring,
  what the pack is doing right now (charging / discharging / idle), pack
  temperature, and the day's charge and discharge energy.
- **Battery nameplate and BMS detail** — rated capacity, nominal voltage,
  chemistry, pack status, BMS state of charge, and BMS charge/discharge
  voltage, read from SolarMan's register categories.
- **Equivalent full cycles.** Neither cloud reports a cycle counter, so the
  detail view derives one from lifetime charge energy against the pack's usable
  capacity, and labels it `derived` rather than passing it off as a vendor
  figure.
- **Full-load hours** on both providers (`fullHour` on SolisCloud,
  `fullPowerHoursDay` on SolarMan).
- **An Alerts tab** — everything either cloud says is wrong, one collapsible
  section per system under a single tab, with a count badge on the tab itself.
  Nothing is invented: SolisCloud's alarm count and level, SolarMan's
  inverter/service/load warning flags and link status, per-device alarm and
  offline states, weak datalogger signal, and SolarLens's own failed polls,
  each row naming the field it came from. A system with nothing wrong lists
  what was checked, so an empty section reads as "clear" rather than "nobody
  looked".
- **A clickable chart legend.** Two curves lying on top of each other are two
  curves you cannot read, so each name is a switch: click to drop that system
  out of the picture and the axis rescales to what is left. The fleet sum is a
  switch too, the choice is remembered per browser, and turning everything off
  says so rather than drawing an empty box.
- **An app icon and favicon** — a lens ring split into the two vendor accents
  around a sun core.
- `kv` table (migration `0007`) — a small expiring key/value shelf, first used
  by the weather cache.
- Branch protection on `main`: pull requests required, linear history, no force
  pushes, no deletions.

### Changed

- **The energy flow diagram redrawn.** The house is now the load itself —
  before, the diagram drew a house in the middle *and* a separate
  "Consumption" node with a house glyph, leaving you to work out they were the
  same place. Solar and grid flank it on one line and a hybrid hangs its
  battery below, so every arm is a straight run rather than an elbowed circuit
  trace. Wire thickness tracks how much power an arm carries, so a 20 W trickle
  no longer looks like a 5 kW flood. Idle arms are dashed as well as grey, and
  a pack drifting under 50 W now reads idle here exactly as it does everywhere
  else on the page — the diagram used to animate it as a live flow. Labels are
  large enough to read at half-card width, and a bar underneath says how much
  of the house's current draw is coming from its own kit rather than the meter.
- **Nothing stale is presented as current.** "Producing now" counts only
  systems that have reported inside the staleness window and names any that
  have gone quiet; a stale headline figure is dimmed and relabelled "last known
  output"; the status pill says "not reporting" instead of repeating the
  vendor's hours-old "online"; and a dead feed's diagram drops its travelling
  pips. Today's energy still counts a quiet system — those kWh were real.
- **Charts are easier to read**: larger axis type, three-hourly time ticks, an
  explicit "watts" unit label, a marked daily peak with the time it happened,
  and a taller plot area.
- **"Offline" means offline.** One word for one state, from either direction:
  the vendor calling the plant down, or nothing arriving for fifteen minutes.
  Both now read `offline` rather than one saying "online" while the sample
  beside it is an hour old. An offline system's instantaneous figures are
  **zero** — output, grid, load and battery power — instead of repeating
  whatever it last managed before it dropped, and its flow diagram goes dead to
  match. Cumulative figures (today, lifetime, charge level) are untouched:
  those were genuinely true and still are.
- **The chart on the Power page collapses**, like the system sections below it.
- **The Power page collapses per system.** Each inverter is a `<details>`
  section with its own complete grid, so a two-system fleet no longer scrolls
  as one long wall.
- Overview order now runs energy flow, then figures, then curves, with each
  system in its own box in every band.

### Fixed

- **Arrowheads no longer borrow the wrong system's colour.** Both flow diagrams
  defined an SVG marker with the same id, and `url(#id)` resolves to whichever
  came first in the document — so the SolarMan diagram drew its arrows in the
  SolisCloud accent. Each diagram names its own markers now.
- **A re-pushed sample refreshes the whole row, not part of it.** The first cut
  of the refresh above updated only `metrics` and `raw`, which was worse than
  updating nothing: a vendor can revise a payload without moving its timestamp
  (an inverter going offline keeps the same `dataTimestamp` and only flips its
  state field), so the row ended up with a `status` of "online" sitting beside
  a raw payload that said otherwise. That is exactly what was making a dead
  plant read as online.
- **`npm run db:local` / `db:remote` no longer go stale.** They hand-listed
  every migration file, and migration 7 was never added, so a fresh install
  would have had no `kv` table for the weather cache to write to. They call
  `wrangler d1 migrations apply` now, which reads the directory.
- **The test suite is typechecked.** `tsconfig.json` only covered `src`, so the
  README's claim that a data-shape change fails at compile time was not true of
  the tests themselves. `npm test` now typechecks both first — which
  immediately turned up two latent type errors in the specs.
- **A parser improvement now reaches the newest row.** `insertReading` used
  `INSERT OR IGNORE`, so re-pushing a timestamp the database already held threw
  the improved metrics away and the new fields stayed blank until the vendor
  happened to produce a fresh sample. Existing rows now have their derived
  columns refreshed in place.

## [2.0.0] — 2026-09-07

The interface rebuild. Same data, restructured around what you actually look at.

### Added

- Energy flow diagrams — PV, battery, house and grid with animated,
  direction-aware arms — drawn per system rather than for the fleet as a whole.
- Per-system detail pages on a hash route, reachable from any card.
- A Power page carrying the complete figure set for every system.
- Per-system generation curves alongside the combined fleet curve.

### Changed

- Refreshed visual design throughout: system cards, status pills, typography
  and spacing.
- Navigation renamed to plain words — Overview, Power, Devices.
- The separate Energy flow tab was folded into the overview, where the diagram
  now leads.

## [1.0.0] — 2026-09-06

First working aggregator: two clouds, one screen.

### Added

- Cloudflare Worker + D1 backend on the free tier, with a five-minute cron
  poll, a normalised `Reading` shape and a `Metrics` bag for the extended
  figures the vendor apps show.
- **SolisCloud** adapter over the official HMAC-SHA1-signed API, plus a local
  Playwright **relay agent** for accounts without API access — the portal signs
  its own requests with a secret embedded in its bundle, which cannot be
  reproduced server-side.
- **SolarMan** adapter, including a web-session fallback for accounts where
  Turnstile blocks password login, and the `v3/detail` device endpoint.
- Device inventory: inverters, dataloggers, firmware, datalogger signal
  (reported in dBm by SolisCloud and as a percentage by SolarMan, so kept in
  separate columns rather than mislabelled as one scale), per-string DC
  voltage/current/power, per-phase AC, and inverter temperature.
- Extended metrics: monthly and yearly generation, consumption, grid import and
  export, battery charge and discharge, self-consumption.
- Raw telemetry view, with a filter, for every stored field.
- Unit tests (Vitest) over the normalisers and e2e tests (Playwright) over the
  dashboard.

### Fixed

- On-grid inverters no longer show an invented battery. SolisCloud returns
  `batteryCapacitySoc2: 0` for a string inverter, which read as an empty pack;
  the battery arm and card are now gated on the plant actually reporting one.
- Battery drift under 50 W in either direction reads as idle rather than as
  charge or discharge — that is BMS and meter noise, and SolarMan calls the
  same reading "STATIC".
- The relay's ingest routes no longer return 401 (the auth exemption matched
  one exact path instead of the prefix).
- Raw telemetry is no longer always empty — the `latest` query never selected
  the column it displays.

[Unreleased]: https://github.com/muhammadmobi/SolarLens/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/muhammadmobi/SolarLens/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/muhammadmobi/SolarLens/releases/tag/v1.0.0

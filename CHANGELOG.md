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
- **An app icon and favicon** — a lens ring split into the two vendor accents
  around a sun core.
- `kv` table (migration `0007`) — a small expiring key/value shelf, first used
  by the weather cache.
- Branch protection on `main`: pull requests required, linear history, no force
  pushes, no deletions.

### Changed

- **Charts are easier to read**: larger axis type, three-hourly time ticks, an
  explicit "watts" unit label, a marked daily peak with the time it happened,
  and a taller plot area.
- **The Power page collapses per system.** Each inverter is a `<details>`
  section with its own complete grid, so a two-system fleet no longer scrolls
  as one long wall.
- Overview order now runs energy flow, then figures, then curves, with each
  system in its own box in every band.

### Fixed

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

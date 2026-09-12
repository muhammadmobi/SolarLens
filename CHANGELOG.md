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

## [2.2.0] — 2026-09-12

The three gaps `docs/feature-gaps.md` had carried since the first release, closed.

### Added

- **Every system's day ends where its own sun sets.** A solar day runs from the
  array's midnight to the array's midnight, and until now every day in this app
  was cut at the *reader's* instead. Open the dashboard from a country five
  hours away and each day's yield was two half-days glued together, the peak
  time named an hour that never happened over the panels, and "produced today"
  quietly meant "produced since your midnight".

  Both vendors do say where a plant is, in three different shapes: SolisCloud
  sends whole hours, SolarMan's station detail sends seconds and its station
  search sends an IANA zone name. All three are read, seconds preferred over
  hours because a half-hour zone cannot be stated in whole hours at all. The
  offset is stored per inverter by migration 0009 and refreshed on every poll.

  It is applied everywhere a day is counted: the daily history query splits on
  each plant's own midnight, `/api/series` opens its window at the earliest of
  the plants' midnights so no system loses its morning, and on the page every
  curve, peak, tile and legend is cut back to its own system's day. A plant
  whose vendor says nothing falls back to the reader's midnight, which is
  exactly what every plant used before — so nothing changes for a reader
  sitting next to their panels, which is the common case and the one that was
  never wrong.

- **Self-sufficiency and self-consumption, as percentages.** Self-use was shown
  in kilowatt-hours and left the actual question unanswered. The system page now
  gives both ratios, because they are different questions and a day can be high
  on one and low on the other: self-sufficiency is the share of the house load
  met without the grid, self-consumption the share of generation that stayed
  home rather than being exported.

  Neither is shown where the denominator was never metered. An on-grid plant
  with no current clamp reports no load at all, and before dawn a metered house
  has consumed nothing — "0 % self-sufficient" would be a claim about a day
  that has not started. The pair is clamped at 100, because the vendors round
  the two counters independently and they can cross by a rounding step.

- **Installable.** A web app manifest, both icon sizes rendered from the
  existing `icon.svg` by `scripts/make-icons.mjs`, and a service worker. Added
  to a phone's home screen it opens in its own window with no browser chrome.

  The worker goes to the network first and reads its cache only when the
  network failed, which is the whole design: a dashboard that served yesterday's
  watts from disk would be worse than one that failed honestly. It never
  replays a POST, and a page opened over plain HTTP simply does not register it
  and loses nothing.

### Changed

- **`GET /api/series` picks its own window when asked to.** Omit `from` and it
  opens at the earliest plant's midnight instead of a fixed 24 hours back, since
  only the Worker knows every plant's zone before the page has any data. `tz`,
  the caller's UTC offset in minutes, is the fallback. Passing `from`
  explicitly behaves exactly as it did.

- **Clock labels on a chart are the plant's.** "Peak at 13:04" is a statement
  about the sun over the array, not about where the page happens to be open.

### Fixed

- **Three rows of `docs/feature-gaps.md` claimed less than the app does.**
  Full-load hours were listed as captured but not surfaced after shipping on the
  overview in 2.1.0; BMS detail was listed as unsurfaced while pack voltage,
  current, temperature and both charge limits were already on the system page;
  and the day/month/year row read as a flat no despite the Historical Data tab.
  Section 4 now lists what is actually left, none of it small.

## [2.1.0] — 2026-09-12

The overview in one screen, and the vendor clients under test.

### Added

- **The vendor HTTP clients are tested.** `tests/unit/clients.test.ts` drives
  all three against a stubbed `fetch`: SolisCloud request signing, SolarMan
  token acquisition and refresh-and-retry on both a bare 401 and the vendor's
  own `2101` code, the browser-session refresh flow, the error envelopes and
  the HTTP failure paths. Twenty-two tests, and the providers go from 6–65%
  covered to 67–85%. The suite is 122 unit tests and 154 end-to-end tests.

  Enforced coverage is now **83.7% statements, 84.9% functions, 85.3% lines**,
  with thresholds raised to 80. Branches sits at 65% and is held at 63: the
  vendor payloads are full of optional fields read through fallback chains, and
  covering every arm means a fixture per arm for figures already covered on the
  path that matters.

  Two things the file needs, both worth knowing before editing it. SolisCloud
  signs with MD5, which WebCrypto does not define and Workers adds, so the
  tests delegate that one algorithm to `node:crypto` — which is why
  `@types/node` is now a dev dependency. And each provider's `CallQueue` holds
  1.5–2s between calls, so `minGapMs` is public and the tests set it to zero;
  faking timers instead strands a pending timer in a module-level singleton and
  hangs every later test in the file.

  One finding along the way: a 19-digit SolisCloud station id has to arrive as
  a JSON string. Sent as a number it exceeds `Number.MAX_SAFE_INTEGER` and
  arrives rounded — `…001` becomes `…000`, and every later lookup misses. The
  real payloads do send strings; the first draft of the test did not, which is
  how it surfaced.

- **Coverage now measures the file that decides what leaves the Worker.** The
  scope was `src/providers/**`, so `public-view.ts` — which strips vendor
  station ids, plant ids and serial numbers from every public response — carried
  thirteen tests and no coverage number. Widening the scope raised the enforced
  figures rather than lowering them, and the README now carries the whole-`src/`
  figure too, 55.2%, so the ground left to the Playwright suite is visible
  rather than hidden behind a flattering scope.

### Changed

- **The overview is one screenful.** It was three full-width bands — energy
  flow, then figures, then the day curve — each repeated per system, which came
  to 1,695px of page in a 900px window on a 1440×900 laptop, and 2,889px once
  the window narrows enough for the columns to stack. Nothing below the
  first diagram was visible without scrolling, and the two systems could never
  be seen at once, which is the entire reason for putting them on one page.

  Each system is a column now: its diagram, its figures, its curve. Most of the
  height comes back not from dropping readings but from **printing each one
  once** — producing now, house load, grid direction and battery charge were
  drawn in the diagram and then repeated as figures underneath it, which is
  most of what made the figures band the tallest of the three.

  The figures are tiles, four across, up to twelve — eight for an on-grid
  inverter, twelve once there is a battery to describe, and fewer than either
  when the vendor has not reported yet. **This year** and **full-load hours**
  appear for the first time; both were already in the database, and full-load
  hours is the one figure that compares a 12 kW array with a 3.5 kW one fairly.
  **Model** and **datalogger signal** are gone from this page: they never
  change, and the Devices tab is where hardware belongs.

  The two systems do not have the same amount to say — twelve figures against
  eight — and that difference has to land somewhere. **The diagrams match and
  the curves do not**, which is the way round that reads correctly: a picture
  drawn two-thirds the size of the one beside it looks like a rendering fault,
  while a shorter curve simply reflects a system with more figures above it.
  Reaching that took two wrong turns, both caught by holding the built page next
  to the reviewed design — first the diagram absorbed the slack and came out at
  318px against 203px, then the figures were stretched to fill and the curve was
  pinned at 216px, which spent on air between two rows of numbers what the chart
  wanted. The figures now take the height they need and the curve takes the
  rest, at 378px and 337px.

  **Everything above the chart is one link to that system's detail page**, as
  the whole card was before — a reader who wants more about a figure clicks the
  figure, not a title bar above it. The chart is the exception and opens the
  Power tab, where it is drawn full width.

  Only this tab claims the whole window, and only when the window is worth
  filling: below 1080px wide the columns stack, and below 660px tall the page
  scrolls normally, because a diagram, twelve figures and a readable curve
  genuinely do not fit in a short window and squeezing them until they collide
  is worse than a short scroll. Every other tab is a list that can legitimately
  run longer than the screen.

  `sysCard`, `flowStats` and `battPanel` existed only to draw the band this
  replaces, and are removed with it.

- **The overview's energy flow is a row, not a plan view.** The detail page puts
  the house at the centre and hangs solar, grid and battery off it, which is the
  truer picture of how a system is wired and needs the width to say so. In a
  half-width column it shrank until its own labels could not be read — and
  because a hybrid has more to draw, its picture came out at 203px against the
  on-grid plant's 318px, which reads as a rendering fault rather than as a
  system with more to show. The overview now draws solar, the house, the battery
  where there is one, then the grid, left to right, with an arrow between each
  pair lit only where power is actually moving. Both rows are 115px. The plan
  view is one click away on the system page, which still draws it.

- **Figures are set as numbers, not as text.** Anything past a thousand kWh
  reads in MWh — `49.1 MWh` rather than `49082 kWh` — and every unit is smaller
  and quieter than its figure. The chart's caption moved out of the drawing and
  into the page above it: what the reading is on the left, the day's peak on the
  right, set in the page's own type instead of scaled with the picture.

### Fixed

- **Every figure a system reports is shown, even when that is not four of
  them.** The tile grid trimmed its count to a multiple of four so a row could
  not end raggedly — and with seven figures available it showed four and hid
  three. Seven is not hypothetical: it is what an on-grid plant reports before
  dawn, when peak, full-load hours, string count and inverter temperature have
  no value yet. The last tile now stretches across what is left of its row
  instead, and a test holds it there.

- **Documentation that had drifted, some of it for longer than this release.**
  The HTTP API table still marked every `GET` as needing `API_TOKEN`, untrue
  since reads became public, and would have misled anyone using the API.
  `docs/feature-gaps.md` still advertised a "token-gated JSON API" and still
  listed history as stored-but-not-presented, after the Historical Data tab had
  shipped. The testing section claimed 86 unit tests where there were 100, and
  its coverage table still listed `weather.ts`, deleted two days earlier. The
  project layout listed that same file and hid eight scripts behind the word
  "scripts".

  A second pass over every checkable claim — routes against `src/index.ts`,
  environment variables against what the code reads, tables against the
  migrations, scripts against `package.json`, the two copies of the
  Content-Security-Policy against each other — found the layout block still
  missing six files that exist: migration `0008`, `public/_headers`,
  `public/icon.svg`, and the `logging`, `clients` and fixture tests. Two npm
  scripts were undocumented. Everything else held: the routes, the tables, the
  env vars, the 5-minute cron, the 25-minute staleness cutoff, the five tabs,
  and both security policies, which are byte-identical as the README claims.

- **Two documented figures were wrong.** The measurement this layout was
  justified by was quoted as 2,889px "on a 1440×900 laptop" — real, but taken in
  a window about 725px wide, where the columns stack. At 1440×900 the old
  overview is 1,695px. And the one-screen rule was documented as needing 820px
  of window height after the value had already dropped to 660px.

## [2.0.0] — 2026-09-11

Five days that turned a working aggregator into something worth opening: a
dashboard that needs no login, tabs for alerts and history, a relay that
installs itself, and the interface rebuild of the 7th, which this version
originally carried on its own — the tag was cut on the 11th, by which point
four more days of work had landed behind it.

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
- **Every alert is stamped with the moment it describes** — a clock time and a
  relative one, in a `<time>` element with a machine-readable `datetime`. A
  device's stamp is its own last contact rather than the plant's newest update,
  a failed poll carries when it failed, and a clean system says which update it
  was judged against. Rows sort faults first, then newest.
- **Unit tests for the weather lookup and the call queue** — coordinate
  extraction per vendor payload shape, the two Google responses mapped in the
  site's timezone, the cache serving instead of paying, and a weather outage
  never taking the poll down. The queue's ordering, its minimum gap, and that
  one failed call does not strand the calls behind it.
- **Coverage reporting** — `npm run test:unit:coverage` (v8 provider, terminal +
  HTML + lcov) with thresholds set just under the achieved figures, so a
  regression trips them. Documented honestly in the README, including what the
  uncovered portion is and why it is covered elsewhere.
- **The solar node carries its share of the array's rating** — `Solar · 73%`
  right on the title, which is what makes a 12 kW system and a 3.5 kW one
  comparable at a glance.
- **A sparse day is drawn as samples, not as an invisible line.** A few readings
  twenty minutes apart on a 24-hour axis is a two-pixel smudge that reads as
  "the graph is showing nothing". When a series covers only a short stretch of
  the day, each sample is marked; the unrecorded part of the axis is shaded and
  labelled `recorded from 12:15`, so an empty morning reads as missing data
  rather than as a flat zero the system genuinely produced. That claim is made
  only when the vendor reported sunrise and the record began well after it —
  a curve that starts at six o'clock is just sunrise, and warning about it every
  morning would be noise.
- **The footer names every feed**, not just whichever logged most recently.
  Only SolarMan runs on the cron; SolisCloud arrives through the relay, which
  never wrote to the poll log at all - so the footer read `last poll (solarman)
  ok — plants=1 inverters=1` and never mentioned the other system, which looks
  exactly like a dashboard tracking one inverter. The relay logs its pushes
  now, `/api/health` returns the newest line per provider, and the footer shows
  one entry per feed with failures marked.
- **Backfill of today's curve.** The relay only records while it is running, so
  a machine asleep until noon left the morning blank on a graph that then looked
  like a system which had produced nothing. The relay now also catches the chart
  call the portal makes for its own graph and pushes it to `/api/ingest/history`.
  Backfilled rows land under a `-history` source: `latest` ignores them, and the
  series query prefers a live sample wherever both describe the same instant.
- **A Historical Data tab** — day by day per system: produced, consumed,
  imported, exported, battery in and out, peak and sample count, with a bar per
  day and a 7/30/90-day range. The daily figures the vendors publish are
  counters that climb and reset at local midnight, so a day's total is the
  largest value inside it — grouped by the reader's own midnight, because a
  solar day does not end at UTC's. Columns appear only where that system
  measures the quantity, and the page says plainly that the record begins when
  SolarLens started collecting.
- **Security headers**: a Content-Security-Policy strict about where anything
  may be *sent* as well as where it may come from, plus `nosniff`,
  `no-referrer` — which also stops the one-time `/auth?t=` link leaking the
  token in a `Referer` — and `frame-ancestors 'none'`.
- **An app icon and favicon** — a lens ring split into the two vendor accents
  around a sun core.
- `kv` table (migration `0007`) — a small expiring key/value shelf, first used
  by the weather cache.
- Branch protection on `main`: pull requests required, linear history, no force
  pushes, no deletions.

- Energy flow diagrams — PV, battery, house and grid with animated,
  direction-aware arms — drawn per system rather than for the fleet as a whole.
- Per-system detail pages on a hash route, reachable from any card.
- A Power page carrying the complete figure set for every system.
- Per-system generation curves alongside the combined fleet curve.

### Changed

- **The dashboard opens without a login.** `GET /api/*` now answers everyone, so
  the URL works on a phone, a second laptop or a relative's tablet with nothing
  to copy first. The per-device `/auth?t=<API_TOKEN>` unlock was a tax paid on
  every new device and forgotten exactly when it mattered — and, because the
  cookie *is* the token, a token lost from `.dev.vars` locked out every device
  that had not already been unlocked.

  The cost is bounded rather than accepted. A new `src/public-view.ts` strips
  vendor identifiers from every response before it leaves the Worker: station
  and plant ids become positional aliases (`s1`, `s2`), serial numbers are
  masked to their last four characters, and the stored raw vendor payload is not
  served at all. The aliases are positional rather than hashed on purpose — a
  SolarMan station id is eight digits, so a hash of one can be reversed by
  trying all hundred million of them.

  Nothing readable can spend money or change data: `POST /api/poll` keeps the
  `API_TOKEN` gate because it makes live vendor calls, and `/api/ingest/*` keeps
  its own `INGEST_TOKEN`. Read endpoints now send `Cache-Control: public,
  max-age=60` so a burst is answered at the edge rather than against D1, whose
  free-tier row budget this project has exhausted twice.

  What this does not hide is the measurements. Anyone with the URL can see
  generation and consumption, and a consumption curve says when a building is
  occupied. Sites that mind can put Cloudflare Access in front of the Worker,
  which covers the `workers.dev` URL and needs no change here.

- Plant names are still published: they are what each system is labelled with on
  screen. Rename the plant in the vendor portal if yours names a person.

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
- **Both flow diagrams are drawn at one size**, so a hybrid and an on-grid plant
  side by side no longer look like one card was cut short. The cards fill the
  row rather than each ending where its own content does.
- **The chart on the Power page collapses**, like the system sections below it.
- **"Last update" replaces "last sample"** everywhere, including the detail and
  Power sections, and now carries the actual date and time. "Sample" was our word for it, not one that
  says anything to someone reading a dashboard.
- **The Power page collapses per system.** Each inverter is a `<details>`
  section with its own complete grid, so a two-system fleet no longer scrolls
  as one long wall.
- Overview order now runs energy flow, then figures, then curves, with each
  system in its own box in every band.

- Refreshed visual design throughout: system cards, status pills, typography
  and spacing.
- Navigation renamed to plain words — Overview, Power, Devices.
- The separate Energy flow tab was folded into the overview, where the diagram
  now leads.

### Removed

- **The Google Weather API lookup.** Google Maps Platform requires a billing
  account, and a dashboard for two inverters is not worth a billing
  relationship. SolisCloud already ships a condition, a min/max and sunrise and
  sunset with every station snapshot, for free, and that is what the header
  shows. The only thing lost is a current temperature, and SolarMan — which
  ships no weather of its own — no longer borrows any. `GOOGLE_WEATHER_KEY`,
  `SITE_LAT` and `SITE_LON` are gone with it; the last two were the site's
  coordinates, so that is a privacy improvement as much as a billing one.

### Fixed

- **The API no longer fails open silently.** With `API_TOKEN` unset the
  dashboard is unauthenticated — deliberate for local development, but a deploy
  that lost the secret would have served the whole dataset to anyone with the
  URL and said nothing. It warns in the log and shows a banner now.
- **`npm run relay:solis` works on its own.** It needed two environment
  variables that no documented command set, so the documented invocation always
  failed. It reads `.dev.vars`, where those secrets already live.
- **The backfilled curve is in the right units.** The chart payload's
  `powerStr` labels the axis rather than the numbers beside it, so scaling by
  it put a 12 kW array at 9.47 MW. The ingest route now also measures the curve
  against the nameplate and refuses one that could not physically have happened.
- **The account holder's name and email are no longer stored.** The SolisCloud
  station snapshot carries `userEmail`, `userName`, `userId` and the site's
  coordinates. Device payloads were being stripped; the station payload was not,
  so all of it sat in the raw telemetry table. It is stripped now, and the 22
  stored rows that already held it have been scrubbed.
- **`stripPii` was eating capacity.** Its pattern matched `city`
  case-insensitively, and `capacity` contains those letters - so `capacity`,
  `capacityStr` and every `batteryCapacity*` field was being deleted from stored
  payloads in the name of privacy. Location words now only count at the start of
  a key or on a camelCase boundary.
- **Zeros are no longer presented as measurements.** An on-grid plant with no CT
  clamp still returns every grid field, filled with zeros, and SolisCloud mirrors
  generation into household load so its own flow diagram has something to draw.
  A plant that has generated 48 MWh without importing or exporting a single
  kilowatt-hour is not perfectly self-sufficient; it is unmetered. Those fields
  now read as absent, and the card says once why rather than leaving the reader
  to ask.
- **An unused MPPT input says so.** A socket with nothing plugged into it
  reports a fraction of a volt and no current, which was being drawn as a string
  producing zero watts and counted in "2 producing".
- **The two feed lines are worded alike**, so the footer reads as one kind of
  statement rather than two unrelated ones.
- **The tests are covered as well as typechecked.** `weather.ts` shipped at 6%
  coverage - a whole module with no unit tests of its own - and the call queue,
  which is the only thing standing between a cron run and a rate-limit ban, had
  none either. Both are now near-complete, taking the measured figure from 41%
  to 57% of statements.
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
- **The poll log is pruned.** Two feeds logging every five minutes is about
  576 rows a day and nothing ever deleted them. A week is kept.
- **A parser improvement now reaches the newest row.** `insertReading` used
  `INSERT OR IGNORE`, so re-pushing a timestamp the database already held threw
  the improved metrics away and the new fields stayed blank until the vendor
  happened to produce a fresh sample. Existing rows now have their derived
  columns refreshed in place.

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

[2.2.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/muhammadmobi/SolarLens/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/muhammadmobi/SolarLens/releases/tag/v1.0.0

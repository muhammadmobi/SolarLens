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

When a release is tagged, `version` in `package.json` is set to match it, so a
checkout of any tag says which release it is.

## [Unreleased]

### Added

- **Historical Data, one system at a time.** A switch at the top of the tab -
  *All systems*, or any one of them - narrows the charts, the tables, the row
  count and the CSV to the system chosen, so looking after one system no longer
  means scrolling past the other. All systems, one after the other, is still the
  default, and the choice is remembered in each browser; a remembered system
  that no longer exists falls back to all of them. A single system's CSV is
  named for it.
- **"A new version of SolarLens is available."** A dashboard tab refreshes its
  figures but never the page itself, so a tab left open across a release kept
  running the old one - which is how the 2.10 guide went unseen on a screen that
  had been open since before it. The page now asks for its own address, headers
  only, every quarter of an hour and on coming back to the tab, and compares the
  ETag with the one it loaded with; when they differ it offers a Reload. TV mode
  has nobody to press anything, so a wall display reloads itself. It costs one
  tiny request each time and nothing on the database.

### Changed

- **The code explains itself.** Every source file now opens with what it is for
  and how it fits with the others - the Worker's routes and cron, the database
  layer, each vendor's client, the relay agent, the scripts - and each function
  worth explaining has a summary above it. The dashboard's script opens with a
  map of its twenty sections, each marked so it can be found by searching. Test
  files say what they hold the code to, and the shared test helpers - SQLite
  behind D1, a Worker to send requests to, a stand-in push service and service
  worker - are explained where they are defined.
- **Every CI job says how to reproduce it.** Each job in the workflows now opens
  with what it proves and the command that runs the same check on your own
  machine, so a red cross comes with its next step. The two tsconfig files say
  what each type-checks and why there are two. Every test helper that builds
  data or fakes an API has a line saying what it stands for, and one helper
  nothing called is gone.
- **Debugging, written down.** The README gains *Debugging a failing test* - one
  test at a time, the browser visible, stepping through, and reading a trace -
  and *Debugging the live system*: the Worker's live log, /api/health, a query
  against production that reaches it in one piece, and watching a relay laptop
  work, since a hidden relay writes no log.
- **The documents match the code again.** Checked mechanically against it: the
  README's data model now has all eleven tables (it was missing alarms, vendor
  totals and relays), its end-to-end section describes all ten spec files rather
  than one, and its coverage table has real figures and a row for push; the
  handover used two wrong table names and missed a third, and its release steps
  now include the guide. Both now say that an open Copilot conversation blocks a
  merge, which one of them said it never did.

### Fixed

- **The page is no wider than a phone.** The tab bar could not shrink, and on a
  phone it made every page wider than the screen - "Devices" was cut off at the
  edge and "Historical Data" broke over two lines - while the overview's
  columns would not go below 430px. A page wider than the screen makes the
  browser zoom the whole layout out, which is how the new-version notice first
  landed below the bottom of a phone screen, where it could not be pressed.
  The tabs now scroll sideways in their own strip, one line each, and the
  overview's columns shrink to fit; a test walks every view at phone width and
  fails if any is wider than the screen.

## [2.10.0] — 2026-09-24

Phone notifications, SolarMan faults that say when they cleared, and a guide to
the whole app.

### Added

- **A guide, behind the ? at the top of every page.** What SolarLens is, what
  each tab holds, a "where do I find" table from everyday questions to the place
  that answers them, what is new in this release, and the few things worth
  knowing - that an on-grid system reads offline every night, that one relay
  laptop is enough, that a SolisCloud login lasts seven days. An icon rather than
  a tab, because a guide is read now and then and the tabs are used every day;
  it opens even before the data has loaded, and its version is held equal to
  the release by a test.

- **Notifications that reach a closed browser.** The Alerts tab gains *Also when
  this browser is closed*: turn it on once per device and that device is told,
  through its browser's own push service, when a system stops reporting while it
  was producing, when a fault is recorded, when a SolisCloud login is two days
  from running out or has run out, and when a vendor stops answering. Each rule
  is written for a phone rather than a screen - the on-grid system goes quiet
  every night because its inverter sleeps, so silence counts only after a reading
  that showed it generating. Each event is told once, and again only if it clears
  and returns.

  The push itself carries nothing: it wakes the device, whose service worker
  asks `/api/push/recent` what to show, so what a notification says never
  passes through the push services, and there is no payload encryption to get
  wrong. Signing a device up needs the key - from the `/auth` cookie or typed
  once and not kept - while turning a device off needs none. A device gets one
  message as soon as it signs up, and a *Send a test* button after that.

  Setting up is one command, `node scripts/make-vapid-key.mjs`, which makes the
  signing key and stores it as the Worker secret `VAPID_KEY` without printing or
  saving the private half. Migration 0013 adds the two tables.

- **SolarMan alarm detail.** SolarMan's alert list says when a fault was raised
  and nothing else. Its portal's detail panel makes two more calls - found in the
  portal's own code - and SolarLens now makes them too, for the newest five
  alerts each hour: the advice, where SolarMan has any, and the moments that day
  the fault was active. Each run of five-minute samples becomes one occurrence
  with an end, which also brings back the occurrences the list folds into one row
  per day. On the plant observed here, two stored alerts became four occurrences,
  each with an end. A run still going, or one that reaches midnight, is left
  without an end rather than given a guessed one.

### Fixed

- **The reading-offset backfill works against the real database.** Its first
  run against production answered "undefined" for every plant: with `--file`,
  a remote D1 database treats the statement as a bulk import and replies with
  import statistics rather than rows, while a local one replies with rows - so
  it passed every local test. Through the wrangler wrapper instead, a shell
  splits the statement at every space. The script now runs wrangler's own entry
  point with node, handing it the statement as one argument, and stops on rows
  of an unexpected shape rather than printing "undefined" and carrying on. Found
  on the dry run, before anything was written.
- The config step of `scripts/wrangler.mjs` is now `scripts/wrangler-config.mjs`,
  shared by the wrapper and the backfill, so the two cannot drift. The wrapper
  behaves exactly as before.

## [2.9.0] — 2026-09-20

Daylight saving handled properly, history as a file, a dashboard that can speak
up, and accessibility checked rather than assumed.

### Added

- **Download CSV, on the Historical Data tab.** The rows on screen - day, month
  or year - written out as a file, with the systems named, times in ISO, and a
  figure the vendor never reported left empty rather than written as zero. A
  value containing a comma is quoted the way every spreadsheet expects. Built in
  the page from what is already fetched, so it costs no database read and adds
  no route to guard.

- **"Tell me when something changes", on the Alerts tab.** The browser raises a
  notification when a new alert appears - a system going offline, a fault, a
  relay login about to expire - on whichever device has the dashboard open.
  Permission is asked for only when the switch is turned on. Turning it on
  records what is already wrong without announcing it: you turned it on to hear
  what happens next, not to be told the last week at once. A fault that clears
  and returns is announced again.

  Honest about what it is: the browser runs the page only while a tab holds it
  open, so this is a louder dashboard rather than a pager. Reaching a closed
  browser needs Web Push, which is written up in `docs/feature-gaps.md` rather
  than half-built here.

- **Accessibility is checked on every view**, desktop and mobile, with axe-core's
  WCAG 2 A and AA rules, failing the run on anything serious or critical - plus
  a keyboard walk-through and a check that every control shows its focus.

- **The dashboard's own script is measured.** V8 coverage during an end-to-end
  walk-through, written to `coverage/page-coverage.json` and attached to the
  run: **67.3%**, with a floor of 65% that fails the run if it drops. The figure
  moves as the page grows - it was 69.6% before this release added the export and
  notification code - so the floor is set below it rather than at it. Until now
  only the Worker's half of the project had a number.

### Fixed

- **Daylight saving no longer moves a day of history.** The plant's UTC offset
  was a number on the inverter row, refreshed on every poll, and every day of
  history was cut with whatever that number said *today*: a summer evening read
  back in winter landed in the wrong day, and for the five minutes around a
  switch the current day was cut wrong too.

  The zone's own name is stored now, where the vendor states one, and each
  reading carries the offset that was in force at its own timestamp - so a day
  keeps the boundary it was recorded under, whatever the clocks do afterwards. A
  plant whose vendor only ever sends a number still falls back to that number,
  which is the best that can be said for it. Migration 0012 adds both columns,
  and `scripts/backfill-reading-offsets.mjs` gives the readings already stored
  the offset they were taken under - a dry run first, which says how many rows
  it would touch before it touches any.

  Today's chart follows the same rule. It used to open at midnight computed
  from the offset in force *now*, so on the one morning a year the clocks go
  back there, the first hour of the day sat outside the window and off the
  picture, and a time printed beside a sample was an hour out. The day is now
  drawn between the instants it actually ran between - twenty-three or
  twenty-five hours where that is what it was - and every time beside a reading
  is the time that reading was taken.

- **Four accessibility faults, found by the new checks on their first run**:
  muted text at 2.93:1 against the page's own ground where 4.5 is the bar; the
  brand orange used for 16px type at 3.42:1; the *normal* and *warning* pills a
  shade under; and tables that scroll sideways with no way to reach them from a
  keyboard. The brand colours now have darker ink versions for type, while the
  charts keep the brighter ones.

## [2.8.0] — 2026-09-20

Coverage above 90% on every measure, branches included - and a bug found on the
way there.

### Fixed

- **A device record with no station id was stored under the plant id `"null"`**,
  the four-character string. `pick` answers `null` for a key that is missing,
  and the code tested its result against `undefined`, so the fallback was always
  taken. It never showed, because every caller passes the plant in - which is
  exactly the kind of wrong that only a test walking the arm can find.

### Changed

- **Coverage thresholds rise to 97% statements, 90% branches, 97% functions and
  99% lines**, from 95/82/95/97, and the suite measures 98.0 / 90.5 / 98.5 /
  99.4 over all of `src/`. 314 unit tests, up from 275.

  Branches came up by walking the arms rather than by lowering the bar: each
  fallback in the vendor normalisers was given a payload that takes it. Four new
  suites - `device-shapes`, `fallbacks`, `series-rules` and the earlier
  `sparse` - cover the shapes a device record arrives in, a Worker deployed
  without its ingest token, a curve nested inside `data`, an inverter that
  already knows its own name, the three ways a vendor states a timezone, a live
  sample beating a backfilled one for the same instant, and where a plant's day
  begins when the vendor never said where the plant is.

## [2.7.0] — 2026-09-19

The Worker's own routes, SQL and cron are tested for the first time, against a
real database.

### Added

- **A database to test against, in `tests/helpers/d1.ts`.** D1 is SQLite, and
  Node ships one: this puts `node:sqlite` behind the D1 interface, applies the
  project's own migrations to it, and rewrites D1's `?1` placeholders to the
  named form SQLite binds. The SQL a test exercises is therefore the SQL that
  runs in production, and the queries had never been run by any test before.
  It also refuses a bound value D1 would refuse, which turns a `D1_TYPE_ERROR`
  in production into a failing test - it caught one such call while being
  written.

- **The Worker itself, in `tests/helpers/worker.ts`**: its exported fetch and
  cron handlers, called with that database, a stub for the static-assets binding
  and whichever tokens the case is about. Five new suites use it:

  - `worker-routes.test.ts` - the security headers on an API response *and* on
    the page the asset binding serves; reads open and writes refused, including
    one token not opening the other's route; `/auth`'s cookie; every ingest
    route's contract and what each refuses; the identifiers proved absent from
    what is served; the cron entry point.
  - `worker-edges.test.ts` - the generic ingest route, a Worker deployed with no
    `API_TOKEN`, the poll log's trimming and its newest line per provider, the
    token store, and the hardware fan-out that fetches each inverter's own page.
  - `poll.test.ts` - which providers are built from which secrets, the
    `INCLUDE_PLANTS` filter, a provider that throws not costing the other one, a
    failing hardware list not costing the reading it came with, and the extras'
    hourly and daily schedules including the first run's walk back through the
    years until one comes back empty.
  - `readings.test.ts` - SolisCloud's inverter page, with the portal's export
    sign flipped to this project's "+ import"; SolarMan's per-device registers
    layered over its station snapshot, including a register present but empty,
    which must not be read as zero.
  - `sparse.test.ts` - what happens when a vendor sends almost nothing: nulls
    rather than zeros, an empty database answering every read, a device merged
    rather than overwritten by a thinner second view, and an id with no alias
    answered as `unknown` rather than echoed back.

### Changed

- **Coverage is measured over all of `src/` and enforced far higher.** One
  honest figure replaces two: 97.1% of statements, 84.7% of branches, 97.5% of
  functions and 99.3% of lines, against an enforced scope that used to leave out
  `index.ts`, `db.ts` and `poll.ts` because nothing could reach them. Thresholds
  rise from 80/63/80/80 to **95/82/95/97**. 275 unit tests, up from 189.

  Branches stay below the rest deliberately, and the README says why: the vendor
  payloads are long chains of optional fields and v8 counts every arm, so the
  last few points would mean a fixture per arm for figures already proved.

- The unit suite runs in forked processes with `--experimental-sqlite`, set in
  `vitest.config.ts` rather than in an environment variable, so `npx vitest`
  behaves the same as `npm test` on any shell. Node 24 and newer ignore the flag.

## [2.6.0] — 2026-09-19

Every change now has to pass twelve checks before it can merge, and reaching
the live dashboard takes one approval and proves itself afterwards.

### Added

- **Checks on every pull request**, in parallel, in about five minutes:
  type check, unit tests with coverage, end-to-end tests, and a build dry run
  that bundles the Worker without uploading it. None of them needs a secret, a
  Cloudflare account or a SolisCloud login, so a fork gets the same checks.
  All twelve are now required before anything can merge to `main`.

- **Four guards written for this project.** `check-privacy` refuses an
  identifier - the deployment address, an email that is neither a vendor's nor
  plainly fake, a database id, a coordinate, or a long number that could be a
  plant or station id - in any file, in **every commit of the pull request**,
  patch and message, and in the pull request's own description. A value added in
  one commit and removed in the next still lives in that pull request's ref for
  good, which is how this repository's identifiers escaped in the first place.
  Real values come from a masked secret, and a failure names the file, line and
  rule but never prints what it matched. `check-attribution` refuses a commit
  credited to anyone else. `check-headers` refuses drift between the security
  headers in the Worker and the copy the asset handler serves, which exist twice
  because Cloudflare serves `public/` without running the Worker.
  `check-cmd-shape` refuses a `.cmd` that is not the one shape that survives the
  update it runs.

- **A Windows job for the relay's own scripts**: every PowerShell file must
  parse, the analyser must find no errors, and the relay must refuse and exit
  when its settings are missing rather than hang. Every bug fixed in 2.5.0 was
  found by running those scripts by hand.

- **Vulnerability and secret scanning**, on every pull request, every push to
  `main`, and again each Monday, because an advisory can be published against
  code nobody has touched: CodeQL with the `security-extended` rules, dependency
  review, `npm audit`, gitleaks over the whole history, actionlint, and a check
  that every action names a commit rather than a movable tag. Downloaded tools
  are pinned to a version *and* a SHA-256.

- **Deployment, after an approval.** A merge deploys nothing by itself: the run
  starts only once the checks have passed on `main`, then waits on a protected
  environment until a person approves it. It then remembers the version serving,
  applies migrations, deploys, and **asks the live site whether it worked** -
  the page and its security policy, health and latest answering, a vendor feed
  that is current, no identifiers in the public responses, and the
  token-protected routes still refusing a caller without one. Any failure puts
  the previous version back automatically. The summary says when the relay
  computers need updating.

- **A release button.** It refuses unless `package.json`, the changelog section
  and its link reference all name the version and no such tag exists, scans the
  notes for identifiers, tags the commit and publishes. It pushes the tag by its
  full ref name, because a branch sharing a tag's name made that push fail by
  hand on 17 September.

### Changed

- **Dependencies are updated by hand, on purpose.** Automatic update pull
  requests were tried for a day and turned off; the config went with them. What
  protects the project is not a queue of pull requests but `npm audit` failing
  the build on an advisory in anything the Worker ships with, dependency review
  refusing one that arrives with a new package, and Dependabot alerts warning
  when an advisory is published against something already here.

- **Node 22 is pinned for the checks**, and the repository decides line endings
  rather than each machine: `.cmd`, `.ps1` and `.vbs` now arrive with Windows
  line endings on any checkout. They were stored with Unix endings and only
  became Windows ones through Git for Windows' own conversion setting, so a
  machine without it handed cmd.exe batch files it can misparse.

- **hono 4.13.8**, plus the tooling: Wrangler 4.135.0, workers-types,
  `@types/node`, Vitest and its coverage provider. Wrangler's update cleared the
  three high advisories that stood against the development dependencies;
  production had none.

### Fixed

- **A deploy could have lost the ability to undo itself, quietly.** The version
  to roll back to was read with a command substitution inside `echo`, which
  cannot fail: a failed lookup left it empty and the step went green. It is
  checked now, and a run that cannot roll back says so.

- Dependabot signs every commit it makes as `support@github.com`, which the
  privacy guard read as a leaked address and refused; GitHub's own domains are
  allowed now. The guard also read the digits inside a pinned commit hash as a
  possible plant id, and so failed on its own workflow file.

## [2.5.0] — 2026-09-17

Renewing and updating a relay now shows nothing when nothing needs doing.

### Changed

- **The login check runs hidden, and a window opens only when a login is
  needed.** Since 2.4.0, `renew-solis-login.cmd` and every re-run of the
  installer opened a visible Chrome window to check the saved SolisCloud login,
  even when it worked, which is most weeks. On a machine that needed nothing,
  a browser appearing and a terminal waiting looked like something going
  wrong. Both now check in a hidden browser first. When the login works, a
  reading goes through and nothing appears. When SolisCloud wants a login, a
  window opens for it and closes itself once a reading has been sent. The check
  also skips the alarm history and period totals, so it takes about twenty
  seconds instead of a minute; the background relay started straight afterwards
  reads them.
- **The `.cmd` windows close themselves when the run worked.**
  `renew-solis-login.cmd` and `setup-relay.cmd` used to end on "press any key",
  and a personalised `setup-solarlens-relay.cmd` waited twenty seconds. All three
  now close five seconds after success, and stay open only after a failure, so
  its reason can still be read.
- **The installer skips what is already in place.** Dependencies are installed
  only when `package-lock.json` changed since the last install, and a relay task
  someone disabled is left disabled rather than switched back on. Its `.dev.vars`
  now says `RELAY_HEADLESS=1` from the start.

### Added

- **The installer installs Google Chrome when it is missing**, with winget, as
  it already did for Node and Git. It used to warn and carry on, leaving a relay
  that could not start a browser.
- `RELAY_SKIP_EXTRAS=1`, and distinct exit codes for a single run
  (`RELAY_ONCE=1`): `0` a reading went through, `3` SolisCloud wants a login,
  `1` anything else.

### Fixed

- **A relay with no working login could report success.** It checked for the
  login page once, three seconds after opening the portal. Measured with no
  login at all, the portal stays on the plant page for about three seconds and
  moves to its login page between three and five, so the check could miss it.
  The cycle then sent no reading, logged the timeout as a per-plant error, and
  reported success, and a single run told the installer a reading was through.
  The relay now watches until the plant list loads or the login page appears,
  and a cycle that sends no reading counts as failed. A login lost part-way
  through a cycle is reported as a login to renew.
- **The background relay can no longer show a browser window.**
  `scripts\relay-hidden.vbs` forces `RELAY_HEADLESS=1` for the relay it starts.
  Before, it followed `.dev.vars`, where a `0` left by a login done by hand, or
  by an installer run that stopped part-way, put a Chrome window on screen at
  every logon.
- **A relay can no longer leave its browser open when it exits.** If Chrome
  does not close within fifteen seconds, the relay closes it the hard way.
- A relay attached to your own Chrome (`RELAY_CDP`) is no longer refused as
  having no saved session when run hidden.
- **`renew-solis-login.cmd` and `setup-relay.cmd` no longer trip over their own
  update.** Both run a script that pulls new code, and that can replace the
  `.cmd` file itself while it is still running. cmd reads a batch file a line at
  a time and carries on from the same byte offset in whatever the file now
  says: in a test, a file rewritten under a running batch went on to run half a
  line as a command. Each is now one parenthesised block, which cmd reads whole
  before running any of it. This protects updates from 2.5.0 on; the files in a
  2.4 checkout are still the old shape, so move a computer to 2.5.0 with
  `setup-solarlens-relay.cmd`, which lives outside the repository.

## [2.4.1] — 2026-09-17

### Fixed

- **Re-running the installer on a computer whose relay is already running no
  longer races that relay for its browser.** Since 2.4.0 a re-run checks the
  SolisCloud login in a visible window, but it opened that window while the
  hidden relay still held the same Chrome profile. Chrome lets one program use a
  profile at a time, so the new window killed the hidden relay's browser to get
  in, and the hidden relay could kill the new window's on its next cycle - in
  the middle of a login. The installer now stops the hidden relay, and the
  Chrome it drives, before the check, and starts it again afterwards, as
  `renew-solis-login.cmd` already did. A personalised `setup-solarlens-relay.cmd`
  made earlier picks the fix up by itself: it updates the code before it runs
  the installer.

## [2.4.0] — 2026-09-17

Warning before a relay's SolisCloud login runs out, and renewing it in one
double-click.

### Added

- **The dashboard warns before a relay's SolisCloud login expires.** A
  SolisCloud web login lasts exactly seven days, and using it does not extend it:
  a login made at 14:53 UTC carries a login cookie expiring at 14:53 UTC seven
  days later, however often the relay uses it in between. The login page carries
  hCaptcha, so a relay cannot renew its own login. Twice in one week that ended
  the same way - a hidden, headless relay failed every cycle where nobody could
  see it, and on the dashboard it looked exactly like the plant being down.

  Each relay now reads its login's expiry from the portal's own cookie and
  reports it, with whether its last cycle worked, after every cycle. The Alerts
  tab warns two days ahead and says plainly once a login has run out, naming the
  computer and the fix. When another relay still delivers, an expired login is a
  warning rather than an outage, and a relay silent for over a week - a computer
  that is off - raises nothing. The Devices tab lists every relay with its state,
  its login's expiry and its last report.

- **`renew-solis-login.cmd`: renewing a login is one double-click.** It stops the
  hidden relay, updates the code, runs the relay once in a visible window, and
  starts the hidden relay again. When the saved login still works it sends a
  reading without asking; when it has expired, the window waits for you to log
  in. A relay task disabled on purpose is left disabled.

- **`RELAY_NAME`** gives a relay a nickname for the dashboard, such as *Office
  laptop*. Without one, relays are *Relay 1*, *Relay 2*, in the order they first
  reported.

### Changed

- **Re-running the installer checks the saved login instead of skipping it.**
  `setup-relay.cmd` used to skip the login step whenever a saved browser session
  folder existed, even when the login inside it had expired, and restarted a
  relay that could not deliver. It now runs the relay once visibly either way:
  the window closes by itself when the login works and waits when it does not.

- **`GET /api/health` also lists SolisCloud relays** heard from in the last 14
  days, with their login expiry. `POST /api/ingest/relay` receives their reports,
  validated to a narrow shape. Migration 0011 adds the table.

### Security

- **A relay is never identified by its computer's name.** A Windows computer name
  often carries a company prefix and a person's user name, and the relay list is
  on a public page. Each relay makes a random id for itself, kept beside its
  browser profile; the Worker refuses anything else as an id, and the id never
  leaves the database. The nickname is cut down to letters, digits and a little
  punctuation before it is stored.

## [2.3.0] — 2026-09-16

Fault history, history back to installation, battery charge through the day,
and TV mode.

### Added

- **Fault history, with the vendor's advice.** The Alerts tab now carries, for
  each system, every alarm its vendor has on record, newest first: when it
  started, its severity, the fault code, what it was, how long it lasted, and
  SolisCloud's own advice. A summary names how many, since when, and which fault
  happens most. On the on-grid plant that is 63 alarms since July 2024, 55 of
  them the grid going down.

  Neither vendor's documented API exposes an owner's alarm history, so both are
  read from the portals' web APIs, recorded from live owner accounts. SolarMan's
  alert list is fetched by the Worker hourly. SolisCloud signs every request with
  a secret in its own JavaScript, so the relay reads it the only way that allows:
  it opens the plant's alarm page, sets the Status filter to Recovered, searches,
  and takes the portal's own response - every page on its first run, the newest
  page after that.

  A SolisCloud alarm record also carries the owner's address, phone number,
  email and region. Every one of those is dropped in the Worker before anything
  is stored, and a test proves it rather than assuming it. SolarMan never records
  when a fault cleared, so its alarms read "not recorded" rather than implying
  they are still going on. SolarMan's severities are partly inferred, and the
  vendor's own number is stored beside them for that reason.

- **Month and year history back to installation.** SolarLens's own record
  starts on the day it first polled, so its first month was a fraction and every
  earlier year was missing. The vendors counted all of it. Month and year views
  now use each vendor's own totals wherever one exists - SolisCloud's from the
  plant chart's Month, Year and Lifetime tabs via the relay, SolarMan's from its
  statistics endpoints via the Worker - and SolarLens's own record supplies only
  what the vendor does not report: the peak, and how many of the period's days
  it saw. A Source column says whose figure each row is. On real data the on-grid
  plant's months now run from February 2024, and its three year totals add to
  within 10 kWh of the vendor's lifetime counter.

  Totals are fetched daily. The first run walks back a year at a time until a
  year comes back empty; later runs read only the current year and month. Every
  total pushed through the relay is checked against the plant's nameplate before
  it is stored, since a unit error in a total is far harder to see in a bar chart
  than a refusal is in a log.

- **Battery charge through the day.** Every sample's state of charge was
  already stored and served by `/api/series`, and only the live figure was ever
  drawn, so "did it run flat overnight?" meant opening the vendor app. The
  battery card on the system page now carries the day's curve with its low and
  high. The axis is fixed at 0 to 100, because a pack moving from 94 to 100
  fitted edge to edge looks like one that went flat and came back. A gap of more
  than half an hour breaks the line rather than drawing a straight segment
  across hours nobody measured.

- **TV mode, for a screen on a wall.** At `#/tv`, or from the button beside the
  theme toggle. No header, tabs or footer: one panel per system with what it is
  producing now, today's energy, the battery where there is one and the day's
  curve, plus the fleet total and a clock. The clock is there because on a
  display nobody touches it is the only way to tell a live page from a frozen
  one at a glance.

  It fits the screen without scrolling, holds a screen wake lock so the display
  does not sleep, and refreshes every five minutes to match the vendors' own
  sample rate rather than the ten a browser tab uses. An offline system is
  greyed and shows no house or grid flow. Escape leaves, and so does an exit
  link that appears only while the mouse moves.

- **History by month and by year.** The Historical Data tab folds its daily
  rows into months or years. Energy sums, the peak is the highest peak, and a
  period with nothing metered stays blank rather than summing to zero. Month
  and year views ask for the API's full 400-day window.

  A rollup must not pass a partial period off as a whole one. The record starts
  on the day SolarLens began collecting, so every row says how many days it
  recorded out of how many the period has, and the current month and year are
  checked against the vendor's own counter, which saw the whole period. Where
  they differ, the page says by how much and why.

### Changed

- **Documentation brought up to date with the code.** `docs/api-notes.md` now
  records the endpoints this release reads: SolisCloud's alarm list and its
  month, year and lifetime charts, SolarMan's alert search and statistics, and
  where each vendor states a plant's timezone, including the owner fields a
  SolisCloud alarm carries and SolarLens drops. The README's troubleshooting
  table describes an expired relay login by what a person actually sees - Solis
  offline while the plant is producing - with the exact command to fix it, and
  its test list now covers all eleven unit test files. The installer's
  explanation of why it resets a checkout that cannot fast-forward names the
  usual cause: a branch that was later squash-merged.

- **`package.json` carries the release version.** It had said 0.1.0 since the
  first release; it now says 2.3.0, and the 2.2.0 entry below carries the date
  it was actually released rather than the date it was written.

- **Refresh schedules itself** rather than running on a fixed interval, so
  entering or leaving TV mode changes the cadence at once instead of after the
  old timer fires.

- **The relay does two more things each cycle, after the live reading.** It
  reads alarm history hourly and period totals daily. Both run last and neither
  can fail the cycle: a portal redesign that moves the alarm filter must not cost
  the reading the relay exists to deliver. Its first cycle after starting takes
  about a minute longer, because it reads everything once. **A machine running
  the relay needs its checkout updated to pick this up**; the installer's update
  path does that.

- **New routes.** `GET /api/alarms` and `GET /api/periods` are open reads.
  `POST /api/ingest/alarms` and `POST /api/ingest/periods` take the relay's raw
  SolisCloud payloads and normalise them in the Worker, so a script on a laptop
  never decides which fields are kept. Migration 0010 adds the two tables.

- **The capture script redacts emails by value, not only by key name.** A
  SolisCloud message record carried an account email under `contactWay`, a name
  no key list would think of. Existing captures were scrubbed the same way. It
  also accepts `CAPTURE_MINUTES` for a longer session, and `CAPTURE_CDP_PORT` so a
  second script can drive the window while it records, bound to 127.0.0.1.

### Fixed

- **The charge chart's first draft was unreadable in its card.** It used the
  shared chart class, which assumes a full-width panel: a drawing 1000 units
  wide squeezed into a 300-pixel card set its labels at about five pixels under
  a band of empty space. It is now drawn at the width of the card it sits in.

- **Caught before release: an alarm's internal id would have been public.** It
  is built from provider, plant, code and start time so that re-reading an alarm
  updates it, which means it spells out the vendor's plant id. Running the new
  routes against a local database with real portal payloads showed
  `/api/alarms` returning it. The id now stays in the database.

- **The relayed Solis plant now gets its timezone too.** 2.2.0 taught both
  vendor connectors to store a plant's UTC offset, but the relay posts the
  plant snapshot straight to the station ingest route, which never read it. The
  SolarMan plant had its offset within one poll of deploying 2.2.0; the Solis
  plant stayed on the reader's midnight until this.

- **The history chart's unit label no longer sits on top of its highest axis
  value**, where "kWh per year" and "18.4k" printed over each other. This
  predates 2.3.

## [2.2.0] — 2026-09-16

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

- **An offline inverter's strings no longer read as producing.** Solis went
  offline at dusk and the header said so, while the overview tile and the
  Devices table both said its strings were producing. The offline handling
  zeroes an inverter's own live figures, but per-string readings live on the
  device record, which keeps the last values the inverter sent - a few watts
  on each input, at dusk - and is not touched again until it comes back.

  The Devices table had a fault of its own: it printed the number of string
  entries followed by "producing" without reading a wattage, so every string
  on every inverter read as live. And the overview counted an empty MPPT socket
  as a string, so a hybrid with one array on a two-input inverter read "1 of
  2", which looks like a failed string that does not exist.

  One rule now answers all three views: count only connected strings, and say
  "offline" rather than any count for an inverter that is offline, by its
  device record or by the age of its own sample. The system page keeps the
  bars and labels them as the last reported. Against live data, Solis went
  from "2 producing" to "offline" and the hybrid from "1 of 2" and "2
  producing" to "1 producing" in both places.

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

[2.10.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.9.0...v2.10.0
[2.9.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.8.0...v2.9.0
[2.8.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.7.0...v2.8.0
[2.7.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.4.1...v2.5.0
[2.4.1]: https://github.com/muhammadmobi/SolarLens/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/muhammadmobi/SolarLens/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/muhammadmobi/SolarLens/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/muhammadmobi/SolarLens/releases/tag/v1.0.0

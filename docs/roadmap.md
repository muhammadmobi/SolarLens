# Roadmap to 3.0

The plan for SolarLens 3.0, agreed in September 2026. Everything below lands on
one branch, `roadmap`, as one pull request, and ships as one release: **3.0.0**.
It is a major version because of the login: until 2.x anyone with the link could
read the dashboard, and from 3.0 the owner can make it private. It stays open,
as before, until the owner turns on "Require sign-in to view" in Settings, so
nothing locks by surprise on the day it ships; from then on the owner signs in,
and anyone else sees it only through a view-only share link the owner chooses
to make, and can take back.

## How the work is done

- **One commit per phase**, pushed as soon as the phase is finished, so Copilot
  reviews each phase while it is small. Every suggestion is fixed, replied to
  and resolved before the next phase starts.
- **Every commit is whole.** The tests pass, coverage stays at or above its
  floors, the privacy guard is clean and the docs are updated in the same
  commit. A half-done phase is never pushed.
- **Database changes only add.** Each migration adds tables or columns and never
  drops or renames one, so rolling the Worker back to 2.10 still runs against
  the 3.0 database.
- **The login is built behind a switch** and turned on last, so it can be tried
  against the live site before it locks anything.
- **The pull request is merged with "Rebase and merge"**, so `main` keeps one
  commit per phase and any one phase can be found and reverted on its own.
- **Nothing identifying is written down**: no plant or station ids, serials,
  coordinates, database id, account emails or deployment address, in code,
  tests, fixtures or docs. Coordinates live only in the database, and are only
  ever served to the signed-in owner.

## The phases

### 1. Gap 5, and test data that cannot drift

The dashboard reads each vendor's raw payload, which the public view has never
sent, so three things never appear on the live site: the Raw telemetry table,
the alerts built from the payload's own fields, and a device's own alert count
(`docs/feature-gaps.md`, gap 5).

- The Worker sends the fields those alerts need as named columns.
- The Raw telemetry table gets an allow-list of fields that are safe to show:
  measurements, never ids, serials, addresses or coordinates.
- The dashboard's test data is held to the real Worker
  (`tests/unit/fixture-contract.test.ts`). It runs the Worker on the vendor
  fixtures and compares field names row by row, in both directions: a fixture
  row may not carry a field the Worker does not send, and may not lack one it
  does. So a field the Worker stops sending fails the tests rather than
  disappearing quietly from both sides.
- Explicit assertions pin each field the alerts and the telemetry table read
  (`tests/unit/public-view.test.ts` and the same contract test), so dropping
  one from the Worker fails by name.

### 2. Everything the datalogger reports

No remote control. Everything each datalogger reports is captured and shown:
signal strength and its history, online and offline history, model, firmware,
upload interval and last contact. Network details (addresses, network names)
are shown only to the signed-in owner.

### 3. Owner login that never asks twice

- Sign in once per device, with a **passkey** (fingerprint or face) and a
  **password** as the fallback.
- Two cookies, both HttpOnly, Secure and SameSite: a **short session** of about
  an hour, and a **refresh token** good for a year and renewed every time the
  app is opened. The session renews itself in the background, so a device that
  opens SolarLens at least once a year never sees the sign-in page again.
- The refresh token **rotates** on every renewal. An old one used again means it
  was copied, and signs that device out. Tokens are stored only as hashes.
- **Settings → Devices** lists every signed-in device, with sign-out for one or
  for all of them. An optional **view-only share link** gives read access to
  someone else.
- **What keeps working without a sign-in:** the relay laptops (their own key),
  phone notifications (a device's push address stands on its own), and the
  public demo in phase 5. The TV signs in once, like any other device.
- A limit on failed attempts, then a lockout.

**As built:** the switch lives in Settings ("Require sign-in to view") rather
than in the Worker's configuration, so turning privacy on needs no deploy and
cannot be turned on before a way to sign in exists. The first way in is the
setup code - `API_TOKEN` - which also resets a forgotten password. The session
is signed with a key derived from `API_TOKEN` and the password is keyed with
one, so a copy of the database signs nobody in; the cost is that replacing
`API_TOKEN` means setting the password again (devices and passkeys are
unaffected). The password gets 10,000 PBKDF2 rounds rather than the hundreds of
thousands a password stored alone would want: a Worker on the free plan has
about 10 ms of CPU per request, and the key the hash is keyed with, together
with the lockout, is what protects it. `/api/status` stays open for monitoring.

### 4. Any number of inverters

A colour per system, used everywhere it appears. The Overview becomes a summary
strip plus a card per system, and a Compare view sets systems side by side,
including kWh per kWp. Wording no longer assumes two systems. TV mode rotates
through them. Polling is spread across the five-minute cron runs as the list
grows, and a SolarMan station with more than one inverter shows each of them.

### 5. A showcase on GitHub Pages

A demo of the real dashboard running on sample data, with screenshots taken
automatically by the test suite and a gallery in the README. Once the live site
needs a sign-in, this is the public face of the project.

### 6. The CI/CD gaps, without a staging server

- Integration tests against a real local Worker (`wrangler dev`), not only the
  in-memory harness.
- A database restore point (a D1 Time Travel bookmark) taken before every
  migration is applied to production.
- A production watcher that opens a GitHub issue when a feed goes quiet or the
  health check fails.
- Copilot's review as a required check.
- Screenshot comparison tests, and Lighthouse checks for speed and
  accessibility.
- The owner's own pull requests approved automatically once every check is
  green.

### 7. Weather, expected output, and the site map

- Weather and irradiance from Open-Meteo, at the coordinates each vendor
  reports. The coordinates are stored only in the database.
- Expected output against actual, an underperformance alert, and battery health
  over time.
- **A site map** of the systems, for the signed-in owner only. Now that the
  dashboard needs a sign-in, showing where the systems are no longer publishes
  it.

### 8. Money and carbon

A Settings page for the tariff and net metering, filled in by the owner when
ready. From it: savings per day, month and year, and the CO₂ avoided.

### 9. New views

A power analysis view (hour by hour, load against generation, peaks), and
favourites and grouping for the systems list.

### 10. Outside the app

Webhooks to ntfy, Telegram or Discord, a weekly summary, and a Home Assistant
integration. No email.

### 11. Ask SolarLens, and agents, on Workers AI

- **Ask SolarLens**: a question box in the app. "Which month produced the most
  this year?", "How much did I export last week?", "Compare all my systems per
  kWp in August." The model only chooses which read-only query to run; **the
  Worker computes the numbers**, and the model puts them in words. Every answer
  shows the figures and the period it used, and says how fresh the data was. A
  daily cap keeps it inside the free allowance.
- **Agents**: a weekly report, "why was this day low?", and a health agent that
  watches for slow decline.
- All of them share one layer of read-only tools.

### 12. An MCP server

The same read-only tools, offered at `/mcp` so AI apps outside SolarLens can ask
the same questions. It runs inside the SolarLens Worker on Cloudflare, so it is
available whether the laptops are on or off; with the relays off, SolisCloud
figures simply stop at the last reading. It is protected by OAuth tied to the
owner's login: an app is approved once, and stays connected.

## Order

- **1 first**: its fixture contract keeps the test data honest for every later phase.
- **3 before 5**: the demo becomes the public face once the login is on.
- **3 before 7**: the site map is shown only behind the login.
- **11 before 12**: the MCP server reuses the tools Ask SolarLens builds.

## Left out, on purpose

- **Staging.** One owner, one deployment; phase 6 covers what staging would.
- **Email alerts**, and Cloudflare account setup from inside the app.
- **Remote control** of the inverters or dataloggers.

## Upgrading from 2.x

To be written with the release: sign in once on each device, including the TV;
the relays need no change; phone notifications carry on.

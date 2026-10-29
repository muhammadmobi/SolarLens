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

**As built:** Copilot's review is required through the approval: nothing is
approved until Copilot has reviewed the newest commit and every thread is
resolved, which the ruleset already enforces for merging. The screenshot
pictures are recorded on Linux in CI, where the comparison runs, since fonts
render differently elsewhere. Three things need turning on once in GitHub's
settings: Pages (source: GitHub Actions), "Allow GitHub Actions to create and
approve pull requests", and a `SOLARLENS_URL` repository secret for the watcher.

### 7. Weather, expected output, and the site map

- Weather and irradiance from Open-Meteo, at the coordinates each vendor
  reports. The coordinates are stored only in the database.
- Expected output against actual, an underperformance alert, and battery health
  over time.
- **A site map** of the systems, for the signed-in owner only. Now that the
  dashboard needs a sign-in, showing where the systems are no longer publishes
  it.

**As built:** the performance ratio is learned per system from its own recent
sunny, fully-recorded days, not assumed, and the alert fires below 60% of what
the sunlight allowed. Battery health is an estimate of usable capacity from
each day's charge and swing, since neither vendor reports a hybrid's state of
health here. The map is owner-only whatever the privacy switch says - a share
link does not get it - and its tiles see only this site's origin.

### 8. Money and carbon

A Settings page for the tariff and net metering, filled in by the owner when
ready. From it: savings per day, month and year, and the CO₂ avoided.

**As built:** the tariff is a card in Settings rather than a page of its own,
beside the sign-in settings it belongs with. The Worker keeps and checks the
numbers; the page does the sums from figures it already has, so no new history
query was needed. A kWh used at home is worth one bought, one exported earns
the export price (or the import price, with net metering), and a period whose
export the vendor does not report is marked as an upper bound rather than
guessed. With no tariff set, no money is shown anywhere.

### 9. New views

A power analysis view (hour by hour, load against generation, peaks), and
favourites and grouping for the systems list.

**As built:** the Analysis tab covers any of the last seven days, one system
or all, from the samples the Worker already keeps - `/api/series` gained each
sample's house load, and nothing else changed on the server. Energy is the
mean of neighbouring samples times the gap, and a gap over twenty minutes is
not bridged. Favourites are the reader's, kept in the browser; groups are the
owner's, kept by the Worker against real ids, since an alias is a position in a
sorted list and a system added later could move it.

### 10. Outside the app

Webhooks to ntfy, Telegram or Discord, a weekly summary, and a Home Assistant
integration. No email.

**As built:** four kinds of place - ntfy, Telegram, Discord, and any webhook,
which is also how alerts reach Home Assistant - at most five, set up in
Settings. They get the same events as Web Push through the same told-once
state, so a channel is just another listener. Their secrets are encrypted with
a key derived from `API_TOKEN` rather than kept as Worker secrets, so the owner
can add one from a phone; the price is that rotating `API_TOKEN` means adding
them again. The weekly summary goes Monday 08:00 on the first system's clock.
Home Assistant reads `/api/sensors` with its REST integration; on a private
dashboard it uses a share link as a bearer token, rather than `API_TOKEN`,
which could write and could not be taken back.

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

**As built:** six tools in `src/tools.ts` - status now, energy, systems compared,
faults, a day explained, the performance trend - served as they are at
`/api/tools`, so phase 12 has them ready. The model (Llama 3.3 70B by default)
chooses a tool and words its result; a sentence with a number the figures do
not hold is replaced by the tool's own, and every answer shows its figures. A
daily cap of model calls, every feature together, keeps inside the free
allowance. The health check is the figures alone, never the model: it flags a
fall of 8% or more in output for the sunlight, and the flag is an alert told
once. The weekly report is the one agent the model writes, held to its figures.
"Why was this day low?" is the day_report tool, from a button on Historical
Data, and works without a model. Asking needs a sign-in, since it spends the
day's calls; the rest is for every reader.

### 12. An MCP server

The same read-only tools, offered at `/mcp` so AI apps outside SolarLens can ask
the same questions. It runs inside the SolarLens Worker on Cloudflare, so it is
available whether the laptops are on or off; with the relays off, SolisCloud
figures simply stop at the last reading. It is protected by OAuth tied to the
owner's login: an app is approved once, and stays connected.

**As built:** the six tools of `src/tools.ts`, unchanged, over MCP's Streamable
HTTP in its simplest form - JSON answers, no event stream, no session - so the
Worker stays stateless. SolarLens is its own authorization server: the MCP
spec's discovery documents, dynamic registration of public clients, PKCE with
S256, and an approval page the Worker draws, which only the owner signed in on
that browser can answer - not a share link, not `API_TOKEN`. Refresh tokens
rotate and last a year from their last use; a copied one, or a code used twice,
disconnects the app. Settings lists the apps connected and disconnects one at a
tap.

### 13. The assistant

Ask SolarLens grown into an assistant: a conversation, not one question at a
time. Ask anything about the systems and follow up; ask for statistics or a
report and download it; ask how to do something in the app. The model can run
on Workers AI, on any server that speaks OpenAI's API - the owner's own
included - or not at all, and apps outside SolarLens can hold the conversation
themselves through the MCP server.

**As built:** `src/assistant.ts` behind `POST /api/chat`. The model is shown
the last few turns and chooses up to three tool calls - "compare this month with
last" is two - or replies in a sentence with no figure for a greeting; a
follow-up takes the calls of the answer before and changes only what it
changes. Without a model, `guessCalls` reads the message itself: its kind from
its words, a period (a named one, a month by name, a date, a year), a system,
and a follow-up moved to another period, the one before or another system. The
wording is held to every figure of every call, a report to 220 words or so.
Three new tools: `stats` (whole days only), `report` (energy, systems
compared, statistics, faults and health, each as its own part, with headline
figures) and `app_help`, from entries written into `src/help.ts` rather than
anything a model knows. `AI_BASE_URL` points the same calls at any server
speaking OpenAI's chat completions - https, or the same computer - with
`AI_API_KEY` as its key; the daily cap covers it too. Anyone who may read may
ask; only someone signed in spends a model call. The conversation lives in the
browser tab, which sends the last four exchanges with each message; an answer
downloads as a page with no script, every value escaped, that prints to a PDF.
`/api/ask` stays, as the one-question door and for "Why?". The MCP server gets
the new tools, and a report's parts as text. Tried on the owner's real data
before release, it gained two more: `power_day` for part of a day and how
steady the power was, and `outages` for since when a system has been quiet and
when it last made power - with a reader that takes times of day, a system by
one word of its name, and typing slips in the words it routes on. Then a
spread of everyday questions, asked of the same data, filled the gaps left: a
`battery` tool, the money saved and the share used at home, days above an
amount, an inverter's temperature, why a system went quiet - its datalogger,
or the relay and its login - and a plain "no forecast" for tomorrow. Asked for
graphs of any time and anything the inverter shows, it gained two more: `chart`,
any measure a reading records over up to three months - summed in the
database, so the Worker's share stays small - with a second beside it, or the
average day hour by hour; and `inverter`, the latest device record read out -
strings, phases, frequency, the battery's own readings - with a weak string
named. The page draws a chart answer as lines, and keeps it in a download.
Those graphs showed SolarMan's charging stored as discharging since 2.x: the
normaliser was put right, and migration 0021 turns the stored readings round.

## Order

- **1 first**: its fixture contract keeps the test data honest for every later phase.
- **3 before 5**: the demo becomes the public face once the login is on.
- **3 before 7**: the site map is shown only behind the login.
- **11 before 12**: the MCP server reuses the tools Ask SolarLens builds.
- **11 and 12 before 13**: the assistant grows out of Ask SolarLens, and its new
  tools reach apps through the MCP server with no change there.

## Left out, on purpose

- **Staging.** One owner, one deployment; phase 6 covers what staging would.
- **Email alerts**, and Cloudflare account setup from inside the app.
- **Remote control** of the inverters or dataloggers.

## Upgrading from 2.x

To be written with the release: sign in once on each device, including the TV;
the relays need no change; phone notifications carry on.

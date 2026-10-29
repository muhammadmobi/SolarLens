# Handover

Everything needed to run, change and repair SolarLens, written for someone
starting cold - a person, or an assistant opening this repository for the first
time with no memory of it. `README.md` explains how the code works in detail;
this explains the *system*: how the pieces fit, what only a person can do, what
has already gone wrong, and the rules that are not obvious from the code.

**It contains no secrets, addresses or identifiers.** Where a value is needed,
it says which file or secret holds it. That is deliberate: this file is public,
like the rest of the repository.

## Contents

1. [Start here](#1-start-here) - and [where things stand](#where-things-stand)
2. [What SolarLens is](#2-what-solarlens-is)
3. [How data flows](#3-how-data-flows)
4. [The code, file by file](#4-the-code-file-by-file)
5. [The data model](#5-the-data-model)
6. [The dashboard](#6-the-dashboard)
7. [The relay, and the weekly login](#7-the-relay-and-the-weekly-login)
8. [Privacy: what is public and what is stripped](#8-privacy-what-is-public-and-what-is-stripped)
9. [Credentials: where each lives](#9-credentials-where-each-lives)
10. [How a change reaches production](#10-how-a-change-reaches-production)
11. [Operating it](#11-operating-it)
12. [House rules](#12-house-rules)
13. [What has already gone wrong](#13-what-has-already-gone-wrong)
14. [What is still missing](#14-what-is-still-missing)
15. [Glossary](#15-glossary)
16. [Rebuilding from nothing](#16-rebuilding-from-nothing)

---

## 1. Start here

**First hour, in order:**

```bash
git clone https://github.com/muhammadmobi/SolarLens
cd SolarLens
npm ci
npm run typecheck             # types for src/ and tests/
npm run test:unit             # ~900 tests, under a minute
npm run test:unit:coverage    # the same, with the coverage thresholds applied
npm run test:e2e              # ~600 tests, a few minutes, needs Chrome
```

All of that runs with no Cloudflare account, no database and no vendor
credentials: the end-to-end suite serves the real dashboard from a static
server and stubs every `/api/*` route with fixtures.

Then read, in this order: section 3 below (how data flows), `README.md`'s
*How it works*, and `docs/api-notes.md` if you are touching anything that
parses a vendor payload.

**If you are an assistant picking this up**, four things will save you from the
mistakes already made here:

- **Never write an identifier into the repository** - plant or station ids,
  coordinates, account emails, the database id, the deployment's hostname.
  A guard fails the build over it, and a pull request's commits cannot be
  rewritten afterwards. Section 8 and 12 explain.
- **Verify against the running system rather than reasoning about it.** Every
  expensive mistake in section 13 was found by measuring; most were introduced
  by assuming.
- **Match the prose style of the comments already there.** Comments explain
  *why*, in sentences, and cite the measurement or the incident behind a
  decision. A change that reads like it was written by a different hand is a
  change that will be reverted.
- **Keep the documents current in the same change.** `README.md`, this file,
  `CHANGELOG.md`, `docs/feature-gaps.md` and the guides in `docs/` are part of
  the deliverable.

### Where things stand

- **Live:** 3.0.0, released on 29 October 2026 and deployed from `main` -
  every phase of `docs/roadmap.md`, 1 to 14, the review before release
  included. What changed, and how to bring a copy of 2.x up to it:
  `CHANGELOG.md` and the README's *Upgrading from 2.x*.

**Once, on the live site:** sign in with the setup code, set a password, add a
passkey on each phone and computer, and decide on *Require sign-in to view*.

**Decisions left to the owner:** which Cloudflare plan this runs on (everything
is held to the free plan's limits); *Require sign-in to view*, which also keeps
strangers from spending the database's daily reads; the optional rate limit
(`ratelimits` in `wrangler.jsonc`); `DB_WARN_MB` on a paid plan; the
repository's About box - a description, topics, and the demo's address as its
website; and the local branches already merged, which can go.

**Every week:** renew a SolisCloud login when the dashboard says (section 7).

**Next:** the items left on purpose in section 14.

Rewrite this part whenever it stops being true: it is the one place in this
file that describes a moment rather than the system.

## 2. What SolarLens is

Solar systems on two vendor clouds, on one page. It takes any number of
systems; the deployment it was built for has two:

- **An on-grid system** on SolisCloud (Ginlong), with no battery.
- **A hybrid system with a battery** on SolarMan.

A Cloudflare Worker collects readings every five minutes into a D1 database and
serves a dashboard - live power, today's and lifetime energy, battery state,
per-string DC, per-phase AC, fault history, daily and monthly totals - open to
anyone with its address until the owner makes it private. Around it, since
3.0: the weather and what each system should have made, money and CO₂ by the
owner's tariff, an Analysis tab, alerts on phones and on ntfy, Telegram,
Discord or a webhook with a summary every Monday, Home Assistant, an assistant
that answers questions from the figures, weekly agents that check each
system's health and write the week up, and an MCP server for AI apps the owner
approves.

Readings reach it two different ways, and that difference shapes everything:

- **SolarMan** answers HTTP requests from the Worker itself. Cloud to cloud, no
  local machine involved.
- **SolisCloud** signs every portal request inside its own JavaScript, so a
  copied token cannot be replayed. A **relay agent** drives a real logged-in
  Chrome on a Windows laptop and pushes what the portal returns. That laptop is
  the only part of the system that needs a person - and only once a week.

## 3. How data flows

**Every five minutes, the Worker's cron:**

```
cron → poll.ts → provider.fetch()  →  normalise → insertReading() → D1
                  ├─ SolarMan: HTTPS from the Worker
                  └─ SolisCloud: nothing - see the relay path below
     → push.ts announce(): is anything worth telling the phones and channels?
```

**Once an hour, at seven minutes past, the second cron** (`src/cron.ts`): the
week's agents when they are due - and in that hour nothing else - or else the
weekly summary when due, the weather, and the housekeeping (old messages, link
history and kv entries forgotten, a day of old readings' vendor payload
cleared, alert channels moved over to `SECRET_KEY`). Each step on its own: one
that fails is logged and the next runs. They were on the five-minute run until
the review before 3.0 counted what a Monday cost - some ninety-five D1 queries
in one invocation, where the free plan allows fifty.

**The relay, on its own five-minute cycle:**

```
Chrome (logged in, real portal pages)
  → agent/solis-relay.mjs reads the portal's own responses
  → POST /api/ingest/station | /history | /devices | /alarms | /periods | /relay
  → the Worker normalises with the same code the cloud path uses
  → D1
```

Both paths end in the same normaliser, on purpose: a field mapping or a sign
convention can never drift between "the vendor's cloud said it" and "the relay
saw it".

**A browser opening the dashboard:**

```
GET /                → static HTML, CSS and JS from public/, served by Cloudflare
GET /api/latest      → newest reading per inverter, identifiers stripped
GET /api/series      → power over a window, for the chart
GET /api/health      → poll log, newest line per feed, relay list
```

Reads are open until the owner turns on *Require sign-in to view* in Settings;
then they need the owner or a share link (`src/auth/`). Writes need the owner -
`/api/poll` because it spends vendor quota - and `/api/ingest/*` needs
`INGEST_TOKEN`, which the relays carry; a Worker with no `API_TOKEN` refuses
every write. `/api/status` (feed freshness and the database's size) stays open
for monitoring. A caller not signed in is held to a year a question, and to a
rate per address when the `RATE_LIMIT` binding is set.
`tests/unit/access.test.ts` holds every write route to its guard.

## 4. The code, file by file

| File | What it owns |
|---|---|
| `src/index.ts` | Every route, the auth middleware, the security headers, the scheduled handler that tells the two crons apart. Hono. |
| `src/cron.ts` | The two crons' expressions, and the hourly run: its steps, and what waits in the hour the agents run. |
| `src/db.ts` | Most of the SQL: upserts, the latest-per-inverter query, series, daily rollups, a day curve stored in batches (`insertHistory`), the poll log, alarms, period totals, relays, the housekeeping (`forgetOldRaw`, `forgetExpiredKv`), the database's size (`dbBytes`), and the vendors' token store, sealed under `SECRET_KEY`. The newer modules keep their own tables' SQL beside them. |
| `src/poll.ts` | The cron fan-out: which providers to call, in what order, what to do when one fails, and - past four plants a vendor - which share of them this run reads (`plantsThisRun`). |
| `src/auth/sessions.ts` | Who is asking: the signed session, the silent refresh and its rotation, signed-in devices, share links, the lockout (the setup code held to its caller's own), and the passkey sign-in challenges, signed rather than stored and spent once. Its header explains the design. |
| `src/auth/routes.ts` | The sign-in routes under `/auth`, Settings, and share links at `/s/`. A password keyed before `SECRET_KEY` was set is moved over the next time it signs in (`passwordMatches`). |
| `src/auth/webauthn.ts` | Passkeys: the CBOR, the keys and the two ceremonies, verified with WebCrypto. A passkey must be unlocked - a fingerprint, a face or the PIN - not only touched. |
| `src/auth/crypto.ts` | Tokens, hashes, HMAC, sealing and the password, all WebCrypto - and the key secret every key comes from: `keySecret` (`SECRET_KEY`, else `API_TOKEN`), with `previousKeySecret` for what was keyed with `API_TOKEN` before `SECRET_KEY` was set. |
| `src/weather.ts` | Each system's position (from the vendor's plant record, owner-only) and its hourly weather from Open-Meteo, fetched by the hourly cron: once per position however many systems share it, and at most `PLACES_PER_RUN` positions a run, so the run's queries and fetches stay bounded. |
| `src/settings.ts` | The owner's settings in `app_settings`: the tariff and the systems' groups, each checked (`parseTariff`, `parseGroups`) before it is kept. Groups are stored by real id and served by alias. The page does the money sums (`valueOf` in `public/index.html`). |
| `src/expected.ts` | What each system should make of its sun: its performance ratio learned from its recent sunny days, and today's expected output. |
| `src/public-view.ts` | **The one file deciding what leaves the Worker.** Aliases ids, masks serials, and sends the raw payload only as its alert fields and a cleaned `telemetry` copy. |
| `src/relays.ts` | Validates a relay's report on itself into a narrow shape. |
| `src/channels.ts` | Alerts elsewhere: ntfy, Telegram, Discord and webhooks. What the owner types, checked; the secret sealed with a key derived from the key secret (`SECRET_KEY`, or `API_TOKEN` without one) and moved over when `SECRET_KEY` is set (`resealChannels`); the request each service expects; delivery and its record. A channel taking alerts is one more listener to `announce()` in `src/push.ts`. |
| `src/summary.ts` | The weekly summary: the last seven days from the daily rows, the tariff and the alarms, in words, and `sendWeekly` - Monday 08:00 on the first system's clock, waiting up to three hours for the week's report (`REPORT_WAIT_S`), claimed in one conditional write so it goes once. |
| `src/tools.ts` | The read-only tools every question goes through - the assistant, the agents, and the MCP server: status now, outages, what the inverter shows, energy, a day's power, a chart of any measure, the battery, systems compared, statistics, faults, a day explained, the performance trend, an analysis (every finding with what to do, from one read of each kind of record), any figure the records hold (`figures`: a measure, how, by what, above or below an amount), a full report, and help with the app and its words. Arguments checked before anything runs; every figure computed and labelled here. `DEFAULT_RANGE` is the period each covers when none is named; a caller not signed in is held to `ANONYMOUS_DAYS`. |
| `src/ai.ts` | The one place that talks to a model: Workers AI, or any server speaking OpenAI's chat API when `AI_BASE_URL` is set (https, or the same computer); the daily cap (per UTC day, in kv); JSON replies. |
| `src/assistant.ts` | The assistant behind `/api/chat`: a conversation understood (by the model, up to three tool calls, or by `guessCalls` reading the words itself), computed by the tools, and worded - held to every figure by `numbersAgree`. Follow-ups move the calls of the answer before. The conversation is the browser's; the Worker keeps none of it. |
| `src/help.ts` | What the assistant knows about using SolarLens: an entry per feature - the words a question uses, the answer, the tab - and a glossary of the words the figures use (`term: true`), preferred when a question asks what a word means. **Keep it in step with the page**: when a feature moves, its entry moves with it. |
| `src/ask.ts` | One question at a time (`/api/ask`), and a tool asked for directly ("Why?" on Historical Data): a thin door onto the assistant. |
| `src/mcp.ts` | The MCP server at `/mcp`: JSON-RPC over Streamable HTTP, answering `initialize`, `ping`, `tools/list` and `tools/call` from `src/tools.ts`. Stateless: no event stream, no session. |
| `src/oauth.ts` | OAuth for the MCP server: discovery documents, dynamic registration, the approval page (drawn here, not in `public/`), codes, rotating tokens, revocation, and the connected apps for Settings. A registration nobody approves is cleared after an hour (`STALE_CLIENT_S`). |
| `src/agents.ts` | The weekly health check (flags a system slowly making less; the alert is in `src/push.ts`) and the weekly report, run once a week from the hourly cron, marked done only once both are written; a failed run is tried again the next hour, `MAX_TRIES` times in all. |
| `src/sensors.ts` | `/api/sensors`, what Home Assistant reads: flat, fixed units, the page's own offline rule. |
| `src/push.ts` | Phone notifications (Web Push): signing with `VAPID_KEY`, who is signed up, what is worth announcing, and the told-once state. Each wake gives up after ten seconds. |
| `src/providers/types.ts` | The `Provider` interface every adapter implements, plus shared shapes. |
| `src/providers/soliscloud.ts` | SolisCloud's official API adapter (dormant until an API key exists) and the relay payload normaliser. |
| `src/providers/solarman.ts` | SolarMan's Business API adapter and its normaliser; the plant list read page by page. |
| `src/providers/solarman-web.ts` | The browser-session fallback used today, refresh-token based. |
| `src/providers/events.ts` | Alarms and vendor period totals from both vendors, into one shape. |
| `src/providers/units.ts` | W / kWh / timestamp / timezone scaling, and where a plant is (`locationOf`). Small, and the source of the worst bug in section 13. |
| `src/providers/queue.ts` | A call queue holding 1.5-2s between vendor calls, and `CALL_TIMEOUT_MS`, the 20 seconds every vendor call gives up after. |
| `agent/solis-relay.mjs` | The relay: drives Chrome, waits for the portal's own responses, pushes. |
| `agent/solis-extras.mjs` | Its slower reads - alarm history, period totals. |
| `agent/relay-status.mjs` | Login expiry from the portal cookie, the relay's random id, its nickname. |
| `public/index.html` | The whole dashboard - markup, styles and script in one file, no build step. The script opens with a map of its sections; search for `---------- <name>` to jump to one. |
| `public/sw.js` | The service worker: network-first for the installable app, keeping only the page and its icons for offline - never an `/api` or `/auth` answer - and what a push shows. |
| `demo/demo.js` | The demo's made-up data, answering every `/api` and `/auth` request in the visitor's browser; held to the real Worker's answers by `tests/unit/fixture-contract.test.ts`. |
| `migrations/` | The schema, 0001 to 0022, applied in order - section 5. |
| `scripts/` | Operational tooling: the wrangler wrapper (it runs wrangler's own entry with Node, every argument whole) and its shared config step (`wrangler-config.mjs`), the relay installer, login renewal, token rotation, the local seed (`seed-local.mjs`, through the wrapper's config), the README's pictures (`screenshots.mjs`, of the demo), the capture tool, the push key (`make-vapid-key.mjs`), the reading-offset backfill, and `scripts/ci/` (the guards). |

Every one of these files starts with a comment saying what it is for - except
`public/index.html`, which opens with its HTML; its explanation is the map at
the start of its script - and each function worth explaining has one above it,
so reading a file top down is the intended way in. The tests follow the same
rule: each file says what it holds the code to. The shared helpers - a SQLite
database behind D1's interface, and a Worker to send requests to - are in
`tests/helpers/`; the stand-ins for a push service and for a service worker's
scope belong to one test each, and are explained where they are defined in
`tests/unit/push.test.ts` and `tests/unit/service-worker.test.ts`. Two unit
files guard the Worker as a whole rather than one part of it:
`tests/unit/access.test.ts` (who may call each route that changes something)
and `tests/unit/budgets.test.ts` (D1 queries in one invocation). Beside
`tests/unit/` are `tests/e2e/` (the page, in Chrome), `tests/integration/`
(the real Worker in workerd) and `tests/visual/` (each view's picture).

## 5. The data model

D1, migrations in `migrations/` applied in order. Additive only, bar one
correction of stored values (0021) and one index dropped that repeated a key
(0022) - see section 12.

| Table | One row per | Notes |
|---|---|---|
| `inverters` | monitored unit | `id` is `{provider}:{vendor_id}`, or `{provider}:station:{plant_id}` when the plant is the unit. `tz_name` is the zone's name where the vendor states one - SolarMan's `regionTimezone`, SolisCloud's `timeZoneStandardId` - which the SolarMan plant here does and the SolisCloud plant here, as its relay forwards it, does not; `tz_offset_sec` the offset in force now |
| `readings` | sample | Keyed `(inverter_id, ts, source)`. Holds the normalised columns **and** `raw`, the untouched vendor JSON, which is never served and is kept 30 days (`RAW_KEEP_S`): the hourly housekeeping clears it a day of readings at a time, from a cursor in kv. `tz_offset_sec` is the offset in force *when it was read*, so a day keeps its boundary after the clocks change; every row in production carries it since the 2.9 backfill |
| `devices` | inverter, logger, battery or meter | Serial, firmware, signal strength, per-string DC. A logger's `logger` (link, signal bars, uptime, make date) is public |
| `device_network` | datalogger | Its operator and cell, or MAC address. Owner only, never served - and a table of its own, because a Worker rolled back to 2.10 would serve any new column on `devices` |
| `plant_location` | system | Its position. Owner-only; sent to Open-Meteo only rounded to about a kilometre |
| `auth_owner` | the owner | The password's keyed hash, or none for passkeys only, and the *Require sign-in to view* switch |
| `auth_passkeys` | passkey | Its public key and signature counter; nothing that signs anyone in by itself |
| `auth_devices` | signed-in browser | Owner or viewer, a name like "Chrome on Android", the hash of its refresh token and of the one before (so a copy is caught), when it runs out or was signed out; a viewer carries the share link it came through |
| `auth_shares` | share link | A hash of its secret, a name, and when it runs out or was taken back |
| `auth_challenges` | passkey challenge | A registration's challenge in flight, and each sign-in challenge once it is used - five minutes each; a sign-in challenge is otherwise signed, not stored |
| `auth_attempts` | caller, and everyone | Failed sign-ins, keyed by a hash of the address, for the lockout |
| `oauth_clients` · `oauth_codes` · `oauth_grants` · `oauth_access` | registered app · approval · connected app · access token | The MCP server's OAuth; only hashes of codes and tokens. A grant is a connected app, revoked from Settings |
| `agent_reports` | report a week | The weekly report and each system's health check; `flagged` when a system is slowly making less, which the alerts read. Kept a year |
| `channels` | place alerts are posted to | ntfy, Telegram, Discord or a webhook. The token or address in `secret`, AES-GCM encrypted under a key derived from the key secret; only a `label` is ever served, and only to the owner. At most five |
| `app_settings` | setting | The owner's tariff and groups, as JSON; read by anyone who may read the dashboard, written by the owner |
| `weather_hourly` | system and hour | Sunlight, temperature and cloud from Open-Meteo; kept 400 days |
| `device_samples` | change in a device's status or signal | The link history on the Devices tab. Written on a change, or hourly while nothing changes; kept 90 days |
| `alarms` | vendor fault | Severity, raised, cleared, readable name |
| `vendor_periods` | vendor period total | Day, month and year totals per plant, from the vendor itself, back to installation |
| `poll_log` | poll attempt | The health endpoint and the footer read this; pruned after a week |
| `tokens` | provider | A vendor's cached bearer and refresh tokens, so a token outlives one cron run; sealed under `SECRET_KEY` when it is set |
| `relays` | relay computer | Random id, state, login expiry, last seen |
| `kv` | scheduled job | "Is this hourly job due yet", the week the last summary was sent for (`summary:week`), the week the agents last ran (`agents:week`) and how many tries this week's has had (`agents:tries`), where clearing the readings' payload has reached (`housekeeping:raw-until`), today's model calls (`ai:calls:<date>`), and which notification events have been told. Expired entries are cleared hourly |
| `push_subscriptions` | device signed up for notifications | The push endpoint is the secret and is never served; at most ten |
| `push_messages` | notification text | What a woken device shows, for every device or one; kept a week |

Three things worth knowing before writing SQL here:

- **The free tier's read budget is a real constraint** - about 5 million rows a
  day. It has been blown twice, both times by a query that looked innocent. Use
  `npx wrangler d1 insights solar-lens --sort-by reads` to find the culprit
  rather than guessing.
- **So is the limit on queries in one invocation** - fifty on the free plan, a
  thousand on a paid one; past it every query in that request or cron run
  fails. `tests/unit/budgets.test.ts` counts every statement of the cron runs,
  a relay's history post and the heaviest question, and fails past fifty. A
  loop that runs a query per item belongs in a batch.
- **Re-polling a vendor that has not produced a new sample stores no new row**,
  but does refresh the existing row's derived columns, so improving a normaliser
  reaches the newest sample without waiting for the vendor.

## 6. The dashboard

One file, `public/index.html`: markup, styles and script, no build step and no
framework. It polls `/api/latest` and `/api/series` every ten minutes, pauses
while the tab is hidden, and renders its views - Overview, Power, Analysis,
Compare (with two systems or more), Map (the owner's), Historical Data, Alerts,
Devices, Ask, a page per system, Settings behind the gear, a TV mode for a wall
display, and the Guide behind the book icon in the header, which explains all
of them to someone who has never seen the app. The
Guide carries the release number in `RELEASE`; a unit test fails if it differs
from package.json, so bumping the version means bumping it there too, and
writing its "What is new" card.

Two behaviours to know before changing it:

- **Alerts are computed in the page, not stored.** Staleness, an offline
  inverter, an expired relay login and a vendor fault all become rows there,
  each with a sentence saying what to do. What reaches the phones and the places
  under *Alerts elsewhere* is judged in the Worker instead (`announce()` in
  `src/push.ts`), after each five-minute poll, and told once.
- **A plant is "offline" when the vendor says so, or when its newest reading is
  older than `STALE_AFTER_S`** (25 minutes). That threshold must stay
  comfortably above the poll interval, or healthy systems flip to offline.

## 7. The relay, and the weekly login

- Runs from a **Windows scheduled task at logon, and again every ten minutes**,
  started through `scripts/relay-hidden.vbs` rather than `node.exe` directly,
  because node is a console application and would put a black terminal on
  screen at every logon. The ten-minute check does nothing while the relay
  runs; it exists because a relay that stopped used to stay down until the
  next logon - once for nine days - since Task Scheduler's "restart on failure"
  covers only a task that fails to start. Setup registers both. Setup and
  `renew-solis-login` switch the task off while they run a relay of their own,
  and back on after, so the check cannot start a second relay mid-login.
- **Always headless in the background**: the launcher forces it, whatever
  `.dev.vars` says.
- **A SolisCloud web login lasts exactly seven days** and is not extended by
  use. Measured, not assumed: a login made at 14:53 UTC carries a cookie
  expiring 14:53 UTC seven days later, after a relay used it every five minutes
  in between.
- **With the login saved, the relay renews it itself.** `SOLIS_USERNAME` and
  `SOLIS_PASSWORD` in `.dev.vars` (setup writes them from an installer that
  carries them): when the login runs out, the relay logs in again, still
  hidden - fills both in, ticks the agreement box (the owner asked for that),
  presses Login. If SolisCloud asks for a puzzle or a code, which no script
  answers, a window opens, filled in, for a person to finish and press Login
  (the relay does not send the login twice). One attempt an
  hour, kept in a file in the profile so a restart does not reset it, so a
  refused password is not tried until the account locks. A new laptop with
  the login saved starts hidden too. Both
  values are plain text in `.dev.vars` and in an installer made with them.
- The relay reports its login's expiry after every cycle. The dashboard warns
  two days ahead, naming the computer.
- **Without a saved login, renewing is one double-click**:
  `renew-solis-login.cmd` on that laptop. It checks the login hidden first and
  opens a window only if a login is needed.
- **The relay reads someone else's website, and that website changes.** In
  October 2026 SolisCloud moved its plant page, and every relay failed with a
  valid login until it was taught the new address. The pages it opens are
  `PLANT_PAGES` (and the device and alarm pages) in `agent/solis-relay.mjs`;
  when a relay reports *error* with a valid login, look at the site first -
  run the relay once in a window (`RELAY_ONCE=1`, `RELAY_HEADLESS=0`).
- **A relay only works while its computer is awake.** Sleep set to *Never* when
  plugged in; a closed lid that sleeps is the same outage.
- More than one relay is fine: duplicate readings are stored once, and whichever
  laptop is awake fills the gaps.
- **A laptop takes its code from `main`**: the installer and
  `renew-solis-login.cmd` update the checkout, and the installer installs
  exactly what the lockfile records (`npm ci`). Pinning the laptops to release
  tags instead is in section 14.

The permanent fix is SolisCloud's official API key, requested from their
support.
`SolisCloudProvider` is already written and activates the moment the key and
secret are set, and the relay disappears entirely.

## 8. Privacy: what is public and what is stripped

**Who can read** is the owner's choice since 3.0. Open, as in 2.x, until
*Require sign-in to view* is turned on in Settings; then the owner (signed in
once per device, renewed silently, never asked again) and anyone holding a
share link. The 2.x per-device unlock was removed because it cost a step on
every device and locked people out when the local copy was lost; the 3.0 login
avoids both - a passkey or password once, and a year-long refresh token that
renews itself. `src/auth/sessions.ts` has the design and its reasons. The 2.x
unlock link, `/auth?t=<API_TOKEN>`, signs nothing in since 3.0: it put the key
to everything into an address, where history and logs keep it.

**What a read can carry** is the same either way, and `src/public-view.ts`
decides it:

- **Station and plant ids become positional aliases** - `s1`, `s2`. Positional,
  not hashed, because a SolarMan station id is eight digits and a hash of one is
  reversible by trying all hundred million.
- **Serials are masked** to the last four characters.
- **`raw`, the stored vendor payload, is never served as it is.** Its alert
  fields go out as named columns, and its measurements as `telemetry`: only
  the fields on the reviewed list in `src/public-view.ts` (TELEMETRY_KEYS),
  and only with a plain value. **A new vendor field shows in the Raw telemetry
  table only once someone has read it and added it to that list** - that is the
  point, since the plant records carry notes, codes and a zone name beside the
  measurements. A device's own alert count goes out as `alert_status`, and a
  device is named by a positional alias ("s1-datalogger-1"), not its serial.
- **The payload itself is kept 30 days.** The hourly housekeeping clears `raw`
  from readings older than a month; the figures stay. A copy of the database
  holds a month of vendor replies, not years of them.
- **What the Worker must keep and read back is sealed**: an alert channel's
  token or address, and - with `SECRET_KEY` set - the vendors' cached login
  tokens, AES-GCM under a key derived from the key secret, which the database
  never holds.
- **A system's position is the owner's alone.** It is read from the vendor's
  plant record into `plant_location`, served by `/api/locations` to the owner
  only (a share link does not get it), and sent to Open-Meteo rounded to two
  decimal places. The site map is the only thing that shows it.
- **A datalogger's network handles are never served.** Its mobile operator
  and cell, or its MAC address, are stored in `device_network` for the owner,
  never on the devices row: a cell id or a MAC address can place a logger on a
  map or tie it to one household, and a Worker rolled back to 2.10 would serve
  any column on `devices` it did not know to strip. **Keep anything sensitive
  that a new version adds out of the tables an older version selects `*` from.**
- **A relay's id never leaves the database**; the page names relays by nickname
  or as "Relay 1", "Relay 2". The id is random and never the computer's name,
  because a Windows machine name often carries a company and a person's name.
- **Plant names are published knowingly** - they label each system on screen.

## 9. Credentials: where each lives

| Credential | Lives in | If lost |
|---|---|---|
| Cloudflare account login | The owner's password manager | Only the owner can recover it |
| Cloudflare API token, for deploying | GitHub → environment `production` → `CLOUDFLARE_API_TOKEN` | Roll it in Cloudflare and update the secret; it is shown once |
| `API_TOKEN` (the owner's key: sign-in setup code and write gate; without `SECRET_KEY`, the key secret too) | Cloudflare secret + local `.dev.vars` | `scripts/rotate-tokens.ps1 -Api`. Devices, passkeys and apps connected to the MCP server keep working. With `SECRET_KEY` set, so does everything else; without it **the password must be set again** (Settings → Forgot your password?, with the new token as the setup code), and **each place under Alerts elsewhere added again**, since both were keyed with this one |
| `SECRET_KEY` (the key secret: session signing, password pepper, the seal on the alert channels and the vendors' cached tokens) | Cloudflare secret + local `.dev.vars` | Cannot be recovered, only replaced: `npm run cf -- secret put SECRET_KEY`. Devices stay signed in, but the password must be set again, each alert channel added again, and a SolarMan web session given a fresh refresh token. Keep it with the other secrets; it is meant never to change |
| The owner's password and passkeys | The owner; the database holds a keyed hash and public keys only | *Forgot your password?* with the setup code; a passkey needs only its own device |
| `INGEST_TOKEN` (lets a relay push) | Cloudflare secret + `.dev.vars` on each relay laptop | `scripts/rotate-tokens.ps1 -Ingest`, then re-run the installer on each laptop |
| SolarMan session tokens | `.dev.vars`, refreshed automatically | Re-capture from the portal; `README.md` has the steps |
| SolisCloud portal login | The `.relay-profile` browser profile beside the relay | `renew-solis-login.cmd` |
| SolisCloud username and password (optional) | `.dev.vars` on each relay laptop, as `SOLIS_USERNAME` / `SOLIS_PASSWORD`, and in any installer `make-laptop-installer.ps1` wrote from it - plain text both | Change it on SolisCloud, then in each `.dev.vars`; make the installer again |
| Plant ids, database id, deployment address | `.dev.vars`, and the `production` environment's secrets | Read them from the Cloudflare dashboard |

**`.dev.vars` on the main machine is the most valuable file in the system.** It
is gitignored, and Cloudflare will not hand a secret back once set. Keep a copy
somewhere safe. Everything else can be rebuilt from this repository.

## 10. How a change reaches production

1. Branch, commit, open a pull request.
2. **Fifteen checks run.** The ruleset requires twelve of them, a review, and
   every conversation resolved; the owner's own pull request is approved only
   once all fifteen have passed. They are the nine jobs of `checks.yml` (type check,
   unit tests with coverage thresholds, end-to-end tests, a build dry run,
   integration tests against the real Worker in workerd, screenshot comparison,
   Lighthouse, the four project-specific guards, and a Windows job for the relay
   scripts) and the six of `security.yml` (CodeQL, dependency review,
   `npm audit`, a secret scan of the whole history, workflow lint, and a check
   that every action is pinned to a commit). The three the ruleset does not
   require are the integration tests, the screenshot comparison and Lighthouse.
3. **Wait for Copilot's review** of the latest commit, then for each suggestion:
   fix it or explain why not, reply on the conversation, and resolve it. A push
   brings a fresh review, so repeat until nothing is open - the ruleset refuses
   a merge while any conversation is unresolved. Check merged pull requests too:
   a review can land after the merge.
4. Merge. The checks run again on the merged result.
5. **A person approves the deploy** on GitHub - the `production` environment
   requires a reviewer. A deploy started by hand runs only from `main`.
6. Migrations, deploy, then a **smoke test against the live site**: the page and
   its security policy, health and latest answering, a vendor feed current, no
   identifiers in the public responses, and the token-protected routes still
   refusing a caller without one.
7. **If the smoke test fails, the previous version is restored automatically**
   and the run is marked failed. (Until 3.0 that restore would itself have
   failed: see section 13.)
8. Releases: set the version in `package.json` (`npm version X.Y.Z --no-git-tag-version`),
   the same number in `RELEASE` in `public/index.html`, and rewrite the guide's
   "What is new" card beside it; write the changelog section and its link
   reference; merge, then run **Actions → Release**. It refuses unless the
   version, the changelog section and its link reference agree and no such tag
   exists, and a unit test fails if the guide names a different release.

The four guards in `scripts/ci/` are worth reading before your first pull
request: `check-privacy` (identifiers, in every commit *and* the description),
`check-attribution` (who a commit is credited to), `check-headers` (the two
copies of the security headers must match), `check-cmd-shape` (a `.cmd` must be
one parenthesised block with Windows line endings, so the update it runs cannot
break it mid-run).

## 11. Operating it

**The routine**

| When | What |
|---|---|
| Weekly, only if the dashboard warns | Nothing, with the login saved in `.dev.vars`: the relay logs in by itself. Otherwise, or if SolisCloud asked for a puzzle and nobody answered: `renew-solis-login.cmd` on the named laptop |
| Once, then per new phone | `node scripts/make-vapid-key.mjs` gives the Worker its push key; then Alerts tab → *Turn on for this device* on each phone |
| After a release that changes relay code | Double-click `setup-solarlens-relay.cmd` on each relay laptop; the deploy summary says when |
| After any release | Nothing: an open dashboard offers *Reload* within fifteen minutes, or on coming back to the tab, and a TV display reloads itself |
| Occasionally | Check the D1 read budget if the dashboard is left open on many screens - or make it private, or add the rate limit (`RATE_LIMIT`) |

**The demo**: `https://muhammadmobi.github.io/SolarLens/` is `public/` with `demo/demo.js` in
front of it, answering every request with made-up data; `.github/workflows/pages.yml`
publishes it when either changes on `main`. Pages has to be turned on once (Settings → Pages →
source: GitHub Actions). When the API grows a field, the demo must grow it too -
`tests/unit/fixture-contract.test.ts` fails until it does. `npm run screenshots` retakes the
README's pictures from it.

**Watching it**: `.github/workflows/watch.yml` checks `/api/status` every half hour
and opens a GitHub issue labelled *watcher* if the site is down or no feed has
delivered for 90 minutes, closing it when readings return - or if the database
passes 400 MB, a hundred short of the free plan's 500, past which every write
fails (`DB_WARN_MB`, a repository variable, moves the line on a paid plan). It
needs the `SOLARLENS_URL` repository secret. Each deploy's summary also carries a D1 restore
point taken before its migrations.

**Seeing what is happening**: the README's *Debugging the live system* has the
commands - the Worker's live log, `/api/health`, a query against production,
and running a relay in a visible window, since a hidden relay writes no log.

**When something is wrong**

| Symptom | Almost always | Fix |
|---|---|---|
| One system reads offline while the sun is up | Relay laptop asleep, off, or its login expired | Devices tab says which; `renew-solis-login.cmd` |
| A relay reports *error* although its login is valid | SolisCloud moved a page the relay reads | Run the relay once in a window to see which step fails; the plant page's addresses are `PLANT_PAGES` in `agent/solis-relay.mjs` |
| A system shows production while its inverter is off or away | It ran somewhere else - a test, a repair - through another datalogger: SolisCloud files data under the inverter's serial number, whichever stick carries it | The Devices tab gives it away: the inverter seen recently while the plant's own datalogger has been silent for days. The inverter's `devices` row names the logger it used (`collectorsn` in `raw`). Nothing to fix |
| Both feeds stale | The Worker's cron, or Cloudflare | Cloudflare dashboard → the Worker's logs |
| A deploy failed | The smoke test refused it; the old version is already back | The run's log names the failing check in words |
| A deploy failed at the first step | The Cloudflare token expired or was rolled | New token → update the `production` secret |
| A plant appears that should not | Someone shared a plant into the account | `INCLUDE_PLANTS` in `.dev.vars` |
| Rolling back by hand | | `npm run cf -- rollback <version-id> -y -m "why"`; list with `npm run cf -- deployments list` |
| A screen shows an old version of the page | It was opened before the reload notice itself was deployed, after 2.10.0, so it has no notice to show | Reload it once by hand (Ctrl + F5, or close and reopen the phone app) |
| A `.cmd` window stays open saying something failed | That run failed on purpose, so you can read why | The lines above it say what |
| A watcher issue: *The database is filling up* | It is past 400 MB; the free plan stops every write at 500 | Readings shed their vendor payload after 30 days, which slows the growth a great deal; on a paid plan, set `DB_WARN_MB` higher |
| Every change refused: *This server has no API_TOKEN* (503) | The Worker has lost its `API_TOKEN` | `npm run cf -- secret put API_TOKEN` |
| The password stopped working after a new `API_TOKEN` | `SECRET_KEY` is not set, so the password was keyed with the old token | *Forgot your password?* with the new token as the setup code; then set `SECRET_KEY` |
| The Monday summary came late, or without the week's report | The agents failed, and are tried again the next hour, three times at most; the summary waits up to three hours for their report | `npm run cf -- tail` shows the `agents:` or `summary:` line |
| *Too many requests from this address* (429) | The optional rate limit, for a caller not signed in | Wait a minute, or sign in |

**Where the reports are**: coverage and Playwright artifacts hang off each
workflow run; CodeQL findings, dependency alerts and secret scanning live in the
repository's Security tab; `npm audit` and each deploy's outcome are printed in
the run summary. `README.md` has the full table with local equivalents.

## 12. House rules

These are not style preferences; each one exists because breaking it cost
something.

- **No identifiers in the repository, ever.** Not in code, tests, fixtures,
  documents, commit messages or pull request descriptions. History has been
  rewritten twice to remove them, and a pull request's own commits can never be
  rewritten - GitHub keeps them for good.
- **Commits are authored by the repository's own account, with no co-author
  trailer and no assistant named** in the message, the release notes or the
  repository's content. A guard enforces it.
- **Migrations are additive.** A rollback puts an older Worker back while the
  database has already moved on; additive migrations are what make that safe.
  The one that changes rows, 0021, corrects values in place (SolarMan charging
  stored as discharging) and drops nothing, so an older Worker still reads
  them - rightly, now. A correction like it must also be safe to run twice:
  after a rollback to 2.x, 0021 is run again by hand to put right what 2.x
  stored meanwhile. 0022 drops an index, which only repeated the readings
  table's own key: an index changes how fast a query is, never what it
  answers, so no Worker notices.
- **Count the queries.** D1's free plan allows fifty in one invocation, and
  `tests/unit/budgets.test.ts` holds the cron runs and the heaviest routes to
  it. A new step in a cron, or a loop in an ingest route, gets a line there.
- **Every write route is placed.** `tests/unit/access.test.ts` reads the routes
  from the source and fails on one it has not been told about: the owner's, a
  signed-in browser's, an approved app's, the relays', or open for a reason
  written beside it.
- **Comments explain why, in prose**, and cite the measurement or the incident.
  The codebase reads as one voice; keep it.
- **Documents ship with the change**: `README.md`, this file, `CHANGELOG.md`,
  `docs/feature-gaps.md`, `docs/api-notes.md`, the guide for whatever changed
  (`docs/ask-solarlens.md`, `docs/mcp.md`, `docs/alerts-elsewhere.md`,
  `docs/home-assistant.md`), `src/help.ts`, which the assistant answers
  how-to questions from, and the README's pictures - `npm run screenshots`
  retakes them of the demo when a view they show has changed.
- **Verify, do not assert.** Check `/api/health`, run `d1 insights`, run the
  script, take the screenshot. Section 13 is what assuming cost.
- **Never lower a coverage threshold to make a red build go green.**
- **Dependencies are updated by hand**, in one pull request; automatic update
  pull requests were tried and turned off.

## 13. What has already gone wrong

The short history a newcomer would otherwise repeat.

| What happened | Lesson |
|---|---|
| **Plant ids and coordinates were committed**, then removed by rewriting history twice and asking GitHub Support to delete three pull request refs | A pull request's commits are permanent. Refuse the identifier at the door; that is why the privacy guard exists |
| **A correlated subquery for the footer read 7,514 rows per call** and burned 88% of a day's D1 budget | Measure with `d1 insights`; an innocent-looking query is where the budget goes |
| **`series` scanned the whole readings table** for want of an index on `ts` | Same lesson, different query |
| **A chart's axis label was used as a scale factor**, putting a 12 kW array at 9.47 MW | Vendor field names lie; read `docs/api-notes.md` before trusting one |
| **An on-grid plant reported `batteryCapacitySoc2: 0`**, inventing an empty battery | Gate on the plant's own inventory, not on a number being present |
| **Zeros meant "not measured"**, not "zero watts", on an unmetered plant | Same |
| **A relay's login expired and it failed silently every cycle**, twice, looking exactly like the plant being down | Report the state of the collector, not only its readings |
| **A relay could report success having sent nothing**: it checked for the login page once at three seconds, and the portal redirects between three and five | A single look at a fixed moment is a race; watch until the system shows its hand |
| **A batch file that updates itself ran half a line as a command** when the update replaced it mid-run | `.cmd` files do their work inside one parenthesised block |
| **A deploy's rollback target was read with a command substitution inside `echo`**, which cannot fail, so a failed lookup silently left the run unable to undo itself | A step that cannot fail cannot protect you |
| **The privacy guard read the digits inside a pinned commit hash as a plant id**, and Dependabot's sign-off as a leaked address | A guard's false positives are its own bug; fix them, do not weaken the rule |
| **A maintenance script passed every local test and answered `undefined` against production**: `wrangler d1 execute --file` returns rows from a local database but import statistics from a remote one, and `--command` through `scripts/wrangler.mjs` is split at every space by the shell | Dry-run against the real thing before `--apply`. A script that talks to D1 runs wrangler's own entry point with node, as `scripts/backfill-reading-offsets.mjs` does - and since 3.0 so does the wrapper itself, every argument whole, after the review before release found the same split would have broken the deploy's rollback |
| **`npm run seed:local` seeded a database the dashboard never read**: it ran `npx wrangler` with the committed config, whose database id is a placeholder, and wrangler keys a local database by its id - so the seed and `npm run dev` each had one of their own | Every script that talks to D1 goes through the wrapper's filled-in config (`scripts/wrangler.mjs`), locally as well as remotely |
| **A reading pushed to `/api/ingest` with fields missing was refused with a 500** - D1 cannot bind `undefined` - and nothing had tried one until the review before 3.0 wrote the test | Turn every optional field into `null` before binding. The test database refuses `undefined` as D1 does, so a test finds it before a deploy does |
| **The review before 3.0 counted a Monday's cron at some ninety-five D1 queries**, where the free plan allows fifty in one invocation - and the week was claimed before the work, so a run cut short would have lost the week's report for good | Count, do not estimate: `tests/unit/budgets.test.ts`. Mark a job done after it is done, not before |
| **A dashboard tab left open across a release kept running the old page**, so the 2.10 guide went unseen on a screen that had been open all along | A page refreshes its figures, never itself; it now compares its own script with the server's and offers a reload |
| **On a phone the page was wider than the screen**: the tab bar could not shrink, the browser zoomed the layout out, and a notice fixed to the bottom landed below it where it could not be tapped | Test layouts at phone width, and hold the page to the screen width - `tests/e2e/phone-width.spec.ts` does |
| **Several Copilot review rounds found real bugs** - a notification repeating every five minutes, a race in the reload check - and some threads had been resolved without a word | Every pull request: wait for the review, fix, reply, resolve, repeat until none is open. The ruleset now refuses a merge with an open conversation |
| **A system showed an hour of production while its inverter was away being tested**: the installer ran it through their own datalogger, SolisCloud filed the readings under the inverter's serial number - so on the owner's plant - and the relay, its laptop off at the time, copied them with the day's chart when it next ran | A reading nobody expected is the vendor's before it is a bug: find which datalogger carried it (section 11) before suspecting the code |
| **SolisCloud moved its plant page, and no Solis reading arrived for two days**: the relay waited on an address the portal no longer had, logged in or not, while the other laptop's relay had stopped weeks before, with nothing to start it again | A relay is a browser reading someone else's site: when it fails with a valid login, look at the site first. And a hidden process needs something to start it again - the task now checks every ten minutes |

## 14. What is still missing

`docs/roadmap.md` is the plan for 3.0, phase by phase, and what was left out on
purpose. `docs/feature-gaps.md` is the honest list. SolarMan alarm detail and notifications to a closed browser, both listed here before, are built. What is left:

- ~~The Worker's own routes have no test that runs them before a merge.~~
  **Closed in 2.7**: `tests/helpers/d1.ts` puts SQLite behind the D1 interface,
  so every route, the SQL and the cron fan-out run in the unit suite against a
  real database. What no unit test can reach is workerd itself - `crypto`'s MD5,
  the asset binding, real network - which the end-to-end suite, the probe script
  and the deploy's smoke test cover.
- **SolisCloud's official API key** would remove the weekly login, the laptop
  and the relay entirely.
- ~~The page reads a raw vendor payload the server never sends.~~ **Closed in
  3.0.** The Worker sends the alert fields as named columns and a cleaned
  `telemetry` copy for the Raw telemetry table (`src/public-view.ts`). The
  end-to-end fixtures now live in `tests/fixtures/dashboard-api.ts`, and
  `tests/unit/fixture-contract.test.ts` holds them to what the real Worker
  sends, field by field. **When you add a column to `/api/latest` or
  `/api/devices`, add it to those fixtures too** - the contract test will
  say so if you forget.
- **Push is set up once per server and once per device.** Until
  `node scripts/make-vapid-key.mjs` has run, the Alerts tab says notifications to
  a closed browser are not set up - which is the state to check first when a
  phone is not being told anything.
- **On GitHub, outside the code:** Pages is not on yet, so the demo and the
  README's link to it answer 404 until it is (section 11 says how), and the
  repository's About box - description, website, topics - is empty.
- **Left from the review before 3.0, on purpose:**
  - *A daily rollup of the readings.* Historical Data and the tools sum the
    day from every reading, so a long period reads many rows. A table of day
    totals kept by a trigger would cut that, but D1 applies remote migrations
    through a statement splitter that has trouble with triggers, and 3.0's
    release was not the moment to find out. The 30-day payload clearing and
    the year cap for callers not signed in bound it meanwhile.
  - *Splitting the two big files.* `src/index.ts` and `public/index.html` are
    long; both are mapped at the top and searchable by section. A split is a
    change of its own, not something to fold into a release.
  - *A security policy without `'unsafe-inline'`.* It needs the page's script
    and styles out of the HTML, which means a build step the project has
    chosen not to have.
  - *The relay laptops on release tags.* They run the tip of `main`, so the
    security of the laptops is the security of the GitHub account. Pinning
    them to tags is the owner's call on how releases reach them.
  - *Which Cloudflare plan this runs on* is the owner's to confirm. Everything
    is held to the free plan's limits, so either works; on a paid plan,
    `DB_WARN_MB` can move up and the rate limit binding is there to use.

None is urgent. Each is written down so it is not rediscovered as a surprise.

## 15. Glossary

| Term | Meaning here |
|---|---|
| **Plant / station** | One solar installation at the vendor. SolisCloud says plant, SolarMan says station |
| **Inverter row** | A monitored unit in `inverters`; sometimes the plant itself, when the vendor only reports plant-level figures |
| **Relay** | The agent driving a logged-in Chrome on a Windows laptop, pushing SolisCloud readings |
| **Ingest** | A `POST /api/ingest/*` route, token-protected, that writes what a relay saw |
| **Public view** | `src/public-view.ts`, the redactor every read response passes through |
| **Alias** | `s1`, `s2` - the positional name a plant id becomes in public responses |
| **Smoke test** | `scripts/ci/smoke.mjs`, run against the live site after a deploy |
| **Guard** | One of the four project-specific checks in `scripts/ci/` |
| **Owner** | Whoever holds the setup code and signs in with a password or passkey; the one account that can change anything |
| **Setup code** | `API_TOKEN`, typed on the sign-in page to set up sign-in, or to set a forgotten password |
| **Share link, viewer** | A view-only link, `/s/<link>`, and whoever opened it; its token as a bearer header is how Home Assistant reads a private dashboard |
| **Key secret** | What every key is derived from: `SECRET_KEY`, or `API_TOKEN` where it is not set (`keySecret` in `src/auth/crypto.ts`) |
| **Channel** | A place under *Alerts elsewhere* - ntfy, Telegram, Discord or a webhook |
| **Listener** | A signed-up phone, or a channel taking alerts; with none, nothing is announced |
| **Told once** | The state in `kv` that keeps an event from being announced twice |
| **The hourly run** | The second cron, at seven minutes past each hour: the agents, the summary, the weather and the housekeeping (`src/cron.ts`) |
| **Housekeeping** | The hourly clearing: old messages, link history and kv entries, readings' payloads past 30 days, and channels moved over to `SECRET_KEY` |
| **Invocation** | One request, or one cron run: D1's free plan allows fifty queries in each (`tests/unit/budgets.test.ts`) |
| **Tool** | One of the sixteen read-only functions in `src/tools.ts` that the assistant, the agents and the MCP server answer with |
| **Agents** | The weekly health check and report (`src/agents.ts`) |
| **Connected app** | An AI app the owner has approved, through OAuth, to read over `/mcp` |

## 16. Rebuilding from nothing

With this repository and a copy of `.dev.vars`:

1. Create a Cloudflare account; `npm run cf -- d1 create solar-lens`.
2. Put the database id in `.dev.vars`; `npm run db:remote` applies migrations.
3. `npm run cf -- secret put API_TOKEN`, `SECRET_KEY` and `INGEST_TOKEN` -
   `SECRET_KEY` the same value as before, if a copy of the old database is
   restored, or its password and alert channels cannot be read.
4. `npm run deploy`. The first deploy asks you to register a `workers.dev`
   subdomain.
5. On a Windows laptop, double-click `setup-relay.cmd` and log in to SolisCloud
   once.
6. For the pipeline: create the `production` environment with a required
   reviewer and its four secrets - `README.md` lists them.

About ten minutes, plus the vendor logins. Readings from before the new
database's first poll would not come back; everything else would.

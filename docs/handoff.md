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

1. [Start here](#1-start-here)
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
npm run test:unit             # ~275 tests, a few seconds
npm run test:unit:coverage    # the same, with the coverage thresholds applied
npm run test:e2e              # ~265 tests, about three minutes, needs Chrome
```

All of that runs with no Cloudflare account, no database and no vendor
credentials: the end-to-end suite serves the real dashboard from a static
server and stubs every `/api/*` route with fixtures.

Then read, in this order: section 3 below (how data flows), `README.md`'s
architecture section, and `docs/api-notes.md` if you are touching anything that
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
  `CHANGELOG.md` and `docs/feature-gaps.md` are part of the deliverable.

## 2. What SolarLens is

Two solar systems, two vendor clouds, one page:

- **A 12 kWp on-grid system** on SolisCloud (Ginlong). No battery.
- **A 3.5 kW hybrid system with a battery** on SolarMan.

A Cloudflare Worker collects readings every five minutes into a D1 database and
serves a public dashboard - live power, today's and lifetime energy, battery
state, per-string DC, per-phase AC, fault history, daily and monthly totals.

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
```

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

Reads are public. Writes need a token - `/api/poll` because it spends vendor
quota, `/api/ingest/*` because they write.

## 4. The code, file by file

| File | What it owns |
|---|---|
| `src/index.ts` | Every route, the auth middleware, the security headers, the cron entry point. Hono. |
| `src/db.ts` | All SQL. Upserts, the latest-per-inverter query, series, daily rollups, the poll log, alarms, period totals, relays, a token store. |
| `src/poll.ts` | The cron fan-out: which providers to call, in what order, what to do when one fails. |
| `src/public-view.ts` | **The one file deciding what leaves the Worker.** Aliases ids, masks serials, drops raw payloads. |
| `src/relays.ts` | Validates a relay's report on itself into a narrow shape. |
| `src/providers/types.ts` | The `Provider` interface every adapter implements, plus shared shapes. |
| `src/providers/soliscloud.ts` | SolisCloud's official API adapter (dormant until an API key exists) and the relay payload normaliser. |
| `src/providers/solarman.ts` | SolarMan's Business API adapter and its normaliser. |
| `src/providers/solarman-web.ts` | The browser-session fallback used today, refresh-token based. |
| `src/providers/events.ts` | Alarms and vendor period totals from both vendors, into one shape. |
| `src/providers/units.ts` | W / kWh / timestamp / timezone scaling. Small, and the source of the worst bug in section 13. |
| `src/providers/queue.ts` | A call queue holding 1.5-2s between vendor calls. |
| `agent/solis-relay.mjs` | The relay: drives Chrome, waits for the portal's own responses, pushes. |
| `agent/solis-extras.mjs` | Its slower reads - alarm history, period totals. |
| `agent/relay-status.mjs` | Login expiry from the portal cookie, the relay's random id, its nickname. |
| `public/index.html` | The whole dashboard - markup, styles and script in one file, no build step. |
| `scripts/` | Operational tooling: the wrangler wrapper, the relay installer, login renewal, token rotation, the capture tool, and `scripts/ci/` (the guards). |

## 5. The data model

D1, migrations in `migrations/` applied in order. Additive only - see section 12.

| Table | One row per | Notes |
|---|---|---|
| `inverters` | monitored unit | `id` is `{provider}:{vendor_id}`, or `{provider}:station:{plant_id}` when the plant is the unit |
| `readings` | sample | Keyed `(inverter_id, ts, source)`. Holds the normalised columns **and** `raw`, the untouched vendor JSON, which is never served |
| `devices` | inverter, logger, battery or meter | Serial, firmware, signal strength, per-string DC |
| `alarms` | vendor fault | Severity, raised, cleared, readable name |
| `periods` | vendor period total | Day, month, year, lifetime, per plant |
| `polls` | poll attempt | The health endpoint and the footer read this |
| `relays` | relay computer | Random id, state, login expiry, last seen |
| `kv` | scheduled job | "Is this hourly job due yet" |

Two things worth knowing before writing SQL here:

- **The free tier's read budget is a real constraint** - about 5 million rows a
  day. It has been blown twice, both times by a query that looked innocent. Use
  `npx wrangler d1 insights solar-lens --sort-by reads` to find the culprit
  rather than guessing.
- **Re-polling a vendor that has not produced a new sample stores no new row**,
  but does refresh the existing row's derived columns, so improving a normaliser
  reaches the newest sample without waiting for the vendor.

## 6. The dashboard

One file, `public/index.html`: markup, styles and script, no build step and no
framework. It polls `/api/latest` and `/api/series`, pauses while the tab is
hidden, and renders five views - Overview, Historical, Devices, Alerts and a TV
mode for a wall display.

Two behaviours to know before changing it:

- **Alerts are computed in the page, not stored.** Staleness, an offline
  inverter, an expired relay login and a vendor fault all become rows there,
  each with a sentence saying what to do.
- **A plant is "offline" when the vendor says so, or when its newest reading is
  older than `STALE_AFTER_S`** (25 minutes). That threshold must stay
  comfortably above the poll interval, or healthy systems flip to offline.

## 7. The relay, and the weekly login

- Runs from a **Windows scheduled task at logon**, started through
  `scripts/relay-hidden.vbs` rather than `node.exe` directly, because node is a
  console application and would put a black terminal on screen at every logon.
- **Always headless in the background**: the launcher forces it, whatever
  `.dev.vars` says.
- **A SolisCloud web login lasts exactly seven days**, is not extended by use,
  and its page carries a captcha - so no script can renew it. Measured, not
  assumed: a login made at 14:53 UTC carries a cookie expiring 14:53 UTC seven
  days later, after a relay used it every five minutes in between.
- The relay reports its login's expiry after every cycle. The dashboard warns
  two days ahead, naming the computer.
- **Renewing is one double-click**: `renew-solis-login.cmd` on that laptop. It
  checks the login hidden first and opens a window only if a login is needed.
- **A relay only works while its computer is awake.** Sleep set to *Never* when
  plugged in; a closed lid that sleeps is the same outage.
- More than one relay is fine: duplicate readings are stored once, and whichever
  laptop is awake fills the gaps.

The permanent fix is SolisCloud's official API key (their ticket #1041568).
`SolisCloudProvider` is already written and activates the moment the key and
secret are set, and the relay disappears entirely.

## 8. Privacy: what is public and what is stripped

The dashboard is public **on purpose** - a per-device unlock was removed
because it cost a step on every new device and locked people out when the local
copy was lost. What holds the line instead is `src/public-view.ts`:

- **Station and plant ids become positional aliases** - `s1`, `s2`. Positional,
  not hashed, because a SolarMan station id is eight digits and a hash of one is
  reversible by trying all hundred million.
- **Serials are masked** to the last four characters.
- **`raw`, the stored vendor payload, is never served.**
- **A relay's id never leaves the database**; the page names relays by nickname
  or as "Relay 1", "Relay 2". The id is random and never the computer's name,
  because a Windows machine name often carries a company and a person's name.
- **Plant names are published knowingly** - they label each system on screen.

## 9. Credentials: where each lives

| Credential | Lives in | If lost |
|---|---|---|
| Cloudflare account login | The owner's password manager | Only the owner can recover it |
| Cloudflare API token, for deploying | GitHub → environment `production` → `CLOUDFLARE_API_TOKEN` | Roll it in Cloudflare and update the secret; it is shown once |
| `API_TOKEN` (guards `/api/poll`) | Cloudflare secret + local `.dev.vars` | `scripts/rotate-tokens.ps1 -Api` |
| `INGEST_TOKEN` (lets a relay push) | Cloudflare secret + `.dev.vars` on each relay laptop | `scripts/rotate-tokens.ps1 -Ingest`, then re-run the installer on each laptop |
| SolarMan session tokens | `.dev.vars`, refreshed automatically | Re-capture from the portal; `README.md` has the steps |
| SolisCloud portal login | The `.relay-profile` browser profile beside the relay | `renew-solis-login.cmd` |
| Plant ids, database id, deployment address | `.dev.vars`, and the `production` environment's secrets | Read them from the Cloudflare dashboard |

**`.dev.vars` on the main machine is the most valuable file in the system.** It
is gitignored, and Cloudflare will not hand a secret back once set. Keep a copy
somewhere safe. Everything else can be rebuilt from this repository.

## 10. How a change reaches production

1. Branch, commit, open a pull request.
2. **Twelve checks run, and all must pass**: type check, unit tests with
   coverage thresholds, end-to-end tests, a build dry run, four project-specific
   guards, a Windows job for the relay scripts, CodeQL, dependency review,
   `npm audit`, a secret scan of the whole history, workflow lint, and a check
   that every action is pinned to a commit.
3. Merge. The checks run again on the merged result.
4. **A person approves the deploy** on GitHub - the `production` environment
   requires a reviewer.
5. Migrations, deploy, then a **smoke test against the live site**: the page and
   its security policy, health and latest answering, a vendor feed current, no
   identifiers in the public responses, and the token-protected routes still
   refusing a caller without one.
6. **If the smoke test fails, the previous version is restored automatically**
   and the run is marked failed.
7. Releases: set the version in `package.json`, write the changelog section,
   merge, then run **Actions → Release**. It refuses unless the version, the
   changelog section and its link reference agree and no such tag exists.

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
| Weekly, when the dashboard warns | Renew a SolisCloud login: `renew-solis-login.cmd` on the named laptop |
| After a release that changes relay code | Double-click `setup-solarlens-relay.cmd` on each relay laptop; the deploy summary says when |
| Occasionally | Check the D1 read budget if the dashboard is left open on many screens |

**When something is wrong**

| Symptom | Almost always | Fix |
|---|---|---|
| One system reads offline while the sun is up | Relay laptop asleep, off, or its login expired | Devices tab says which; `renew-solis-login.cmd` |
| Both feeds stale | The Worker's cron, or Cloudflare | Cloudflare dashboard → the Worker's logs |
| A deploy failed | The smoke test refused it; the old version is already back | The run's log names the failing check in words |
| A deploy failed at the first step | The Cloudflare token expired or was rolled | New token → update the `production` secret |
| A plant appears that should not | Someone shared a plant into the account | `INCLUDE_PLANTS` in `.dev.vars` |
| Rolling back by hand | | `npm run cf -- rollback <version-id> -y -m "why"`; list with `npm run cf -- deployments list` |
| A `.cmd` window stays open saying something failed | That run failed on purpose, so you can read why | The lines above it say what |

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
- **Comments explain why, in prose**, and cite the measurement or the incident.
  The codebase reads as one voice; keep it.
- **Documents ship with the change**: `README.md`, this file, `CHANGELOG.md`,
  `docs/feature-gaps.md` and `docs/api-notes.md`.
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

## 14. What is still missing

`docs/feature-gaps.md` is the honest list. The two that matter:

- ~~The Worker's own routes have no test that runs them before a merge.~~
  **Closed in 2.7**: `tests/helpers/d1.ts` puts SQLite behind the D1 interface,
  so every route, the SQL and the cron fan-out run in the unit suite against a
  real database. What no unit test can reach is workerd itself - `crypto`'s MD5,
  the asset binding, real network - which the end-to-end suite, the probe script
  and the deploy's smoke test cover.
- **SolisCloud's official API key** would remove the weekly login, the laptop
  and the relay entirely.
- **Notifications while the browser is closed.** The Alerts tab can raise a
  notification when a new alert appears, but only on a device with the
  dashboard open. Reaching a closed browser needs Web Push - a key pair, a
  subscription stored per device, and the cron sending to each.
- **SolarMan alarm detail**: when a fault cleared, and the vendor's advice. It
  needs one capture from the alert's own page in a logged-in browser.

Neither is urgent. Both are written down so they are not rediscovered as
surprises.

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

## 16. Rebuilding from nothing

With this repository and a copy of `.dev.vars`:

1. Create a Cloudflare account; `npm run cf -- d1 create solar-lens`.
2. Put the database id in `.dev.vars`; `npm run db:remote` applies migrations.
3. `npm run cf -- secret put API_TOKEN` and `INGEST_TOKEN`.
4. `npm run deploy`. The first deploy asks you to register a `workers.dev`
   subdomain.
5. On a Windows laptop, double-click `setup-relay.cmd` and log in to SolisCloud
   once.
6. For the pipeline: create the `production` environment with a required
   reviewer and its four secrets - `README.md` lists them.

About ten minutes, plus the vendor logins. Readings from before the new
database's first poll would not come back; everything else would.

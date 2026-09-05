# SolarLens

One screen for both inverters. Polls **SolisCloud** and **SolarMan** on a schedule,
normalises both into a single table, and serves a side-by-side dashboard with a
divider between the two — plus a history the vendor apps do not let you keep.

Runs on **Cloudflare Workers + D1** (free tier) with an optional local agent for
direct-from-logger Modbus readings.

> SolisCloud is Ginlong's white-label of the SolarMan (iGEN Tech) platform, which
> is why the two adapters look alike and why one normalised model covers both.

## Layout

```
wrangler.jsonc            Worker + D1 binding + 5-min cron + static assets
migrations/0001_init.sql  D1 schema
src/index.ts              Hono app: /api/*, /auth, static UI, scheduled()
src/poll.ts               orchestrates a poll across whichever providers have secrets
src/db.ts                 D1 queries
src/providers/            soliscloud.ts, solarman.ts, shared types/units/queue
public/index.html         the dashboard (no build step)
scripts/probe-solis.mjs   standalone signing check, prints raw vendor JSON
agent/                    local Modbus agent (phase 4)
```

## Setup

```bash
npm install
npx wrangler login
npx wrangler d1 create solar-lens         # paste the id into wrangler.jsonc
npm run db:local                          # schema for `wrangler dev`
npm run db:remote                         # schema for production
cp .dev.vars.example .dev.vars            # fill in, never commit
```

### Credentials

**SolisCloud (self-service).** Web portal → **Service → API Management → Activate Now**.
Solve the puzzle, confirm the emailed code, copy `KeyId` + `KeySecret`.
US/Canada accounts must first email `usservice@solisinverters.com` asking for
API access (they enable it within ~24 h).

**SolarMan (support-issued).** Email `service@solarmanpv.com` asking for Open API
`appId` / `appSecret`. They ask your role and reason; expect ~1 day.
`SOLARMAN_PASSWORD_SHA256` is the SHA-256 hex of your SolarMan Smart password:

```bash
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" 'your-password'
```

**Own tokens.** `API_TOKEN` gates `/api/*` so a public `workers.dev` URL is not an
open feed of your site. `INGEST_TOKEN` gates `/api/ingest` for the local agent.
Any long random string works:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Production secrets go in via `npx wrangler secret put NAME` for each of:
`SOLIS_KEY_ID SOLIS_KEY_SECRET SOLARMAN_APP_ID SOLARMAN_APP_SECRET SOLARMAN_EMAIL SOLARMAN_PASSWORD_SHA256 API_TOKEN INGEST_TOKEN`.

A provider is active purely when its secrets are present, so deploying with
only the Solis keys works, and SolarMan lights up the moment its keys are added.

## Verify

```bash
npm run probe:solis            # signature check against userStationList
npm run probe:solis -- --deep  # walk inverters + detail, print raw field names
npm run dev                    # http://localhost:8787
curl -X POST http://localhost:8787/api/poll
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"   # simulate the cron
npx wrangler d1 execute solar-lens --local --command "SELECT inverter_id, ts, ac_power_w, today_kwh FROM readings ORDER BY ts DESC LIMIT 10"
```

Cross-check against the vendor apps: current power and today's kWh should agree
within one polling interval. Note the sign-convention comments in
`src/providers/soliscloud.ts` — grid direction is confirmed against the app on
first real data.

## Deploy

```bash
npm run deploy
```

Then open `https://<worker>.workers.dev/auth?t=<API_TOKEN>` once per device; it
sets an HttpOnly cookie and the dashboard loads without the token thereafter.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/latest` | API_TOKEN | newest reading per inverter |
| `GET /api/series?from=&to=` | API_TOKEN | readings in a range (≤31 days) |
| `GET /api/health` | API_TOKEN | recent poll log |
| `POST /api/poll` | API_TOKEN | poll now |
| `POST /api/ingest` | INGEST_TOKEN | push a reading (local agent) |
| `GET /auth?t=` | — | set the dashboard cookie |

Conventions: power in W, energy in kWh, `grid_power_w` + import / − export,
`battery_power_w` + charging / − discharging. Every row keeps the untouched
vendor payload in `raw`.

## Roadmap

- [x] Phase 1 — Worker, D1, SolisCloud adapter, cron, two-panel UI
- [x] Phase 2 — SolarMan adapter with cached bearer token
- [ ] Phase 3 — app-login fallback (unofficial; for when a key is still pending)
- [ ] Phase 4 — local Modbus agent → `/api/ingest`
- [ ] Phase 5 — day/month/year history, CSV export, alerts, PWA

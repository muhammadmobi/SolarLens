# SolisCloud vs SolarMan vs SolarLens

What each vendor portal offers a **system owner**, what SolarLens now does, and what is
genuinely still missing. Installer-, distributor- and manufacturer-only functions (firmware
rollouts, warranty orders, org/role management, SIM billing, device provisioning) are excluded
throughout — an owner account cannot reach them.

Observed on live owner accounts in September 2026: one on-grid plant on SolisCloud, one hybrid
station on SolarMan. No account identifiers appear in this document. Last checked against the
live database after 2.10.0.

**Legend** — ● has it · ◐ partial · ○ does not have it

---

## 1. Side by side

### Live monitoring

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Live AC power, plant status | ● | ● | ● Overview + detail |
| House load / consumption power | ● | ● | ● |
| Grid import & export power | ● | ● | ● one signed figure, + import / − export |
| Battery SOC and charge/discharge power | ● | ● | ● hybrid only; hidden for on-grid |
| PV → battery → load → grid flow diagram | ● | ● | ● per system; the battery arm is omitted for on-grid |
| Today's power curve | ● | ● | ● per system + fleet total |
| Honest "last updated" when a feed goes quiet | ◐ | ◐ | ● amber staleness badge, never a stale zero |

### Energy figures

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Generation today / month / year / lifetime | ● | ● | ● |
| Consumption today / lifetime | ● | ● | ● |
| Grid import & export, today and lifetime | ● | ● | ● |
| Battery charge & discharge, today and lifetime | ● | ● | ● hybrid only |
| Self-consumption / self-sufficiency ratios | ◐ | ● | ● both, on the system page, where the load is metered |
| Full-load hours | ● | ● | ● on the overview |

### Hardware and diagnostics

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Inverter serial, model, rated power | ● | ● | ● both |
| Inverter firmware version | ● | ● | ● both |
| Commissioning date, warranty expiry | ● | ○ | ● Solis |
| **Datalogger status, model, firmware, signal** | ● | ● | ● both — Solis in dBm, SolarMan in percent |
| Everything else the datalogger reports: link type, signal bars, time since restart and in total, make date | ● | ◐ | ● a card per logger on the Devices tab — SolarMan's list says less, and nothing is invented for it |
| A datalogger's link over time: online, offline, signal | ○ | ○ | ● the last seven days as a strip, a summary and a signal line — neither app keeps this |
| Per-MPPT-string DC power | ● | ● | ● both |
| Per-string voltage & current | ● | ● | ● both |
| Per-phase AC voltage, current, frequency | ● | ● | ● both (Solis adds power factor and DC bus) |
| Inverter temperature | ● | ● | ● both |
| Device types beyond the inverter (battery, meter, EPM, weather station) | ● | ◐ | ○ not available for these plants: SolarMan lists only an inverter and a datalogger, and the battery exists only inside the inverter's data |
| BMS detail (pack voltage, current, temperature, charge limits) | ○ | ● | ● all five on the system page |
| Raw register / telemetry dump | ○ | ○ | ● searchable table of every measurement the vendor sent, ids and places left out — neither app offers this |

### Alarms and events

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Active alarm list | ● | ◐ message centre | ● an alarm SolisCloud still holds open reads "ongoing" in the fault history, beside the vendor's own count on the Alerts tab |
| Alarm code, level, duration, recovery time | ● | ◐ | ● all four for both. SolarMan's end times come from its alert timeline, which also restores the occurrences its list folds away |
| **Suggested treatment text** | ● | ◐ | ● each vendor's advice beside each alarm, where it gives any - SolarMan has none for most faults |
| Fault / warning history per device | ● | ◐ | ● per system, back to installation, newest first |
| Notification on fault or outage | ◐ | ◐ | ● a notification on any signed-up phone or computer, dashboard open or not: a system stopped mid-generation, a fault, a SolisCloud login running out, a vendor not answering |
| Email or webhook alerts | ◐ | ◐ | ○ out of scope |

### History and reporting

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Day / month / year / lifetime charts | ● | ● | ● by day, month and year; months and years use the vendor's own totals back to installation, each row saying whose figure it is |
| One system's history on its own, or all together | ◐ one plant per page | ◐ one plant per page | ● a switch on Historical Data narrows charts, tables and CSV to one system, or shows every system at once |
| Battery SOC history | ◐ | ● | ● today's charge curve with its low and high, on the system page |
| Power-analysis view (generation vs consumption vs grid) | ◐ | ● | ○ out of scope |
| CSV / data export | ● | ○ | ● Download CSV on the Historical Data tab: the rows on screen, by day, month or year (2.9) |
| Scheduled email reports | ● | ○ | ○ out of scope |
| Raw sample retention you control | ○ | ○ | ● full payload kept in your own D1 |

### Financial, environmental, weather

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Earnings today / month / lifetime, tariff config | ● | ● | ○ out of scope |
| CO₂ avoided, trees, coal saved | ● | ● | ○ out of scope |
| Current weather, 7-day forecast, sunrise/sunset | ● | ● | ◐ today's conditions, min/max and sunrise/sunset where the vendor ships them with the snapshot; nothing is fetched, so no forecast |
| Irradiance | ◐ | ◐ | ○ needs a weather station |

### Fleet, presentation, control

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Multiple plants in one account | ● | ● | ● one panel per unit |
| **Two vendors on one screen** | ○ | ○ | ● the entire point |
| Favourites, grouping, tags | ● | ◐ | ○ |
| Physical layout / site map | ● | ○ | ○ |
| Large-screen / TV mode | ● | ○ | ● `#/tv`: no chrome, sized to the screen, keeps the display awake |
| Native mobile app | ● | ● | ◐ installable web app — home screen, own window, offline shell; no native build |
| Stays current after an update | ● app stores | ● app stores | ● an open dashboard offers *Reload* when a new version is out; a TV display reloads itself |
| In-app guide to the features | ◐ help pages | ◐ help pages | ● the **Guide** button (an open book) on every page: what each tab holds, where to find things, what is new |
| Fits a phone screen | ● native app | ● native app | ● every view held to the screen width by a test |
| Remote control (charge schedules, export limit, firmware) | ● | ◐ | ○ **deliberately not** — read-only by design |
| Open API for your own tools | ◐ approval-gated | ◐ keys by email | ● JSON API, reads open, writes gated |

---

## 2. How the two portals differ, in practice

- **Solis exposes more hardware detail to an owner.** Its Device page gives inverter firmware,
  warranty and commissioning dates, and the datalogger's RSSI and upload interval. SolarMan's
  owner view is more consumption- and analytics-oriented.
- **Solis explains faults.** Its alarm table carries a *suggested treatment* column. SolarMan
  offers a message centre instead, with no remediation text.
- **SolarMan is stronger on energy analytics.** Self-sufficiency ratios, battery statistics and
  a proper power-analysis view are built in; Solis leans on downloadable reports.
- **Authentication is the biggest engineering difference.** SolarMan's portal uses a plain
  bearer token that can be replayed from a server. SolisCloud signs every call with a secret
  embedded in its JavaScript bundle, so a copied token is useless — hence the relay agent.
  Details in [api-notes.md](api-notes.md).
- **Both hide their best data in the same place.** Per-string and per-phase telemetry exists in
  both portals but appears in neither documented monitoring API; it comes from the device
  endpoints the web app calls.

---

## 3. What SolarLens does that neither app does

1. **Both vendors on one screen**, normalised to a single reading shape.
2. **A searchable raw-telemetry table** — every measurement the vendor returned for the newest sample. The Worker builds it from a reviewed list of measurement fields, so anything else the vendor sends - ids, notes, codes, a zone name, a field added tomorrow - is left out.
3. **Full sample retention in your own database**, including the untouched vendor payload.
4. **Honest staleness** — a panel says when its number was last updated and turns amber when a
   feed goes quiet, instead of showing a confidently stale zero.
5. **A JSON API** over your own data, with no vendor approval process. Reads answer anyone,
   with vendor station ids, plant ids and serial numbers stripped from every response; writes
   need a token.
6. **Both systems on one screen without scrolling** — a column each, sized to a laptop window,
   so the two are compared rather than remembered.
7. **Every system's day ends where its own sun sets.** Both portals show a
   plant's day in the plant's timezone and assume you are standing near it;
   read either from another country and "today" quietly becomes someone else's.
   SolarLens stores each plant's offset and cuts every figure, curve and daily
   row on that plant's midnight, so two systems five hours apart are each shown
   their own day on the same screen.
8. **Both vendors' fault histories on one page**, each alarm with its severity, code and how
   long it lasted, beside SolisCloud's advice - from two portals that each show only their own.

---

## 4. Still missing, and worth doing

2.3 closed the two largest gaps this section listed: the vendor alarm list with
fault history, and history from before SolarLens began collecting. A third,
batteries and meters as devices, turned out not to be a gap SolarLens can
close - see section 6. What remains:

| # | Gap | Why it matters | Effort |
|---|---|---|---|
| 1 | ~~Daylight saving on a stored offset~~ | **Closed in 2.9.** The plant's zone name is stored where the vendor states one, and each reading is stamped with the offset in force at its own timestamp - so a day keeps the boundary it was recorded under, and a summer evening read back in winter still lands in its own day. A plant whose vendor only ever sends a number still falls back to that number | done |
| 2 | ~~An automated test for the Worker itself~~ | **Closed in 2.7.** Every route, the auth middleware, the SQL and the cron fan-out now run in the unit suite against a real database: `tests/helpers/d1.ts` puts SQLite behind the D1 interface with the project's own migrations applied. All of `src/` measures 97% of statements, where the Worker's own files measured nothing. What a unit test still cannot reach is workerd itself - `crypto.subtle`'s MD5, the asset binding, real network - covered by `npm run probe:solis`, the end-to-end suite and the deploy's smoke test | done |
| 3 | ~~SolarMan alarm detail~~ | **Closed.** The portal's detail panel calls `alert/detail` for advice and `alert/timeline` for the moments a fault was active; SolarLens now calls both for the newest alerts each hour, giving every occurrence an end and bringing back the occurrences the list folds away. SolarMan has no advice for most faults, and says so by returning none | done |
| 4 | ~~Notifications that reach a closed browser~~ | **Closed.** Web Push, with the push itself empty and the words fetched by the woken device. Needs `node scripts/make-vapid-key.mjs` once, then a tap per device | done |
| 5 | ~~The dashboard reads a payload the server never sends~~ | **Closed in 3.0.** Found in September 2026 by checking the code's comments against the live API: the Raw telemetry table, the alerts built from vendor flags and a device's own alert count all read the raw payload, which the public view never sends. The Worker now sends what they need instead (`src/public-view.ts`): the alert fields as named columns (`alarm_count`, `alarm_level`, `warning_status`, `business_warning_status`, `consumer_warning_status`, `network_status`, and `alert_status` on a device), and `telemetry`, the payload's fields that are on a reviewed list of measurements. The tests had missed it because their fixtures carried the payload; `tests/unit/fixture-contract.test.ts` now runs the real Worker and fails if the end-to-end fixtures carry a field it does not send, or lack one it does | M |

## 4b. What the pipeline checks, so this list stays honest

Since 2.6, nothing merges until twelve checks pass, and nothing is deployed
until a person approves it and the live site answers a smoke test. That changes
what "still missing" means here: a gap left in this list is a gap nobody has
built, not one that might have been fixed and forgotten. `README.md` describes
each check; `Security` in the repository carries what the scanners found.

## 5. Out of scope, by decision

- ~~**CSV export.**~~ **Built in 2.9**: the Historical Data tab has a Download CSV button that
  writes the rows on screen - day, month or year - as a file, quoting properly and marking a
  figure the vendor never reported as empty rather than zero. Built in the page from data
  already fetched, so it costs no database read. *Scheduled reports* remain out of scope.
- **Weather, CO₂/trees, earnings and tariffs.**
- ~~**Notifications that arrive with the browser closed.**~~ **Built**: Web Push, set up with
  one command and turned on per device from the Alerts tab. See the README's *Notifications on
  your phone*.
- **Email and webhook alerts** remain out of scope.
- **Battery on the on-grid system** — it has none, so the block is hidden rather than showing
  zeros. Only the hybrid renders it.
- **Remote control** — charge/discharge schedules, grid switch, export limits, firmware updates.
  Solis exposes these behind a separate permission; writing to an inverter is a different risk
  class, and SolarLens is read-only by design.
- Installer/fleet management, warranty orders, SIM billing, org and role administration.

## 6. Data-quality notes

- **A SolisCloud relay needs a person once a week.** The portal's web login lasts exactly
  seven days, use does not extend it, and the login page carries hCaptcha, so no relay can
  keep itself logged in. SolarLens cannot remove that; it warns two days ahead and makes
  renewing one double-click. Only an official SolisCloud API key, which does not expire,
  would take the person out of it.
- **SolarMan reports no battery device for a hybrid plant.** Its device-type list for the
  plant is inverter and datalogger only, so a battery's own firmware, serial and status are
  not available from SolarMan at all - not merely unfetched. Its live figures are carried in
  the inverter's data, which is where SolarLens already reads them.
- **SolisCloud's advice text is uniform for grid faults.** Across two years and 63 alarms on
  an on-grid plant, every alarm - no grid, grid under-voltage, and a line or earth fault -
  carried the same advice, "No Action Required". The column is shown because it is the
  vendor's statement; it should not be read as a diagnosis.
- **An alarm can recover in the instant it began.** One SolisCloud record has identical start
  and end times, so nothing may assume an alarm's end is after its start.
- **SolisCloud's period totals copy generation into load on an unmetered plant**, exactly as
  its live snapshot does, and report every grid figure as zero. Those rows keep generation and
  full-load hours only.

- **A vendor "daily yield" can disagree with the live snapshot.** The Device page showed a full
  day's yield while the plant snapshot reported `dayEnergy: 0` — the counter resets at local
  midnight while the unit is offline. A "last known good" value would read better than a bare 0.
- **Temperature is on the device, never on a reading.** `readings.temp_c` is null on every one
  of about 7,100 stored readings from both systems, because neither station snapshot carries it;
  the inverter's device record does, and that is what the hardware panel shows.
- **An on-grid plant still reports battery fields as zero.** Taking them at face value invents a
  permanently-empty battery, so battery presence is decided by the plant's own inventory
  (`batteryCount` / `batteries`), not by whether a number happens to be present.
- **Per-string voltage and current live on the inverter, not the plant.** The plant Device page
  carries `pow1`…`pow32`, watts only; voltage and current per string come from the inverter's
  own device record, which is where SolarLens reads them. Both systems report all three.
- **The two vendors state a timezone three different ways.** SolisCloud sends whole hours
  (`timeZone: 9`), SolarMan's station detail sends seconds (`timeZoneOffset: 32400`) and its
  station search sends an IANA name (`regionTimezone: "Asia/Tokyo"`). All three are read, and
  seconds win over hours where a plant sends both, because a half-hour zone cannot be said in
  whole hours at all.
- **The SolisCloud plant observed here states its zone only by number.** SolisCloud can name a
  zone - `timeZoneStandardId`, which SolarLens reads wherever it appears - but checked in
  production after 2.9, this plant's snapshot, as the relay forwards it, carried an offset alone,
  while the SolarMan plant arrived with its zone's name. A number cannot say whether a place
  observes daylight saving, so a plant in that position has its history cut on its current
  offset - exact where the zone has no daylight saving, which is true of this one. Its stored
  readings were stamped with `--use-current-offset` for that reason. Another SolisCloud plant may
  well arrive with a name.

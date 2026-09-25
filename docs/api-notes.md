# Vendor API notes

Field names below were observed on live accounts, not guessed from documentation.
Illustrative fixtures with the same shapes live in `tests/fixtures/`. No credentials,
addresses or account identifiers are recorded here.

## Shape of a typical fleet

| Panel | Provider | Vendor id | Notes |
|---|---|---|---|
| On-grid PV | SolisCloud | plant id (19-digit number in the plant page URL) | no battery |
| Hybrid + battery | SolarMan | station id (8-digit number in the station page URL) | `gridInterconnectionType: BATTERY_BACKUP` |

Plants that other accounts *share* into yours also appear in the plant list; use
`INCLUDE_PLANTS` to poll only the ones you want.

## SolisCloud

Unit convention everywhere: a numeric field `X` is paired with `XStr` giving its unit
(`"W" | "kW" | "MW"`, `"Wh" | "kWh" | "MWh"`, capacity `"kWp"`). Always scale by the unit —
`power: 1.010, powerStr: "kW"` is 1010 W. Some fields also ship a pre-scaled twin
(`power1` in W, `allEnergy1` in kWh). `src/providers/units.ts` does this.

### Official API (`https://www.soliscloud.com:13333`, HMAC-SHA1 signed)

- `Authorization: API {KeyId}:{base64(HmacSHA1(KeySecret, VERB\nContent-MD5\nContent-Type\nDate\nPath))}`
- Rate limit 3 calls / 5 s per IP; clock skew > 15 min → HTTP 408.
- Endpoints: `/v1/api/userStationList`, `/v1/api/stationDetail`, `/v1/api/inverterList`, `/v1/api/inverterDetail`.
- Response envelopes and field names mirror the web portal (`data.page.records`, `power`/`powerStr`, …).
- Keys are self-service (Basic Settings → API Management → Activate Now) **only after** Solis
  support enables "API access" on the account — submit a Service Center ticket of type
  *API Request - System Owner*. Response times vary from days to never; see the relay agent.

### Web portal (`https://www.soliscloud.com/api/...`, all POST)

- Every request carries `Authorization: WEB 2424:{signature}` where the signature is an
  HMAC over the request computed with a secret embedded in the portal's JavaScript bundle,
  plus a `token=` session cookie. The public demo secret from the API docs does **not**
  reproduce it, and the bundle name changes on every release — so the portal cannot be
  called from a Worker with a copied token. `agent/solis-relay.mjs` therefore lets the
  real portal make the calls and relays the responses.
- **The `token` login cookie lasts exactly seven days from the moment of login**, on the
  `.soliscloud.com` domain, and use does not extend it: a relay calling the portal every five
  minutes still found the same expiry a week out. Several computers can hold valid logins at
  once; logging in on one does not end another's. The login page ships hCaptcha and a
  verification-code step, so a login cannot be scripted, and it has no "keep me signed in"
  option - its one checkbox accepts the privacy policy.
- **Without a login, the portal redirects late.** Opening `/overview/plantStation` in a browser
  with no login, the page stays on that address for about three seconds - `user/find` and the
  global config still answer 200 - and moves to `/login` between three and five. `station/list`
  is only requested once logged in, so its response is the reliable "logged in" signal and the
  login page the reliable "not"; any single look at a fixed moment races the redirect.
- `station/list` → `data.page.records[]` — plant list. Same record shape as detail below.
- `station/detailMix` body `{id}` → `data` — plant live snapshot. Fields used:
  - `dataTimestamp` (epoch **ms** as string), `state` (1 online, 2 offline, 3 alarm)
  - `power` / `powerStr` — current AC output; `psum` / `psumStr` — grid, **positive = export**
  - `dayEnergy`, `monthEnergy`, `yearEnergy`, `allEnergy` (+ `…Str`) — generation
  - `homeLoadEnergy` (today), `homeLoadTotalEnergy` — consumption
  - `gridPurchasedDayEnergy` / `gridSellDayEnergy`, `gridPurchasedTotalEnergy` / `gridSellTotalEnergy`
  - `batteryChargeEnergy` / `batteryDischargeEnergy` (today), `…TotalEnergy`
  - `batteryPower`, `batteryCapacitySoc2`, `familyLoadPower` — zero on an on-grid plant
  - `inverterCount`, `inverterOnlineCount`, `alarmCount`, `capacity` / `capacityStr`, `sno`
- `inverter/detail` body `{id, sn}` — reached at `/overview/device/details/inverter?id=&sn=`.
  The **only** source of per-string voltage/current, per-phase AC and heatsink temperature;
  none of it appears in the plant snapshot or the documented monitoring API:
  - `uPv1…32` / `iPv1…32` / `pow1…32` — per-MPPT-string V / A / W (paired `…Str` units)
  - `uAc1…3` / `iAc1…3` — per-phase V / A; `fac` (Hz), `powerFactor`
  - `inverterTemperature` (+ `inverterTemperatureUnit`), `dcBus`, `insulationResistance`
  - A wired but unlit string still reports volts with zero watts, so string presence is
    decided by any of V/A/W being non-zero.
- The collector record the relay forwards (the datalogger), beside `sn`, `machine`, `version`
  and `state`:
  - `rssi` (dBm) and `rssiLevel` (the portal's signal bars); `dataUploadCycle` (s, as a string)
  - `currentWorkingTime` - seconds since the logger last restarted; `totalWorkingTime` (and
    `runingTime`, the same figure) - seconds working in total, across restarts
  - `factoryTime` - when it was made, epoch **s** as a string; `collectorActiveDate` - first
    connected, epoch **ms**; `shelfEndTime` / `updateShelfEndTime` - original and extended
    warranty end, epoch **ms**
  - `connectionOperator`, `lac`, `ci` - a cellular logger's operator, location area and cell.
    Not stripped by `stripPii`, but a location all the same: SolarLens stores them in
    `devices.network` and never serves them.
  - `simFlowState` is -5 on a Wi-Fi logger; its other values are not known, so it is not read.
  - The link type is not a field. It is read from the model name (`S3-WIFI-ST`).
- `station/detailMix` also carries the plant's timezone: `timeZone` in whole hours,
  `timeZoneStandardId` as an IANA name, and `timeZoneStr` as a label. SolarLens reads the hours.
- `alarm/list` body `{currentPage, pageSize, state, faultType: 0, stationId}` → `data.records[]`
  with `total` and `pages`. Reached at `/overview/plantStation/details/alarm/{id}`; the page opens
  filtered to `state: 0`, and history needs the **Status** filter set and **Search** pressed.
  - `state`: `0` Active, `1` Acknowledged, `2` Recovered. No date range is sent, so a status
    covers the plant's whole history, ten records a page, newest first.
  - Fields used: `alarmCode`, `alarmMsg` (e.g. `NO-Grid`), `alarmLevel` (the portal labels `1`
    Info and `2` Warning), `advice`, `alarmBeginTime` / `alarmEndTime` (epoch **ms**).
  - `pk` is **not** unique per alarm; it repeats for every alarm of one code on one device, so
    identity is code plus start time. One real record has `alarmEndTime` equal to
    `alarmBeginTime`.
  - The same record carries the owner's `address`, `mobile`, `email`, `userName`, `userEmail`
    and country, region, city and county names and ids. None of it is kept.
- `chart/station/month` body `{id, month: 'YYYY-MM', timeZone, money}`, `chart/station/year`
  body `{id, year}` and `chart/station/all` body `{id}` → `data[]`: one point per day with data,
  per month, and per year since installation. Pressed as **Month**, **Year** and **Lifetime**
  on the plant page's Operating Data chart; the arrows either side of the date are
  `.gl-new-date-picker .change-date-btn`, previous first.
  - Fields used: `dateStr` (the period key, in the plant's calendar), `energy` + `energyStr`,
    `fullHour`, `consumeEnergy`, `gridPurchasedEnergy`, `gridSellEnergy`,
    `batteryChargeEnergy`, `batteryDischargeEnergy`, `isEnergyStorage`.
  - Each point also has `timeZone: 8`, which is the vendor's server and not the plant; ignore it.
  - On an unmetered on-grid plant `consumeEnergy` and `homeLoadEnergy` copy `energy`, and every
    grid figure is zero, exactly as in `detailMix`. Neither is a measurement.
- `inverter/listV2` returned 0 records for a plant that reports `inverterCount: 1`, and
  `chart/station/day/v2` returned all-zero series while `power[]` in the same response held
  the real curve. Plant-level `detailMix` is therefore the source of truth.

## SolarMan

### Web portal (`https://home.solarmanpv.com`, bearer JWT)

- Login: `POST /mdc-eu/oauth2-s/oauth/token`, form-encoded, `grant_type=mdc_password`,
  `username`, `password` (sha256 hex), `identity_type=2`, `client_id=test`, `system=SOLARMAN`
  **plus a Cloudflare Turnstile token**. The portal also sends the password in clear text as
  `clear_text_pwd` — never log this body.
  Response: `access_token` (24 h), `refresh_token` (~6 months), `token_type: bearer`.
  → Password login cannot be automated (Turnstile). The viable fallback is a one-time
  browser login, then the Worker uses `grant_type=refresh_token`.
- `GET /maintain-s/operating/system/{stationId}` — richest single snapshot, **W and kWh, no unit strings**:
  - live: `generationPower`, `usePower` (load), `wirePower` (net grid, + = buying), `buyPower`, `gridPower` (feed-in),
    `batteryPower` (sign observed −24 while `batteryStatus: STATIC`), `batterySoc`, `chargePower`, `dischargePower`
  - today: `generationValue`, `useValue`, `gridValue` (export), `buyValue` (import), `chargeValue`, `dischargeValue`, `selfGenAndUseValue`
  - month/year: `generationMonth`, `generationYear`, `useMonth`, `useYear`, `gridMonth`, `gridYear`, `buyMonth`, `buyYear`
  - lifetime: `generationTotal` / `generationUploadTotal`, `useTotal`, `gridTotal`, `buyTotal`, `chargeTotal`, `dischargeTotal`
  - status: `networkStatus` (`NORMAL`), `warningStatus`, `wireStatus` (`PURCHASE|SELL|…`), `batteryStatus` (`STATIC|CHARGING|DISCHARGING`)
  - `lastUpdateTime` (epoch **s**), `temperature` (often null)
- `GET /maintain-s/fast/system/{stationId}` — same live + today + lifetime fields, no month/year.
- `GET /maintain-s/station/{stationId}/detail` — static: `station.name`, `installedCapacity`, `hasBattery`, `region.timezone`.
- `POST /maintain-s/operating/station/search` body `{}` — station list with the live fields inline.
- Timezone, in three shapes: `timezone` or `regionTimezone` as an IANA name on the station
  search and detail, and `timeZoneOffset` in **seconds** where the portal sends one.
- `GET /maintain-s/fast/device/{stationId}/device-types` → e.g. `["INVERTER","COLLECTOR"]`.
  A hybrid with a battery still answers only those two: the battery is never a device of
  its own here, and its figures exist only inside the inverter's data.
- `GET /maintain-s/fast/device/{stationId}/device-list?deviceType=INVERTER|COLLECTOR` → array of
  devices. The portal only ever asks for `INVERTER`, so the datalogger needs an explicit second
  call with `COLLECTOR`. Fields used:
  - `deviceSn`, `deviceType`, `deviceName`, `deviceStatus` (1 online, 2 alarm, 3 offline)
  - `collectionTime` (epoch **s**), `gatewaySn` (the collector serving an inverter)
  - `signalIntensity` — **0-100 percent** on the collector, *not* the dBm SolisCloud reports
  - `generation` (today kWh), `generationTotal` (lifetime kWh), `generationPower` (W)
  - `featureData` — a JSON **string** of raw registers. On the collector it carries `MDUv1`
    (firmware, e.g. `LSW3_15_FFFF_1.0.78`, or `MW3_15U_...` on newer LSW-3 builds; its first
    segment names the logger family, and so its link) and `MDU_MAC_ADD1`, the logger's MAC
    address - stored in `devices.network` for the owner, never served. `communicationMode`
    ("2" on this Wi-Fi stick) is a code whose other values are not known, so it is not read. On the inverter it carries `B_left_cap1` (SOC %), `B_P1` (battery W),
    `DPi_t1` (total DC input W), `Etdy_ge1` / `Et_ge0` (today / lifetime generation kWh),
    `Etdy_cg1` / `Etdy_dcg1` (charge / discharge today), `PG_Pt1` (grid W).
  - No per-string (`DV*` / `DC*` / `DP*`) registers appear on this hybrid — only total DC input.

- `POST /device-s/device/v3/detail` body `{deviceId, siteId, language, needRealTimeDataFlag:true}`
  — the inverter's own page, and the **only** place SolarMan exposes per-string and per-phase
  detail. `device-list`'s `featureData` is merely a summary of it.
  Returns `paramCategoryList[] -> fieldList[]` with `{storageName, key, value, unit}`; values are
  strings, so parse rather than trust. Categories observed: Basic Information, Version
  Information, Electricity Generation, Grid, Consumption, Battery, BMS, Temperature, State,
  Smartload. Keys used:
  - `DV1…n` / `DC1…n` / `DP1…n` — per-PV-string volts, amps, watts
  - `AV1…3` / `AC1…3` — per-phase AC; `A_Fo1` (Hz), `PG_F1` (grid Hz)
  - `AC_T` (inverter heatsink °C), `T_DC`, `B_T1` (battery pack)
  - `Pr1` rated power (W), `INV_MOD1` inverter type, `MAIN_1`/`HMI` firmware, `SN1` serial
  - `B_V1` / `B_C1` / `B_P1` pack volts / amps / watts; `B_T1` pack temperature
  - `BMST` BMS temperature, `BMS_B_V1` / `BMS_B_C1` BMS volts / amps,
    `C_C_L` / `D_C_L` charge and discharge current limits — stored in the device `battery` column
  - Direct navigation to `/plant/infos/device` redirects to `/data`; the tab must be clicked,
    which is why the endpoints only appear after a click-through.

- `POST /maintain-s/operating/alert/search?order.direction=DESC&order.property=alertTime&page=1&size=20`
  body `{deviceType: '', language: 'en', level: '', startTime: '', levelList: null, plantId}` →
  `{total, data[]}`. The portal's Alert page (`/plant/infos/alert`).
  - Fields used: `code`, `level` (`2` seen on a fault; lower levels assumed below it),
    `showName` (e.g. `F56DC_VoltLow_Fault`), `alertTime` (epoch **s**).
  - The list itself has **no** end time and **no** remediation text, and keeps only the
    latest occurrence of a fault per day. Each row also carries `deviceId`, `ruleId`,
    `productId`, `timezone` (IANA) and `influence`, which the two calls below need.
- `POST /maintain-s/operating/alert/detail` body `{deviceId, ruleId, language}` → the alert
  again, plus `customAlertConfigDisplayReason[]` - one entry per cause, each with a
  `solution` string whose lines are separated by `\n` - and `customAlertConfigDisplay`
  with an optional `description`. Keyed by rule, not by occurrence. For a DC under-voltage
  fault both came back empty: SolarMan has no advice for it. The portal's detail panel shows
  only `solution`, and `--` when there is none.
- `POST /maintain-s/operating/alert/timeline` body `{deviceId, ruleId, alertDay: 'YYYYMMDD'}`
  → a bare array of epoch-**second** timestamps: the moments on that day, in the plant's own
  zone, when the fault was active, sampled every five minutes. The portal's chart treats
  samples no more than 300 s apart as one run and draws it from the first to the last + 300 s,
  which is where an occurrence's end comes from. It also reveals occurrences the list folds
  away: two faults on one day are one list row and two runs here.
  - Found in the portal's own bundle (a lazily loaded chunk), not in any documentation.
- `GET /maintain-s/history/batteryPower/{stationId}/stats/month?year=&month=` → `records[]`,
  one per day; `.../stats/year?year=` → `records[]` one per month, plus a `statistics` total.
  Named after the battery but covering the whole system:
  - `generationValue`, `useValue`, `gridValue` (**export**), `buyValue` (**import**),
    `chargeValue`, `dischargeValue`, `fullPowerHoursDay` — all kWh or hours
  - `year`, `month`, `day` locate the record; `day` is `0` on a month record
  - There is no year-by-year endpoint; a year's total is the sum of its months.

### Official Business API (`https://globalapi.solarmanpv.com`)

`POST /account/v1.0/token?appId=` with `appSecret`, `email`, `password` (sha256) → bearer, ~2 months.
`/station/v1.0/list`, `/station/v1.0/realTime` (same field names as above),
`/device/v1.0/currentData` (`dataList[{key,value,unit}]`). Requires `appId`/`appSecret` from
`service@solarmanpv.com`.

## Sign conventions used by SolarLens

| Field | Meaning |
|---|---|
| `grid_power_w` | **+ import** from grid, **− export** to grid |
| `battery_power_w` | **+ charging**, **− discharging**; |x| < 50 W is shown as *idle* |
| energy | always kWh; power always W; timestamps epoch seconds |

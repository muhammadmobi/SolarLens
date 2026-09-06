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
- `GET /maintain-s/fast/device/{stationId}/device-types` → e.g. `["INVERTER","COLLECTOR"]`.
- `GET /maintain-s/fast/device/{stationId}/device-list?deviceType=INVERTER|COLLECTOR` → array of
  devices. The portal only ever asks for `INVERTER`, so the datalogger needs an explicit second
  call with `COLLECTOR`. Fields used:
  - `deviceSn`, `deviceType`, `deviceName`, `deviceStatus` (1 online, 2 alarm, 3 offline)
  - `collectionTime` (epoch **s**), `gatewaySn` (the collector serving an inverter)
  - `signalIntensity` — **0-100 percent** on the collector, *not* the dBm SolisCloud reports
  - `generation` (today kWh), `generationTotal` (lifetime kWh), `generationPower` (W)
  - `featureData` — a JSON **string** of raw registers. On the collector it carries `MDUv1`
    (firmware, e.g. `LSW3_15_FFFF_1.0.78`; its first segment names the logger family) and
    `MDU_MAC_ADD1`. On the inverter it carries `B_left_cap1` (SOC %), `B_P1` (battery W),
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
  - `B_V1` / `B_C1` / `B_P1` battery V/A/W; `BMS_*` pack detail and charge limits
  - Direct navigation to `/plant/infos/device` redirects to `/data`; the tab must be clicked,
    which is why the endpoints only appear after a click-through.

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

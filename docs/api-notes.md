# Vendor API notes (captured 2026-09-05 from live sessions)

Field names below were observed on the real accounts, not guessed from docs.
No credentials, addresses, or contact details are recorded here.

## Fleet

| Panel | Provider | Vendor id | Capacity | Notes |
|---|---|---|---|---|
| Solis Ongrid | SolisCloud | station `1298491919449414894` | 12 kWp, 1 inverter | on-grid, no battery, tz Asia/Karachi |
| Nitrox Hybrid | SolarMan | station `62034057` | 3.5 kW, hybrid + battery | `gridInterconnectionType: BATTERY_BACKUP`, tz Asia/Karachi |

A second Solis plant ("GP Captain …", 6 kWp) is *shared* into the account and is deliberately ignored.

## SolisCloud

Unit convention everywhere: a numeric field `X` is paired with `XStr` giving its unit
(`"W" | "kW" | "MW"`, `"Wh" | "kWh" | "MWh"`). Always scale by the unit — `power: 1.010, powerStr: "kW"`
is 1010 W. Some fields also ship a pre-scaled twin (`power1` in W, `allEnergy1` in kWh).

### Web portal (session cookie, `https://www.soliscloud.com/api/...`, all POST)

- `station/list` → `data.page.records[]` — plant list. Same record shape as detail below.
- `station/detailMix` body `{id}` → `data` — plant live snapshot. Fields used:
  - `dataTimestamp` (epoch **ms** as string), `state` (1 = online)
  - `power` / `powerStr` — current AC output; `psumZheng` (W) — grid export side
  - `dayEnergy` / `dayEnergyStr`, `monthEnergy`, `yearEnergy`, `allEnergy` / `allEnergyStr`, `allEnergy1` (kWh)
  - `batteryPower`, `batteryCapacitySoc2`, `familyLoadPower` — zero on this on-grid plant
  - `inverterCount`, `inverterOnlineCount`, `alarmCount`
- `inverter/listV2` returned 0 records for this plant; `chart/station/day/v2` returned all-zero series.
  Plant-level `detailMix` is therefore the fallback source of truth for the web route.
- Login is `security/checkPwd` + `user/login2`; request bodies not captured. Official API keys
  are self-service, so the Solis web-login fallback is low priority.

### Official API (`https://www.soliscloud.com:13333`, HMAC-SHA1 signed)

Response envelopes and field names mirror the web portal (`data.page.records`, `power`/`powerStr`, …).
Endpoints: `/v1/api/userStationList`, `/v1/api/stationDetail`, `/v1/api/inverterList`, `/v1/api/inverterDetail`.
Rate limit 3 calls / 5 s per IP; clock skew > 15 min → HTTP 408.

## SolarMan

### Web portal (`https://home.solarmanpv.com`, bearer JWT)

- Login: `POST /mdc-eu/oauth2-s/oauth/token`, form-encoded, `grant_type=mdc_password`,
  `username`, `password` (sha256 hex), `identity_type=2`, `client_id=test`, `system=SOLARMAN`, `area=PK`
  **plus a Cloudflare Turnstile token** (`_type=cloudflare`, `token=…`). The portal also sends the
  password in clear text as `clear_text_pwd` — never log this body.
  Response: `access_token`, `refresh_token`, `expires_in: 86399` (24 h), `token_type: bearer`.
  → Password login cannot be automated (Turnstile). The viable fallback is a one-time manual login,
  then `grant_type=refresh_token` from the Worker. Refresh-token lifetime not yet measured.
- `GET /maintain-s/fast/system/{stationId}` — live snapshot, **W and kWh, no unit strings**:
  - `generationPower` (W), `usePower` (load W), `wirePower` (grid W, + = buying), `buyPower`, `gridPower`
  - `batteryPower` (W; sign observed −24 while `batteryStatus: STATIC`), `batterySoc` (%),
    `chargePower`, `dischargePower`, `batteryStatus` (`STATIC|CHARGING|DISCHARGING`)
  - `generationValue` (today kWh), `generationUploadTotal` (lifetime kWh), `useValue`, `gridValue`, `buyValue`
  - `lastUpdateTime` (epoch **s**), `networkStatus` (`NORMAL`), `warningStatus` (`NORMAL`)
- `GET /maintain-s/operating/system/{stationId}` — same live fields plus month/year totals
  (`generationMonth`, `generationYear`, `generationTotal`, `useMonth`, …) and `temperature` (null here).
- `GET /maintain-s/station/{stationId}/detail` — static: `station.name`, `installedCapacity`,
  `hasBattery`, `region.timezone`, `gridInterconnectionType`.
- `GET /maintain-s/history/power/analysis/{id}/day?year&month&day` — intraday series.
- `POST /maintain-s/operating/station/search` body `{}` — station list with the same live fields inline.
- Device-level endpoints (inverter SN, per-device temperature) not yet captured — open the
  Device tab in the capture window to record them.

### Official Business API (`https://globalapi.solarmanpv.com`)

`POST /account/v1.0/token?appId=` with `appSecret`, `email`, `password` (sha256) → bearer, ~2 months.
`/station/v1.0/list`, `/station/v1.0/realTime` (same field names as `fast/system` above),
`/device/v1.0/currentData` (`dataList[{key,value,unit}]`). Requires `appId`/`appSecret` from
`service@solarmanpv.com`.

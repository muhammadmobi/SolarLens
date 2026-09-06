# Feature gap analysis — SolarLens vs. the vendor apps

A survey of what the **SolisCloud** and **SolarMan Smart** portals offer an *end user / system
owner*, and which of it SolarLens does not yet have. Installer-, distributor- and
manufacturer-only functions (firmware rollouts, warranty orders, org/role management, SIM
billing, device provisioning) are excluded — they are not available to an owner account and
are out of scope.

Effort is rough: **S** = a few hours, **M** = a day, **L** = multi-day.

---

> **Status, 6 Sep 2026.** Section 1 (device inventory), the device half of section 2, and
> the string half of section 7 are now **built** — see the Devices and System detail
> views. The key finding: SolisCloud's own `inverter/listV2` and `collector/listV2`
> return serial, model, firmware, rated power, commissioning and warranty dates,
> per-MPPT-string DC power (`pow1`…`pow32`) and the datalogger's RSSI — so **none of
> that needed the official API key**, only the relay. Sections 3, 5 and 6 (history,
> financial, weather) and notifications are out of scope by the owner's decision.

## What SolarLens already has

| Area | Detail |
|---|---|
| Live view | Both systems side by side, AC power, status, staleness badge, auto-refresh |
| Today | Generation kWh, load, grid ± , battery SOC and charge/discharge, temperature |
| Energy breakdown | Month / year / lifetime generation, consumption, self-consumption, grid import & export (today + lifetime), battery charge & discharge (today + lifetime), grid/battery status |
| Charts | Today's AC output per inverter + fleet total, per-panel sparkline |
| History | Every sample stored in D1 with the untouched vendor payload |
| Health | Poll log surfaced in the footer; failed polls visible |
| Access | Token-gated API and dashboard; push endpoints for local agents |

---

## 1. Device & hardware inventory — **the biggest gap**

Both portals have a Device page; SolarLens has no concept of hardware beyond "a thing that
reports power".

| Missing | Source | Why it matters | Effort |
|---|---|---|---|
| **Datalogger / collector status** — online state, last-seen, signal strength, firmware | Solis *Device → Datalogger*; SolarMan device list | This is exactly what a silent outage looks like. Would have said "logger offline" instead of leaving us to infer it from a frozen reading | **M** |
| Inverter identity — SN, model name, rated power, firmware version | Solis *Device → Inverter* (has SN, model, rated kW); SolarMan device list | Distinguishes multiple inverters; needed for per-device drill-down | S |
| Device counts by state — total / online / alarm / offline | both | One-glance fleet health | S |
| Battery, meter, EPM, weather-station devices as first-class device types | Solis device tabs | Hybrid sites have more than an inverter | M |
| Warranty expiry, commissioning date | Solis Device table | Useful, low urgency | S |

> Note: the vendor **Device** page listed the inverter with full detail even though the
> official `inverter/listV2` API returned zero records for the same plant. A different
> endpoint backs that page — worth capturing before building per-device support.

## 2. Alarms, faults and notifications — **highest practical value**

| Missing | Source | Why it matters | Effort |
|---|---|---|---|
| **Alarm list** — code, level, content, *suggested treatment*, duration, raised/recovered times | Solis *Alarm* page; SolarMan message centre | The vendor tells you what a fault means and how to fix it; we show nothing | M |
| Alert/warning history per device | Solis *Alert*, `historyFaults`, `historyWarning` | Post-mortems on repeated faults | M |
| **Outbound notification when a feed goes stale or a fault appears** (email / push / webhook) | neither does this well | The single most useful thing we could add — today's 21-hour outage went unnoticed until we looked | **M** |
| Unread message counter | SolarMan `message/unreaded/total` | Minor | S |

## 3. History and analytics beyond today

| Missing | Source | Why it matters | Effort |
|---|---|---|---|
| **Day / month / year / lifetime charts** (we only chart today) | both | The main reason to keep history at all | M |
| Month & year bar charts, period-over-period comparison | both | Seasonal view, spotting decline | M |
| Battery SOC / charge-discharge history charts | SolarMan `history/batteryPower/.../stats/daily` and `/month` | Battery behaviour over time | M |
| Power-analysis view (generation vs consumption vs grid over a day) | SolarMan `history/power/analysis/{id}/day` | Understand self-consumption | M |
| Full-load hours, performance ratio | Solis `fullHour`; SolarMan `fullPowerHoursDay` | Detects underperformance | S |
| **CSV / data export** | Solis `exportRecords`, custom reports | Own your data; the reason many people self-host | S |
| Scheduled email reports | Solis `reportSubscription`, report_station/electric/equipment | Nice-to-have | L |

## 4. Energy-flow visualisation

| Missing | Source | Why it matters | Effort |
|---|---|---|---|
| **Animated PV → battery → load → grid flow diagram** | both (it is the centrepiece of both apps) | Instantly readable; we have the numbers already, only the drawing is missing | M |
| Flow display config (which arms exist for this system type) | SolarMan `station/{id}/flow/displayConfig`, `gridtype` | Hybrid vs on-grid render differently | S |

## 5. Financial and environmental

| Missing | Source | Why it matters | Effort |
|---|---|---|---|
| Earnings — daily / monthly / yearly / lifetime income, currency | Solis (`dayInCome`, `allInCome`, PKR); SolarMan `incomeValue` | Both apps lead with this on the home screen | S |
| Tariff / price configuration (buy & sell rates) | Solis `sysGridPriceList`, `priceMap` | Needed to compute savings properly | S |
| CO₂ avoided, trees planted, coal saved | Solis `powerStationAvoidedCo2/Tce/NumTree`; SolarMan `energy-saved` | Feel-good metric both apps show | S |

## 6. Weather

| Missing | Source | Why it matters | Effort |
|---|---|---|---|
| Current conditions, temp range, humidity, wind, sunrise/sunset | Solis `weather` fields, `get7DayForecast` | Explains a bad generation day | S |
| 7-day forecast | both | Anticipate output | S |
| Irradiance | SolarMan `irradiateIntensity` (null on our hardware) | Only with a weather station | S |

## 7. Per-string / component-level detail

| Missing | Source | Why it matters | Effort |
|---|---|---|---|
| PV string / MPPT voltages, currents, per-string power | Solis inverter detail; SolarMan device `currentData` | Find a failing string or shaded array | M |
| Panel-level / optimiser view | Solis `plantView/componentDetails`, `optimizerDetails`; SolarMan micro display | Only for optimiser/micro systems | L |
| IV-curve diagnostics | Solis `operationManage/IVCurve` | Advanced, installer-oriented | L |
| Physical layout / site map | Solis *Layout* page | Cosmetic | L |

## 8. Inverter deep telemetry

| Missing | Source | Why it matters | Effort |
|---|---|---|---|
| Per-phase AC voltage / current / frequency, DC bus, insulation resistance | Solis `inverterDetail`; SolarMan device `currentData` (`dataList`) | Real diagnostics; we currently keep only headline power | M |
| Inverter temperature | both (we have the column, nothing fills it for these units) | Thermal derating | S |
| Second-by-second live data | Solis `inverterdetail/secondData` | Only while a browser session is open | L |
| Event / waveform records | Solis `eventRecord`, `waveRecord` | Deep fault analysis | L |

## 9. Multi-plant and organisation

| Missing | Source | Why it matters | Effort |
|---|---|---|---|
| Plant list / picker with per-plant summary when there are many | both | We render a flat panel per unit; fine for 2, poor for 10 | M |
| Favourites, grouping, tags | Solis `favorites`, groups | Larger fleets | M |
| Per-plant timezone-correct "today" | both (plants carry their own tz) | Our "today" uses the *viewer's* midnight — wrong for a plant in another timezone | S |

## 10. Presentation

| Missing | Source | Why it matters | Effort |
|---|---|---|---|
| Large-screen / TV mode | Solis `largeScreen` | Wall display | S |
| PWA install, mobile home-screen icon | both have native apps | Phone use without a browser tab | S |
| Per-inverter drill-down page | both | We are single-page; detail lives in one expandable table | M |

## 11. Deliberately out of scope

- **Remote control** — charge/discharge schedules, grid switch, export power limits, firmware
  updates. Solis exposes these (`deviceControlManagement`, `remoteControl`) behind a separate
  permission. SolarLens is read-only by design; writing to an inverter is a different risk class.
- Installer/fleet management, warranty orders, SIM/traffic billing, org and role management.

---

## Recommended order

1. **Outage/fault notification** (§2) — turns the dashboard from something you check into
   something that tells you. Directly motivated by the 21-hour silent outage.
2. **Datalogger + device status** (§1) — names the cause when generation stops.
3. **Day/month/year history charts + CSV export** (§3) — we already store the data; this is
   presentation, and it is the payoff for self-hosting.
4. **Energy-flow diagram** (§4) — biggest visual gain per unit of work; data already present.
5. **Earnings, CO₂ and weather** (§5, §6) — cheap, and both apps put them front and centre.

## Data-quality items noticed while surveying

- The vendor Device page showed *Daily Yield 49.4 kWh* for a day where the plant snapshot
  reported `dayEnergy: 0` (the counter resets at local midnight while the unit is offline).
  A "last known good" value would read better than a bare 0 for an offline unit.
- `temp_c` is null for both units; the value lives in per-device telemetry (§8), not the
  station snapshot.
- Our "today" boundary is the *browser's* midnight; plants carry their own timezone (§9).

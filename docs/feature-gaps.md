# SolisCloud vs SolarMan vs SolarLens

What each vendor portal offers a **system owner**, what SolarLens now does, and what is
genuinely still missing. Installer-, distributor- and manufacturer-only functions (firmware
rollouts, warranty orders, org/role management, SIM billing, device provisioning) are excluded
throughout — an owner account cannot reach them.

Observed on live owner accounts in September 2026: one on-grid plant on SolisCloud, one hybrid
station on SolarMan. No account identifiers appear in this document.

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
| Self-consumption / self-sufficiency ratios | ◐ | ● | ◐ self-use kWh stored, ratios not shown |
| Full-load hours | ● | ● | ◐ captured, not surfaced |

### Hardware and diagnostics

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Inverter serial, model, rated power | ● | ● | ● both |
| Inverter firmware version | ● | ● | ● both |
| Commissioning date, warranty expiry | ● | ○ | ● Solis |
| **Datalogger status, model, firmware, signal** | ● | ● | ● both — Solis in dBm, SolarMan in percent |
| Per-MPPT-string DC power | ● | ● | ● both |
| Per-string voltage & current | ● | ● | ● both |
| Per-phase AC voltage, current, frequency | ● | ● | ● both (Solis adds power factor and DC bus) |
| Inverter temperature | ● | ● | ● both |
| Device types beyond the inverter (battery, meter, EPM, weather station) | ● | ◐ | ○ schema supports them, nothing populates them |
| BMS detail (pack voltage, current, temperature, charge limits) | ○ | ● | ○ captured in the raw payload, not surfaced |
| Raw register / telemetry dump | ○ | ○ | ● searchable table — neither app offers this |

### Alarms and events

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Active alarm list | ● | ◐ message centre | ○ |
| Alarm code, level, duration, recovery time | ● | ◐ | ○ |
| **Suggested treatment text** | ● | ○ | ○ Solis actually explains what a fault means |
| Fault / warning history per device | ● | ◐ | ○ |
| Push or email notification on fault or outage | ◐ | ◐ | ○ out of scope |

### History and reporting

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Day / month / year / lifetime charts | ● | ● | ○ out of scope |
| Battery SOC history | ◐ | ● | ○ out of scope |
| Power-analysis view (generation vs consumption vs grid) | ◐ | ● | ○ out of scope |
| CSV / data export | ● | ○ | ○ out of scope — but every sample **is** stored |
| Scheduled email reports | ● | ○ | ○ out of scope |
| Raw sample retention you control | ○ | ○ | ● full payload kept in your own D1 |

### Financial, environmental, weather

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Earnings today / month / lifetime, tariff config | ● | ● | ○ out of scope |
| CO₂ avoided, trees, coal saved | ● | ● | ○ out of scope |
| Current weather, 7-day forecast, sunrise/sunset | ● | ● | ○ out of scope |
| Irradiance | ◐ | ◐ | ○ needs a weather station |

### Fleet, presentation, control

| Feature | SolisCloud | SolarMan | SolarLens |
|---|:--:|:--:|---|
| Multiple plants in one account | ● | ● | ● one panel per unit |
| **Two vendors on one screen** | ○ | ○ | ● the entire point |
| Favourites, grouping, tags | ● | ◐ | ○ |
| Physical layout / site map | ● | ○ | ○ |
| Large-screen / TV mode | ● | ○ | ○ |
| Native mobile app | ● | ● | ◐ responsive web; no PWA install yet |
| Remote control (charge schedules, export limit, firmware) | ● | ◐ | ○ **deliberately not** — read-only by design |
| Open API for your own tools | ◐ approval-gated | ◐ keys by email | ● token-gated JSON API |

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
2. **A searchable raw-telemetry table** — every field the vendor returned, per sample.
3. **Full sample retention in your own database**, including the untouched vendor payload.
4. **Honest staleness** — a panel says when its number was last updated and turns amber when a
   feed goes quiet, instead of showing a confidently stale zero.
5. **A token-gated JSON API** over your own data, with no vendor approval process.

---

## 4. Still missing, and worth doing

| # | Gap | Why it matters | Effort |
|---|---|---|---|
| 1 | Self-sufficiency / self-consumption ratios | One derived figure from data already stored | S |
| 2 | Plant-timezone-correct "today" | "Today" currently uses the *viewer's* midnight; plants carry their own timezone | S |
| 3 | PWA install | Phone use without a browser tab | S |

## 5. Out of scope, by decision

- **History pages, charts beyond today, CSV export, scheduled reports.** Data is still stored;
  it is simply not presented.
- **Weather, CO₂/trees, earnings and tariffs.**
- **Notifications** (email/push/webhook on outage or fault).
- **Battery on the on-grid system** — it has none, so the block is hidden rather than showing
  zeros. Only the hybrid renders it.
- **Remote control** — charge/discharge schedules, grid switch, export limits, firmware updates.
  Solis exposes these behind a separate permission; writing to an inverter is a different risk
  class, and SolarLens is read-only by design.
- Installer/fleet management, warranty orders, SIM billing, org and role administration.

## 6. Data-quality notes

- **A vendor "daily yield" can disagree with the live snapshot.** The Device page showed a full
  day's yield while the plant snapshot reported `dayEnergy: 0` — the counter resets at local
  midnight while the unit is offline. A "last known good" value would read better than a bare 0.
- **`temp_c` is null for both units.** Temperature is per-device telemetry, not part of the
  station snapshot.
- **An on-grid plant still reports battery fields as zero.** Taking them at face value invents a
  permanently-empty battery, so battery presence is decided by the plant's own inventory
  (`batteryCount` / `batteries`), not by whether a number happens to be present.
- **Per-string *power* is reported; per-string voltage and current are not** — at least not on
  the plant Device page, where `pow1`…`pow32` are watts only.

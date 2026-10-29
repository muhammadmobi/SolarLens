# SolarLens in Home Assistant

Two directions, each optional:

- **SolarLens into Home Assistant**: every figure as a sensor - power, energy
  today and lifetime, battery, whether each system is online - for its
  dashboards, automations and Energy dashboard.
- **Alerts into Home Assistant**: SolarLens posts each alert, and the weekly
  summary, to an automation's webhook.

## Sensors

Settings (the gear) → **Home Assistant** writes the configuration for your
dashboard, with its address and your systems filled in. Paste it into
Home Assistant's `configuration.yaml` and restart Home Assistant.

It reads one address, `GET /api/sensors`, every five minutes - as often as the
vendors themselves have anything new, and far inside the optional rate limit
for callers not signed in (a token of its own, below, is never held to it).
The answer is flat JSON whose names do not change:

| Field | Unit | What it is |
|---|---|---|
| `power_w` | W | every online system's output, added up |
| `today_kwh` | kWh | made today, every system |
| `total_kwh` | kWh | made in each system's lifetime, added up: the one for the Energy dashboard |
| `systems_count`, `online` | | how many systems there are, and how many are reporting |
| `faults_active` | | vendor faults still active |
| `saved_today`, `currency`, `co2_today_kg` | | today's saving and CO₂ avoided, by the tariff in Settings; `null` without one |
| `updated` | s | when the newest reading was taken |
| `systems.s1.…` | | the same for each system, by the alias the dashboard uses: `power_w`, `today_kwh`, `total_kwh`, `battery_soc` (%), `battery_power_w`, `grid_power_w`, `load_power_w`, `load_today_kwh`, `grid_import_today_kwh`, `grid_export_today_kwh`, `online`, `status`, `faults_active`, `saved_today`, `co2_today_kg`, `name`, `capacity_w`, `updated` |

A system is offline, as on the dashboard, when its vendor says so or nothing
has arrived for 25 minutes; its live figures then read 0, and its energy today
stays.

A system's alias - `s1`, `s2` - is its place in a sorted list of the systems,
so adding a new system can move them. If you add one, open Settings again and
compare.

For the **Energy dashboard**, add the *SolarLens energy* sensor (`total_kwh`,
`total_increasing`) as solar production.

The configuration Settings writes has the fleet's power, energy today and
energy in total, and for each system its power and energy today, and its
battery's charge where it has one. It begins:

```yaml
# configuration.yaml: SolarLens, read every five minutes
rest:
  - resource: https://solarlens.example.com/api/sensors
    scan_interval: 300
    sensor:
      - name: "SolarLens power"
        unique_id: solarlens_power
        value_template: "{{ value_json.power_w }}"
        unit_of_measurement: "W"
        device_class: power
        state_class: measurement
      - name: "SolarLens energy today"
        unique_id: solarlens_today
        value_template: "{{ value_json.today_kwh }}"
        unit_of_measurement: "kWh"
        device_class: energy
        state_class: total_increasing
      - name: "SolarLens energy"
        unique_id: solarlens_total
        value_template: "{{ value_json.total_kwh }}"
        unit_of_measurement: "kWh"
        device_class: energy
        state_class: total_increasing
      - name: "South roof power"
        unique_id: solarlens_s1_power
        value_template: "{{ value_json.systems.s1.power_w }}"
        unit_of_measurement: "W"
        device_class: power
        state_class: measurement
      # ... then "South roof energy today", and a battery sensor for each system with one
```

Any other field of the answer - `online`, `faults_active`, `saved_today` and the
rest - becomes a sensor the same way, with its own `value_template`.

### When the dashboard is private

With *Require sign-in to view* on, Home Assistant needs a token of its own.
Settings → Home Assistant → **Make a token for Home Assistant** makes one and
puts it in the configuration, as

```yaml
    headers:
      Authorization: "Bearer <the token>"
```

The token is a **share link** - the part after `/s/` - sent as a bearer token.
So it can read and never write, it appears under **Share to view** as "Home
Assistant", and **Take back** there stops Home Assistant at once. It is shown
only when it is made: copy it then, or make another.

Better than giving Home Assistant your `API_TOKEN`, which would work too but can
also write, and cannot be taken back without changing it everywhere.

## Alerts into Home Assistant

1. In Home Assistant, make an automation with a **Webhook** trigger. Allow it
   from outside your network (untick *Only accessible from the local network*),
   and note its webhook id. The address it listens on is your Home Assistant's
   public address - through Home Assistant Cloud, for one - followed by
   `/api/webhook/<the webhook id>`, and it must be `https://`.
2. In SolarLens, Settings → **Alerts elsewhere** → *Add a place* → **Webhook**,
   and paste that address.

The automation receives each message as `trigger.json`, with `kind`
(`alert`, `summary` or `test`), `title`, `message`, `url` and `ts` - see
[alerts-elsewhere.md](alerts-elsewhere.md#any-webhook-and-home-assistant). For
example, to pass alerts on as a phone notification:

```yaml
automation:
  - alias: "SolarLens alert"
    trigger:
      - platform: webhook
        webhook_id: !secret solarlens_webhook_id
        allowed_methods: [POST]
        local_only: false
    condition:
      - condition: template
        value_template: "{{ trigger.json.kind == 'alert' }}"
    action:
      - service: notify.notify
        data:
          title: "{{ trigger.json.title }}"
          message: "{{ trigger.json.message }}"
```

The webhook id is the secret in that address, so SolarLens keeps the address
encrypted and shows only its host in Settings.

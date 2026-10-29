/*
  SolarLens, running with no server: the demo on GitHub Pages.

  This script is loaded before the dashboard's own, and answers every request
  the dashboard makes - /api/* and /auth/* - with sample data made up on the
  spot, so the page runs exactly as it does against a real Worker. Nothing here
  came from a real plant: the systems, their names, their curves and their
  history are invented, and "today" is always the viewer's today.

  It is built into the demo by scripts/build-demo.mjs, and the screenshots in
  docs/screenshots/ are taken of it. tests/unit/fixture-contract.test.ts holds
  the shape of its answers to what the real Worker sends, so the demo cannot
  quietly show fields the dashboard no longer gets.
*/
(function () {
  'use strict';

  /** A small repeatable random source, so the demo looks the same each visit on a given day. */
  function random(seed) {
    // mulberry32. Its constants are written in hex: the privacy check reads a
    // long run of decimal digits as a possible plant id, and these are not.
    let s = seed >>> 0 || 1;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    };
  }

  /**
   * Three made-up systems, of the kinds SolarLens reads. `eff` is how well each
   * does for its size: the garage roof is shaded in the afternoon, so on the
   * Compare tab it is the one well below the others - which is the point of
   * Compare, and a demo where every system scored the same would hide it.
   */
  const SYSTEMS = [
    { id: 's1', name: 'South roof', provider: 'soliscloud', source: 'soliscloud-relay', kwp: 12, eff: 1, battery: false, sn: '••••A1F3', model: 'S5-GR3P10K' },
    { id: 's2', name: 'Hybrid, with battery', provider: 'solarman', source: 'solarman-web', kwp: 3.5, eff: 0.93, battery: true, sn: '••••7C20', model: 'Single phase LV Hybrid' },
    { id: 's3', name: 'Garage', provider: 'solarman', source: 'solarman-web', kwp: 5, eff: 0.78, battery: false, sn: '••••9B41', model: 'SUN-5K-G' },
  ];

  /**
   * Where the made-up plants are: wherever it is early afternoon right now.
   *
   * A demo opened at night would show an empty day - true to life, and no use
   * to anyone looking. So the plants' time zone is picked each time to put
   * their clock at about half past one, on the quarter-hour, as real zone
   * offsets are. The dashboard draws each system in its own plant's day, as it
   * does for real, so the curve is always most of a sunny day long.
   */
  const PLANT_CLOCK_S = 13.5 * 3600;
  function plantZone(now) {
    let tz = Math.round((PLANT_CLOCK_S - (now % 86400)) / 900) * 900;
    if (tz > 14 * 3600) tz -= 86400;
    if (tz <= -12 * 3600) tz += 86400;
    return tz;
  }
  /** The plant's calendar for an instant: its own date, read in its own zone. */
  const plantDate = (ts, tz) => new Date((ts + tz) * 1000);

  /**
   * One day's output for one system, in watts, every five minutes from dawn
   * until `until`: a bell from 06:10 to 18:40, with a passing cloud or two.
   */
  function dayCurve(sys, day, until, rnd) {
    const rise = day + 6 * 3600 + 600, set = day + 18 * 3600 + 2400;
    const clouds = [0, 1, 2].map(() => ({ at: rise + rnd() * (set - rise), width: 1200 + rnd() * 3000, depth: 0.25 + rnd() * 0.45 }));
    const pts = [];
    for (let t = rise; t <= Math.min(until, set); t += 300) {
      const x = (t - rise) / (set - rise);
      let w = sys.kwp * sys.eff * 1000 * 0.8 * Math.pow(Math.sin(Math.PI * x), 1.4);
      for (const c of clouds) w *= 1 - c.depth * Math.exp(-(((t - c.at) / c.width) ** 2));
      pts.push({ ts: t, w: Math.max(0, Math.round(w * (0.97 + rnd() * 0.06))) });
    }
    return pts;
  }

  /**
   * What a house with a battery draws at an instant, in watts: a base of 350,
   * breakfast from 07:00 and the evening from 18:00. For the Analysis tab's
   * load against generation.
   */
  function houseLoad(day, t) {
    const h = (t - day) / 3600;
    const bump = (at, width, w) => w * Math.exp(-(((h - at) / width) ** 2));
    return Math.round(350 + bump(7.5, 0.8, 700) + bump(13, 0.6, 450) + bump(19.5, 1.5, 1100));
  }

  const kwhOf = (pts) => pts.reduce((a, p) => a + (p.w * 300) / 3600 / 1000, 0);

  /**
   * The sunlight on a clear day, W/m2, at an instant: the same bell the curves
   * are drawn on, before the clouds. What the demo's "weather" is made of.
   */
  function clearSun(day, t) {
    const rise = day + 6 * 3600 + 600, set = day + 18 * 3600 + 2400;
    if (t <= rise || t >= set) return 0;
    return 1000 * Math.pow(Math.sin((Math.PI * (t - rise)) / (set - rise)), 1.4);
  }

  /** Where the made-up systems stand: one made-up town, to two decimal places. */
  const PLACES = { s1: [52.09, 5.12], s2: [52.1, 5.11], s3: [52.08, 5.13] };
  const r1 = (v) => Math.round(v * 10) / 10;

  /** Every answer the dashboard asks for, made for this moment. */
  function sample(now) {
    const tz = plantZone(now);
    // The plant's midnight, as an instant.
    const day = now - (((now + tz) % 86400) + 86400) % 86400;
    const date = plantDate(now, tz);
    const rnd = random(day / 86400);
    const curves = SYSTEMS.map((s) => dayCurve(s, day, now, rnd));

    // The battery charges through the day and runs the house at night.
    const soc = (t) => {
      const h = (t - day) / 3600;
      return Math.round(h < 7 ? 64 - h * 3 : h < 15 ? Math.min(100, 43 + (h - 7) * 8) : Math.max(35, 100 - (h - 15) * 5));
    };

    const inverters = SYSTEMS.map((s, i) => {
      const pts = curves[i];
      const w = pts.length ? pts[pts.length - 1].w : 0;
      const today = kwhOf(pts);
      const load = s.battery ? houseLoad(day, now) : null;
      const bat = s.battery ? (w > (load ?? 0) ? Math.min(1800, w - load) : -Math.min(900, load - w)) : null;
      return {
        id: s.id, provider: s.provider, serial: s.sn, name: s.name, plant_name: s.name,
        capacity_w: s.kwp * 1000, display_order: i, tz_offset_sec: tz,
        ts: now - 60 - i * 40, source: s.source,
        ac_power_w: w, dc_power_w: w ? Math.round(w * 1.03) : 0, today_kwh: r1(today),
        total_kwh: Math.round(s.kwp * s.eff * 1150 * (2.2 + i)),
        battery_soc: s.battery ? soc(now) : null, battery_power_w: bat,
        grid_power_w: s.battery ? Math.round((load ?? 0) - w + (bat ?? 0)) : -w,
        load_power_w: load, temp_c: s.battery ? null : Math.round(28 + w / 400),
        status: 'online',
        metrics: JSON.stringify({
          genMonthKwh: r1(today + s.kwp * s.eff * 4.1 * (date.getUTCDate() - 1)),
          genYearKwh: Math.round(s.kwp * s.eff * 1150 * ((date.getUTCMonth() + 0.5) / 12)),
          genTotalKwh: Math.round(s.kwp * s.eff * 1150 * (2.2 + i)),
          loadTodayKwh: s.battery ? r1(today * 0.7 + 3.1) : null, loadTotalKwh: s.battery ? 6120 : null,
          gridImportTodayKwh: s.battery ? 1.8 : null, gridExportTodayKwh: s.battery ? r1(today * 0.45) : null,
          gridImportTotalKwh: s.battery ? 3410 : null, gridExportTotalKwh: s.battery ? 4020 : null,
          battChargeTodayKwh: s.battery ? 4.2 : null, battDischargeTodayKwh: s.battery ? 3.6 : null,
          battChargeTotalKwh: s.battery ? 1640 : null, battDischargeTotalKwh: s.battery ? 1510 : null,
          selfUseTodayKwh: s.battery ? r1(today * 0.55) : null, fullLoadHours: r1(today / s.kwp),
          weatherText: 'Partly cloudy', tempMinC: 17, tempMaxC: 26, sunrise: '06:10', sunset: '18:40',
          batteryStatus: s.battery ? (bat > 0 ? 'CHARGING' : 'DISCHARGING') : null,
          gridStatus: s.battery ? 'PURCHASE' : null,
        }),
        alarm_count: s.provider === 'soliscloud' ? 0 : null, alarm_level: s.provider === 'soliscloud' ? 0 : null,
        warning_status: s.provider === 'solarman' ? 'NORMAL' : null, business_warning_status: null,
        consumer_warning_status: null, network_status: s.provider === 'solarman' ? 'NORMAL' : null,
        telemetry: JSON.stringify(s.provider === 'soliscloud'
          ? { power: r1(w / 1000), powerStr: 'kW', state: 1, dayEnergy: r1(today), dayEnergyStr: 'kWh', fullHour: r1(today / s.kwp) }
          : { generationPower: w, usePower: load ?? w, batterySoc: s.battery ? soc(now) : null, networkStatus: 'NORMAL', warningStatus: 'NORMAL' }),
      };
    });

    const points = [];
    SYSTEMS.forEach((s, i) => {
      for (const p of curves[i]) {
        points.push({ inverter_id: s.id, ts: p.ts, ac_power_w: p.w, today_kwh: null, battery_soc: s.battery ? soc(p.ts) : null, grid_power_w: null, load_power_w: s.battery ? houseLoad(day, p.ts) : null, tz_offset_sec: tz });
      }
    });
    points.sort((a, b) => a.ts - b.ts);

    const logger = (s, i) => ({
      id: `${s.id}-datalogger-1`, provider: s.provider, kind: 'datalogger', name: s.provider === 'soliscloud' ? 'S3-WIFI-ST' : 'Datalogger',
      model: s.provider === 'soliscloud' ? 'S3-WIFI-ST' : 'LSW-3', firmware: s.provider === 'soliscloud' ? '10186' : 'MW3_15U_5406_1.20',
      rated_power_w: null, status: 'online', signal_dbm: s.provider === 'soliscloud' ? -61 : null, signal_pct: s.provider === 'solarman' ? 78 - i * 6 : null,
      upload_cycle_s: 300, commissioned_at: day - 400 * 86400, warranty_until: day + 330 * 86400, last_seen: now - 90, strings: null, ac_phases: null,
      frequency_hz: null, power_factor: null, temp_c: null, dc_bus_v: null, battery: null,
      logger: JSON.stringify({ link: 'Wi-Fi', signalLevel: s.provider === 'soliscloud' ? 3 : null, uptimeS: s.provider === 'soliscloud' ? 5 * 86400 + 7200 : null, workingS: s.provider === 'soliscloud' ? 400 * 86400 : null, manufacturedAt: s.provider === 'soliscloud' ? day - 700 * 86400 : null }),
      updated_at: now, plant_id: s.id, sn: `••••${String(3100 + i * 17)}`, alert_status: s.provider === 'solarman' ? -1 : null,
    });
    const devices = SYSTEMS.flatMap((s, i) => {
      const w = inverters[i].ac_power_w;
      const strings = s.kwp >= 5
        ? [{ index: 1, powerW: Math.round(w * 0.52), voltageV: 412, currentA: r1(w * 0.52 / 412) }, { index: 2, powerW: Math.round(w * 0.48), voltageV: 398, currentA: r1(w * 0.48 / 398) }]
        : [{ index: 1, powerW: w, voltageV: 212, currentA: r1(w / 212) }];
      return [{
        id: `${s.id}-inverter-1`, provider: s.provider, kind: 'inverter', name: s.name, model: s.model,
        firmware: s.provider === 'soliscloud' ? '3D0037' : 'V1.1 / V2.3', rated_power_w: s.kwp >= 5 ? s.kwp * 1000 - 2000 : 3500,
        status: 'online', signal_dbm: null, signal_pct: null, upload_cycle_s: null, commissioned_at: day - 400 * 86400,
        warranty_until: s.provider === 'soliscloud' ? day + 3 * 365 * 86400 : null, last_seen: now - 60,
        strings: JSON.stringify(strings), ac_phases: JSON.stringify(s.kwp >= 5
          ? [1, 2, 3].map((index) => ({ index, voltageV: 229 + index, currentA: r1(w / 3 / 230) }))
          : [{ index: 1, voltageV: 231.4, currentA: r1(w / 231) }]),
        frequency_hz: 50.01, power_factor: 0.99, temp_c: inverters[i].temp_c ?? 36, dc_bus_v: s.kwp >= 5 ? 585 : null,
        battery: s.battery ? JSON.stringify({ tempC: 27.5, voltageV: 52.8, currentA: -3.1, bmsTempC: 27.5, bmsVoltageV: 52.6, bmsCurrentA: -3, chargeLimitA: 50, dischargeLimitA: 100, ratedCapacityAh: 200, nominalVoltageV: 51.2, chemistry: 'lithium', status: 'Charging', bmsSocPct: soc(now), bmsChargeVoltageV: 56.8, bmsDischargeVoltageV: 47 }) : null,
        logger: null, updated_at: now, plant_id: s.id, sn: s.sn, alert_status: s.provider === 'solarman' ? -1 : null,
      }, logger(s, i)];
    });

    // A week of each logger's link: steady, but the garage's dropped out one
    // evening for a couple of hours, as Wi-Fi at the far end of a house does.
    const from = now - 7 * 86400;
    const samples = [];
    SYSTEMS.forEach((s, i) => {
      for (let t = from - 600; t <= now; t += 3600) {
        const down = i === 2 && t >= now - 3 * 86400 && t < now - 3 * 86400 + 7200;
        samples.push({
          device_id: `${s.id}-datalogger-1`, ts: t, status: down ? 'offline' : 'online',
          signal_dbm: s.provider === 'soliscloud' ? -61 + Math.round(Math.sin(t / 20000) * 3) : null,
          signal_pct: s.provider === 'solarman' && !down ? 78 - i * 6 + Math.round(Math.sin(t / 30000) * 4) : null,
        });
      }
    });
    samples.sort((a, b) => a.ts - b.ts);

    // Ninety days of history: the season's shape, and each day's own weather.
    const rows = [];
    for (let n = 0; n < 90; n++) {
      const d = plantDate(day - n * 86400, tz);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const sky = 0.45 + 0.55 * random(day / 86400 - n)();
      SYSTEMS.forEach((s) => {
        const y = n === 0 ? kwhOf(curves[SYSTEMS.indexOf(s)]) : s.kwp * s.eff * 4.6 * sky;
        rows.push({
          inverter_id: s.id, day: key, yield_kwh: r1(y), peak_w: Math.round(s.kwp * 1000 * 0.8 * sky),
          load_kwh: s.battery ? r1(y * 0.7 + 3) : null, import_kwh: s.battery ? r1(2.5 - sky) : null,
          export_kwh: s.battery ? r1(y * 0.45) : null, batt_charge_kwh: s.battery ? r1(3 * sky + 1) : null,
          batt_discharge_kwh: s.battery ? r1(3 * sky + 0.6) : null, soc_min: s.battery ? Math.round(30 + 20 * sky) : null, soc_max: s.battery ? 100 : null, samples: 150, first_ts: day - n * 86400 + 6 * 3600, last_ts: day - n * 86400 + 19 * 3600,
        });
      });
    }

    // The vendor's own month and year totals, back to installation.
    const periods = [];
    const year = date.getUTCFullYear();
    SYSTEMS.forEach((s) => {
      for (let y = year - 2; y <= year; y++) {
        periods.push({ inverter_id: s.id, period: 'year', key: String(y), yield_kwh: Math.round(s.kwp * s.eff * (y === year ? 900 : 1150)), load_kwh: null, import_kwh: null, export_kwh: null, charge_kwh: null, discharge_kwh: null, full_hours: y === year ? 900 : 1150, source: s.provider });
        for (let m = 1; m <= (y === year ? date.getUTCMonth() + 1 : 12); m++) {
          const shape = 0.55 + 0.45 * Math.sin((Math.PI * (m - 3)) / 6);
          periods.push({ inverter_id: s.id, period: 'month', key: `${y}-${String(m).padStart(2, '0')}`, yield_kwh: Math.round(s.kwp * s.eff * 96 * shape), load_kwh: null, import_kwh: null, export_kwh: null, charge_kwh: null, discharge_kwh: null, full_hours: Math.round(96 * shape), source: s.provider });
        }
      }
    });

    // Each system's performance ratio is what it makes of the sun: 0.8 for a
    // well-sited roof, less for the shaded garage.
    const hourEnds = [];
    for (let t = day + 3600; t <= now; t += 3600) hourEnds.push(t);
    const expected = SYSTEMS.map((s) => {
      const ratio = Math.round(0.8 * s.eff * 1000) / 1000;
      const hours = hourEnds.map((t) => ({ ts: t, expected_w: Math.round(clearSun(day, t - 1800) * s.kwp * ratio) }));
      const sun = hourEnds.reduce((a, t) => a + clearSun(day, t - 1800) / 1000, 0);
      return { inverter_id: s.id, ratio, learned: true, days: 11, sun_kwh_m2: Math.round(sun * 100) / 100, expected_kwh: Math.round(sun * s.kwp * ratio * 10) / 10, hours };
    });
    const weatherHours = [];
    for (let t = day - 86400 + 3600; t <= now; t += 3600) {
      const d = t > day ? day : day - 86400;
      SYSTEMS.forEach((s) => weatherHours.push({ inverter_id: s.id, ts: t, ghi_wm2: Math.round(clearSun(d, t - 1800) * 0.9), temp_c: 21, cloud_pct: 25 }));
    }

    const alarms = [
      { inverter_id: 's1', provider: 'soliscloud', code: '1015', message: 'Grid voltage out of range', severity: 'warning', vendor_level: 1, advice: 'No action needed if it clears within minutes.', begin_ts: now - 9 * 86400, end_ts: now - 9 * 86400 + 480, state: 'recovered' },
      { inverter_id: 's3', provider: 'solarman', code: '7', message: 'DC voltage low', severity: 'info', vendor_level: 1, advice: null, begin_ts: now - 3 * 86400 + 64800, end_ts: now - 3 * 86400 + 68400, state: 'recovered' },
    ];

    const feeds = [
      { ts: now - 70, provider: 'soliscloud', ok: 1, detail: 'relay: plants=1 inverters=1' },
      { ts: now - 110, provider: 'solarman', ok: 1, detail: 'plants=2 inverters=2 new=2' },
    ];

    // The agents' week, from the same history: last week against the one
    // before, and Garage slowly making less for its sunlight.
    const weekKwh = (from, to) => r1(rows.filter((r) => {
      const n = Math.round((day - Date.parse(`${r.day}T00:00:00Z`) / 1000 - tz) / 86400);
      return n >= from && n <= to;
    }).reduce((a, r) => a + r.yield_kwh, 0));
    const lastWeek = weekKwh(1, 7);
    const weekBefore = weekKwh(8, 14);
    const change = Math.round((lastWeek / weekBefore - 1) * 100);
    const weekOf = plantDate(day - 7 * 86400, tz).toISOString().slice(0, 10);
    const weekWords = new Date(`${weekOf}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const ratios = (base, fall) => Array.from({ length: 12 }, (_, w) => Math.round((base - (w >= 8 ? fall : 0) + 0.01 * Math.sin(w)) * 100) / 100);
    const health = SYSTEMS.map((sys, i) => {
      const weekly = ratios([0.82, 0.79, 0.8][i], i === 2 ? 0.1 : 0);
      const falling = i === 2;
      return {
        kind: 'health', week_of: weekOf, title: `${sys.name}: health`, worded: 'solarlens', flagged: falling, created_at: now - 3 * 3600,
        system: sys.id, name: sys.name, data: { verdict: falling ? 'declining' : 'steady', change_pct: falling ? -12 : 0, recent: weekly[11], earlier: weekly[3], weekly, mondays: [] },
        body: falling
          ? `${sys.name}: for its sunlight it is making 12% less (performance ratio ${weekly[11]} over the last 4 weeks, against ${weekly[3]} in the 8 before) - worth a look for dirt, shade or a string down.`
          : `${sys.name}: steady (performance ratio ${weekly[11]} over the last 4 weeks, against ${weekly[3]} in the 8 before).`,
      };
    });

    return {
      // The demo has no model: SolarLens reads each question itself, as a
      // deployment with none does, and the Ask tab says so.
      '/api/ask/status': { available: false, model: null, provider: null, used: 0, limit: 100, can_ask: true },
      '/api/agents': {
        weekly: {
          kind: 'weekly', week_of: weekOf, title: `Week of ${weekWords}`, worded: 'solarlens', flagged: false, created_at: now - 3 * 3600,
          body: `A made-up week: ${lastWeek} kWh, ${Math.abs(change)}% ${change >= 0 ? 'more' : 'less'} than the week before. ${health[2].body}`,
        },
        health,
      },
      '/api/latest': { now, inverters },
      '/api/series': { from: day, to: now, points },
      '/api/devices': { now, devices },
      '/api/devices/history': { now, days: 7, from, samples },
      '/api/history': { now, days: 90, rows },
      '/api/periods': { now, periods },
      '/api/alarms': { now, days: 3650, alarms },
      '/api/health': { now, polls: feeds, feeds, relays: [{ name: 'Study laptop', state: 'ok', login_expires_at: now + 5 * 86400, last_seen: now - 70, first_seen: now - 60 * 86400, last_ok_at: now - 70 }] },
      '/api/status': { now, feeds: feeds.map((f) => ({ provider: f.provider, ok: f.ok, ts: f.ts })) },
      '/api/expected': { now, systems: expected },
      '/api/weather': { now, days: 2, from: now - 2 * 86400, hours: weatherHours },
      // Invented prices, so the money figures have something to show.
      '/api/settings/tariff': { tariff: { currency: 'EUR', importPrice: 0.28, exportPrice: 0.08, netMetering: false, co2KgPerKwh: 0.35 } },
      // One AI app connected to the MCP server, as Settings lists it.
      '/api/settings/apps': {
        apps: [{ id: 'demo-app', name: 'Claude', redirect_to: 'claude.ai', connected_at: now - 12 * 86400, last_used_at: now - 2 * 3600 }],
        mcp: 'https://your-solarlens.example.com/mcp',
      },
      // One place alerts go, as Settings lists it: a hint of where, never the topic itself.
      '/api/settings/channels': {
        channels: [{ id: 'demo-ntfy', kind: 'ntfy', name: 'Phone', label: 'ntfy.sh · topic …ab', alerts: true, weekly: true,
          created_at: now - 20 * 86400, last_ok_at: now - 3 * 3600, last_error: null, last_error_at: null, failures: 0 }],
        max: 5, ready: true,
      },
      // Two of the invented systems are on the house, one on an outbuilding.
      '/api/settings/groups': { groups: { s1: 'House', s2: 'House', s3: 'Outbuildings' } },
      '/api/locations': { now, locations: SYSTEMS.map((s) => ({ id: s.id, lat: PLACES[s.id][0], lng: PLACES[s.id][1] })) },
      '/auth/status': { configured: true, password: true, passkeys: 1, required: false, role: 'owner', device: 'demo-this' },
      '/auth/settings': {
        password: true, required: false,
        passkeys: [{ id: 'demo-key', name: 'My phone', created_at: now - 40 * 86400, last_used_at: now - 3600 }],
        devices: [
          { id: 'demo-this', role: 'owner', label: 'This browser', created_at: now - 40 * 86400, last_seen_at: now - 60, expires_at: now + 300 * 86400, shared: false, this: true },
          { id: 'demo-tv', role: 'owner', label: 'Chrome on Android', created_at: now - 90 * 86400, last_seen_at: now - 1800, expires_at: now + 280 * 86400, shared: false, this: false },
        ],
        shares: [{ id: 'demo-share', name: 'Family', created_at: now - 7 * 86400, expires_at: now + 23 * 86400, revoked_at: null, devices: 1 }],
      },
    };
  }

  /**
   * What Ask SolarLens answers in the demo, where there is no model: the last
   * seven days from the sample's own history, or - for "Why?" - that day
   * against the fourteen before it. Said to be the demo's, every time.
   */
  function demoAsk(body, now) {
    const data = sample(now);
    const rows = data['/api/history'].rows;
    const period = (days) => ({ from: days[days.length - 1], to: days[0], label: `${days[days.length - 1]} to ${days[0]}` });
    const reply = (question, tool, answer, result) => ({
      question, tool, args: body.args ?? {}, answer, worded: 'solarlens', understood: 'solarlens', kind: 'figures',
      used: 0, limit: 100, model: null, provider: null, result, results: [result],
    });
    const freshness = { newest: now - 60, offline: [] };
    if (body.tool === 'day_report') {
      const sys = SYSTEMS.find((x) => x.name === body.args?.system) ?? SYSTEMS[0];
      const mine = rows.filter((r) => r.inverter_id === sys.id);
      const at = mine.findIndex((r) => r.day === body.args?.date);
      const theDay = mine[at] ?? mine[1];
      const before = mine.slice(at + 1, at + 15).map((r) => r.yield_kwh).sort((a, b) => a - b);
      const usual = before.length ? before[Math.floor(before.length / 2)] : theDay.yield_kwh;
      const share = Math.round((theDay.yield_kwh / usual) * 100);
      const said = `In the demo: ${sys.name} made ${theDay.yield_kwh} kWh on ${theDay.day}, ${share}% of a usual day (${usual} kWh): less sun, with a cloudy afternoon.`;
      return reply(null, 'day_report', said, {
        tool: 'day_report', title: `${theDay.day}, explained`, period: { from: theDay.day, to: theDay.day, label: theDay.day },
        columns: ['System', 'Made (kWh)', 'Usual day (kWh)', 'Of usual (%)'], rows: [[sys.name, theDay.yield_kwh, usual, share]],
        facts: { made_kwh: theDay.yield_kwh, usual_kwh: usual, of_usual_pct: share }, notes: ['A demo answer, from made-up figures.'], summary: said, freshness,
      });
    }
    const days = [...new Set(rows.map((r) => r.day))].sort().reverse().slice(1, 8);
    // Oldest first, as the Worker lists a period's days.
    const perDay = [...days].reverse().map((d) => [d, r1(rows.filter((r) => r.day === d).reduce((a, r) => a + r.yield_kwh, 0))]);
    const total = r1(perDay.reduce((a, [, v]) => a + v, 0));
    const said = `In the demo, every question gets this answer: the three made-up systems made ${total} kWh from ${days[6]} to ${days[0]}. Deployed, the assistant looks up the figures each question needs.`;
    return reply(String(body.question ?? ''), 'energy', said, {
      tool: 'energy', title: 'Energy per day', period: period(days), columns: ['Day', 'Made (kWh)'], rows: perDay,
      facts: { total_made_kwh: total }, notes: ['A demo answer, from made-up figures.'], summary: said, freshness,
    });
  }

  /**
   * A graph in the demo: today's power made by the three systems, each one's
   * average in the hour added together, against the hybrid's house load - the
   * Worker's chart result, which the page draws as it draws a real one.
   */
  function demoChart(now) {
    const tz = plantZone(now);
    const iso = plantDate(now, tz).toISOString().slice(0, 10);
    const hours = new Map();
    for (const p of sample(now)['/api/series'].points) {
      const h = Math.floor(((((p.ts + tz) % 86400) + 86400) % 86400) / 3600);
      const at = hours.get(h) ?? { power: new Map(), load: [] };
      at.power.set(p.inverter_id, [...(at.power.get(p.inverter_id) ?? []), p.ac_power_w]);
      if (p.load_power_w != null) at.load.push(p.load_power_w);
      hours.set(h, at);
    }
    const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
    const kw = (w) => Math.round(w / 10) / 100;
    const rows = [...hours.keys()].sort((a, b) => a - b).map((h) => [
      `${String(h).padStart(2, '0')}:00`,
      kw([...hours.get(h).power.values()].reduce((a, xs) => a + mean(xs), 0)),
      hours.get(h).load.length ? kw(mean(hours.get(h).load)) : null,
    ]);
    const top = rows.reduce((a, r) => (r[1] > a[1] ? r : a), rows[0] ?? ['06:00', 0, null]);
    const said = `In the demo, every graph is this one: today's power made by the three made-up systems against the hybrid's house load, hour by hour - highest ${top[1]} kW at ${top[0]}. Deployed, the assistant draws the measure and the time you ask for.`;
    return {
      tool: 'chart', title: 'Power made and house load, hour by hour', period: { from: iso, to: iso, label: `today (${iso})` },
      columns: ['Time', 'Power made (kW)', 'House load (kW)'], rows,
      facts: { points: rows.length, power_highest: top[1], power_highest_at: top[0] },
      notes: ['A demo answer, from made-up figures.'], summary: said, freshness: { newest: now - 60, offline: [] },
      chart: { kind: 'line', columns: [1, 2] },
    };
  }

  /**
   * An analysis in the demo, of its own made-up week: what each system made and
   * how it stands for its sunlight, the systems per kWp, the hybrid's house and
   * battery, and the week's fault - in the shape the Worker's analysis answers,
   * what needs a look first, with what to do.
   */
  function demoAnalysis(now) {
    const data = sample(now);
    const rows = data['/api/history'].rows;
    const health = data['/api/agents'].health;
    const r2 = (v) => Math.round(v * 100) / 100;
    const hh = (h) => `${String(h).padStart(2, '0')}:00`;
    // The last seven whole days: today is still being made.
    const days = [...new Set(rows.map((r) => r.day))].sort().reverse().slice(1, 8);
    const week = (s) => rows.filter((r) => r.inverter_id === s.id && days.includes(r.day));
    const found = [];
    SYSTEMS.forEach((s, i) => {
      const mine = week(s);
      const total = mine.reduce((a, r) => a + r.yield_kwh, 0);
      const falling = health[i].data.verdict === 'declining';
      found.push({
        stands: falling ? 'Needs a look' : 'Fine', area: 'Production',
        said: `${s.name} made ${Math.round(total)} kWh over ${mine.length} whole days, ${r1(total / mine.length)} kWh on an average day; for its sunlight it is `
          + `${falling ? `making ${Math.abs(health[i].data.change_pct)}% less over the last 4 weeks than in the 8 before` : 'steady'}.`,
        todo: falling ? `Look at ${s.name}'s panels for dirt or new shade, and at its strings for one down: cleaning often brings the output back.` : null,
      });
    });
    const per = SYSTEMS.map((s) => ({ s, v: week(s).reduce((a, r) => a + r.yield_kwh, 0) / week(s).length / s.kwp })).sort((a, b) => b.v - a.v);
    const gap = Math.round((1 - per[per.length - 1].v / per[0].v) * 100);
    found.push({
      stands: gap >= 25 ? 'Needs a look' : 'Worth knowing', area: 'Systems compared',
      said: `Per kWp of panels, ${per[per.length - 1].s.name} made ${gap}% less than ${per[0].s.name} on an average whole day (${r2(per[per.length - 1].v)} against ${r2(per[0].v)} kWh per kWp).`,
      todo: `If the two face the same way under the same sky, look for shade, dirt or a string down on ${per[per.length - 1].s.name}; a different tilt or direction explains some of it.`,
    });
    // The hybrid's house, hour by hour, from the demo's own house: its always-on load and its evening.
    const hybrid = SYSTEMS.find((s) => s.battery);
    const hours = Array.from({ length: 24 }, (_, h) => [0, 1, 2].reduce((a, k) => a + houseLoad(0, h * 3600 + k * 1200), 0) / 3);
    const base = Math.min(...hours);
    const peakAt = hours.indexOf(Math.max(...hours));
    const share = Math.round((base / (hours.reduce((a, w) => a + w, 0) / 24)) * 100);
    found.push({
      stands: 'Worth knowing', area: 'The house',
      said: `${hybrid.name}'s house never draws less than about ${Math.round(base)} W on an average day - ${r1((base * 24) / 1000)} kWh a day, ${share}% of what it uses - and draws most at ${hh(peakAt)} (${r2(hours[peakAt] / 1000)} kW), when the sun is down.`,
      todo: 'Find what is always on - an old fridge or freezer, a water pump or heater, devices left on standby: every 100 W on all day is 2.4 kWh a day.',
    });
    const battery = week(hybrid);
    const lows = battery.map((r) => r.soc_min).sort((a, b) => a - b);
    found.push({
      stands: 'Fine', area: 'The battery',
      said: `${hybrid.name}'s battery went between ${lows[0]}% and 100% - down to ${lows[Math.floor(lows.length / 2)]}% on a typical day - and was full on ${battery.length} of ${battery.length} days `
        + `and gave out ${r1(battery.reduce((a, r) => a + r.batt_discharge_kwh, 0))} kWh: it is being used.`,
      todo: null,
    });
    found.push({ stands: 'Worth knowing', area: 'Faults', said: '1 fault was recorded and none is still active.', todo: null });
    const order = ['Needs a look', 'Worth knowing', 'Fine'];
    found.sort((a, b) => order.indexOf(a.stands) - order.indexOf(b.stands));
    const count = (w) => found.filter((f) => f.stands === w).length;
    const todos = [...new Set(found.map((f) => f.todo).filter(Boolean))];
    const label = `the last 7 days (${days[6]} to ${days[0]})`;
    return {
      tool: 'analysis', title: 'Analysis', period: { from: days[6], to: days[0], label },
      columns: ['How it stands', 'Area', 'What stands out', 'What to do'], rows: found.map((f) => [f.stands, f.area, f.said, f.todo]),
      facts: { needs_a_look: count('Needs a look'), worth_knowing: count('Worth knowing'), fine: count('Fine') },
      notes: ['A demo analysis, from made-up figures.'],
      summary: [`In the demo, every analysis is this one, of the made-up systems over ${label}: ${count('Needs a look')} thing to look at, ${count('Worth knowing')} worth knowing.`,
        ...found.map((f) => `- ${f.said}`), 'What to do:', ...todos.map((t) => `- ${t}`)].join('\n'),
      freshness: { newest: now - 60, offline: [] },
      sections: [demoChart(now), demoAsk({ question: '' }, now).result],
    };
  }

  /**
   * The assistant in the demo, where there is no model: an analysis, a report,
   * a word on using the app, a graph of today, or the last seven days - each
   * from the sample's own made-up figures, said to be the demo's, and in the
   * shape the Worker answers.
   */
  function demoChat(body, now) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const question = String(messages[messages.length - 1]?.content ?? '').toLowerCase();
    const week = demoAsk({ question }, now);
    const reply = (kind, answer, results, calls) => ({
      answer, worded: 'solarlens', understood: 'solarlens', kind, calls, results, errors: [], used: 0, limit: 100, model: null, provider: null,
    });
    // An analysis first, as the Worker reads it: "how can I improve" is not how to use the app.
    if (/\b(analy\w*|insights?|improve|recommend\w*|suggest\w*|advice|what should (i|we) do|how (is|are) (my|the|our) (solar|system|systems)s? doing)\b/.test(question)) {
      const analysis = demoAnalysis(now);
      return reply('report', analysis.summary, [analysis], [{ tool: 'analysis', args: {} }]);
    }
    if (/\b(how (do|can|to)|where|set ?up|turn on|enable|connect)\b/.test(question)) {
      const said = 'In the demo, the guide answers questions like this one: open Settings (the gear) and look for the card named after what you want - Alerts elsewhere for Telegram or Discord, Home Assistant, Connected apps for Claude.';
      return reply('help', said, [{
        tool: 'app_help', title: 'In SolarLens', period: null, columns: ['Topic', 'How', 'Where'],
        rows: [['Alerts on ntfy, Telegram, Discord or a webhook', 'Settings → Alerts elsewhere → Add a place.', '#/settings']],
        facts: {}, notes: ['A demo answer.'], summary: said, freshness: { newest: null, offline: [] },
      }], [{ tool: 'app_help', args: { question } }]);
    }
    if (/\b(graph|chart|plot|draw|visuali[sz]e|which hours?|what time|peak)\b/.test(question)) {
      const chart = demoChart(now);
      return reply('figures', chart.summary, [chart], [{ tool: 'chart', args: { metric: 'power', versus: 'load', range: 'today', every: 'hour' } }]);
    }
    if (/\breport\b|\bsummar/.test(question)) {
      const energy = week.result;
      const said = `In the demo, every report is this one: the three made-up systems made ${energy.facts.total_made_kwh} kWh over the seven days shown, with no faults. Deployed, a report covers the period you ask for, and every figure comes from your own systems.`;
      return reply('report', said, [{
        tool: 'report', title: 'Report', period: energy.period, columns: ['', 'Figure'],
        rows: [['Made (kWh)', energy.facts.total_made_kwh], ['Faults', '0'], ['Health', 'Garage: declining']],
        facts: { total_made_kwh: energy.facts.total_made_kwh }, notes: ['A demo report, from made-up figures.'], summary: said, freshness: energy.freshness,
        sections: [energy],
      }], [{ tool: 'report', args: {} }]);
    }
    return reply('figures', week.answer, [week.result], [{ tool: 'energy', args: {} }]);
  }

  const api = { sample, SYSTEMS, demoAsk, demoChat };
  if (typeof globalThis !== 'undefined') globalThis.SolarLensDemo = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ---------------------------------------------------------------- in the browser

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = window.fetch.bind(window);

  /**
   * Answer the dashboard's requests. Reads come from sample(); writes are
   * accepted and change nothing, which the banner says; the page's own address
   * is answered "not found", so the new-version check has nothing to compare.
   */
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^.*?(\/(?:api|auth)\/)/, '$1');
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (!/^\/(api|auth)\//.test(path)) {
      if (url.origin === location.origin && (url.pathname === '/' || url.pathname === location.pathname)) return new Response('', { status: 404 });
      return realFetch(input, init);
    }
    if (path === '/api/push/key') return json({ error: 'notifications are not part of the demo' }, 404);
    if (method !== 'GET') {
      // The tariff and groups forms expect what was kept back; they get the demo's own, unchanged.
      if (path === '/api/settings/tariff' || path === '/api/settings/groups') return json(sample(Math.floor(Date.now() / 1000))[path]);
      if (path === '/api/settings/summary') return json({ sent: 1, of: 1 });
      if (path === '/api/chat') {
        let body = {};
        try { body = JSON.parse(init.body || (typeof input === 'object' && input.body) || '{}'); } catch { body = {}; }
        return json(demoChat(body, Math.floor(Date.now() / 1000)));
      }
      if (path === '/api/ask') {
        let body = {};
        try { body = JSON.parse(init.body || (typeof input === 'object' && input.body) || '{}'); } catch { body = {}; }
        return json(demoAsk(body, Math.floor(Date.now() / 1000)));
      }
      return json({ ok: true, required: false, signedOut: 1, id: 'demo', url: `${location.origin}${location.pathname}#/`, password: true });
    }
    const answers = sample(Math.floor(Date.now() / 1000));
    const key = Object.keys(answers).find((k) => path === k || path.startsWith(`${k}?`));
    return key ? json(answers[key]) : json({ error: 'not in the demo' }, 404);
  };

  /** A strip above the page: this is a demo, with made-up data, and where the real thing is. */
  function banner() {
    if (document.getElementById('demo-banner')) return;
    const b = document.createElement('div');
    b.id = 'demo-banner';
    b.setAttribute('role', 'note');
    b.innerHTML = 'A demo with made-up data: three invented systems, somewhere it is always early afternoon. '
      + 'Nothing you change here is saved. <a href="https://github.com/muhammadmobi/SolarLens">SolarLens on GitHub</a>';
    const style = document.createElement('style');
    style.textContent = '#demo-banner{background:var(--ink);color:var(--bg);font:600 13px/1.45 var(--font,system-ui);padding:8px 16px;text-align:center}'
      + '#demo-banner a{color:inherit;text-decoration:underline;margin-left:6px}#demo-banner a:focus-visible{outline:2px solid var(--bg);outline-offset:2px}';
    document.head.appendChild(style);
    document.body.prepend(b);
  }
  if (document.body) banner(); else document.addEventListener('DOMContentLoaded', banner);
})();

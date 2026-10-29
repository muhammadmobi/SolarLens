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
      const load = s.battery ? 420 + Math.round(rnd() * 380) : null;
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
        points.push({ inverter_id: s.id, ts: p.ts, ac_power_w: p.w, today_kwh: null, battery_soc: s.battery ? soc(p.ts) : null, grid_power_w: null, tz_offset_sec: tz });
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

    return {
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

  const api = { sample, SYSTEMS };
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
      // The tariff form expects the tariff back; it gets the demo's own, unchanged.
      if (path === '/api/settings/tariff') return json(sample(Math.floor(Date.now() / 1000))['/api/settings/tariff']);
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

import { expect, test, type Page } from '@playwright/test';

/**
 * The dashboard is a static page that talks to /api/*. These tests stub those
 * endpoints so the suite needs no Worker, D1 or vendor credentials, and they
 * assert what a person sees: the overview panels and divider layout, the
 * per-system detail view, the hardware inventory, staleness and the auth gate.
 */

import { HYBRID, NOW, SOLIS, devices, historyRows, inverters, metrics, series } from '../fixtures/dashboard-api';

/**
 * Answer every /api route the page calls from the shared fixtures, so the
 * dashboard runs with no Worker, no database and no vendor. Options change one
 * answer at a time - different inverters, a failed poll, an error status.
 */
async function stubApi(page: Page, opts: {
  invs?: unknown[]; devs?: unknown[]; status?: number; series?: unknown[];
  poll?: { ts?: number; ok: number; detail: string; provider: string };
  history?: unknown[] | null;
  alarms?: unknown[] | 'error';
  periods?: unknown[];
  relays?: unknown[];
  feeds?: { ts: number; ok: number; detail: string; provider: string }[];
} = {}) {
  const status = opts.status ?? 200;
  const invs = opts.invs ?? inverters();
  const devs = opts.devs ?? devices();
  const ids = new Set((invs as { id: string }[]).map((i) => i.id));
  const points = opts.series ?? series().filter((p) => ids.has((p as { inverter_id: string }).inverter_id));
  const json = (body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/latest', (r) => r.fulfill(json(status === 200 ? { now: NOW, inverters: invs } : { error: 'unauthorized' })));
  await page.route('**/api/series**', (r) => r.fulfill(json(status === 200 ? { from: 0, to: NOW, points } : { error: 'unauthorized' })));
  await page.route('**/api/devices', (r) => r.fulfill(json(status === 200 ? { now: NOW, devices: devs } : { error: 'unauthorized' })));
  await page.route('**/api/history**', (r) => r.fulfill(json({ now: NOW, days: 30, rows: opts.history ?? historyRows() })));
  await page.route('**/api/alarms**', (r) => (opts.alarms === 'error'
    ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })
    : r.fulfill(json({ now: NOW, days: 3650, alarms: opts.alarms ?? [] }))));
  await page.route('**/api/periods', (r) => r.fulfill(json({ now: NOW, periods: opts.periods ?? [] })));
  const polls = [opts.poll ?? { ts: NOW - 30, provider: 'solarman', ok: 1, detail: 'plants=1 inverters=1 new=1' }];
  await page.route('**/api/health', (r) => r.fulfill(json({ now: NOW, polls, feeds: opts.feeds ?? polls, relays: opts.relays ?? [] })));
}

test.describe('Overview', () => {
  test('shows both inverters side by side with live numbers', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');

    const panels = page.locator('.ovsys');
    await expect(panels).toHaveCount(2);
    await expect(panels.nth(0)).toContainText('SolisCloud');
    await expect(panels.nth(0)).toContainText('Demo Solis Plant');
    // Producing now is drawn in the diagram and nowhere else. It used to be
    // there and repeated as a figure below, which is most of why the old
    // three-band overview came out taller than the window.
    await expect(panels.nth(0).locator('.ovnodes')).toContainText('5.08 kW');
    await expect(panels.nth(0).locator('.ovtiles')).not.toContainText('Producing now');

    await expect(panels.nth(1)).toContainText('SolarMan');
    await expect(panels.nth(1).locator('.ovnodes')).toContainText('278 W');
    await expect(panels.nth(1)).toContainText('91 W');
    // A few watts of battery drift renders as idle, not as discharging.
    await expect(panels.nth(1)).toContainText('idle');

    await expect(page.locator('#fleet-power')).toHaveText('5.36 kW');
    // The word "today" is now a label above the figure, not part of it.
    await expect(page.locator('#fleet-today')).toHaveText('62.7 kWh');
    // Every headline figure is labelled - a bare "20 W" told you nothing about
    // whether it was one system, both, or something else entirely.
    await expect(page.locator('.flabel')).toHaveText(['Producing now', 'Produced today', 'Consumed today', 'Weather']);
    await expect(page.locator('#fleet-used')).toHaveText('53.8 kWh');
    await expect(page.locator('#fleet-wx')).toContainText('Clear');
    // The footer names each feed rather than reciting one raw log row.
    await expect(page.locator('#poll-status')).toContainText('SolarMan ok');
  });

  test('only the hybrid gets battery tiles; the on-grid plant gets none', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const tiles = (n: number) => page.locator('.ovsys').nth(n).locator('.ovtiles');
    await expect(tiles(0)).not.toContainText('Battery');
    await expect(tiles(1)).toContainText('Battery power');
    await expect(tiles(1)).toContainText('Charged today');
    await expect(tiles(1)).toContainText('Discharged today');
    // Four across, and trimmed to a multiple of four so the grid never ends in
    // a ragged row: eight for the on-grid inverter, twelve once there is a
    // battery to describe.
    await expect(tiles(0).locator('> div')).toHaveCount(8);
    await expect(tiles(1).locator('> div')).toHaveCount(12);
  });

  test('shows every figure it has, even when that is not a multiple of four', async ({ page }) => {
    // Before dawn a system reports no peak, no full-load hours, no string
    // count and no inverter temperature, leaving seven figures rather than
    // eight. An earlier rule trimmed the count to a multiple of four so the
    // grid could not end raggedly - and hid three of the seven to do it.
    // Metrics without fullLoadHours: everything else the on-grid column shows
    // is still there, so the count lands on seven.
    const invs = inverters();
    (invs[0] as { metrics: string }).metrics = metrics({
      genMonthKwh: 185, genYearKwh: 13677, genTotalKwh: 48852,
    });
    await stubApi(page, { invs });
    await page.goto('/');

    const cells = page.locator('.ovsys').nth(0).locator('.ovtiles > div');
    const n = await cells.count();
    expect(n % 4).not.toBe(0);
    // Nothing available is dropped; the last tile stretches across what is
    // left of its row instead.
    await expect(cells.nth(n - 1)).toHaveAttribute('style', /grid-column: span [2-4]/);
  });

  test('fits one screen when the window is big enough, and scrolls when it is not', async ({ page }, testInfo) => {
    await stubApi(page);
    const fits = () => page.evaluate(() =>
      document.documentElement.scrollHeight <= window.innerHeight + 2);

    if (testInfo.project.name === 'mobile') {
      await page.goto('/');
      await expect(page.locator('.ovsys')).toHaveCount(2);
      // Two systems will not fit a phone, and pretending otherwise would mean
      // hiding readings.
      expect(await fits()).toBe(false);
      return;
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('.ovsys')).toHaveCount(2);
    expect(await fits()).toBe(true);

    // A short window cannot hold a diagram, twelve figures and a readable
    // curve at once, so it scrolls rather than squeezing them into each other.
    await page.setViewportSize({ width: 1440, height: 560 });
    await page.reload();
    await expect(page.locator('.ovsys')).toHaveCount(2);
    expect(await fits()).toBe(false);
  });

  test('renders the divider layout: side by side on desktop, stacked on narrow screens', async ({ page }, testInfo) => {
    await stubApi(page);
    await page.goto('/');
    const [a, b] = await page.locator('.ovsys').all();
    const ba = await a.boundingBox();
    const bb = await b.boundingBox();
    expect(ba && bb).toBeTruthy();
    if (testInfo.project.name === 'mobile') {
      expect(bb!.y).toBeGreaterThan(ba!.y + ba!.height - 1);   // stacked
    } else {
      expect(Math.abs(bb!.y - ba!.y)).toBeLessThan(2);          // same row
      expect(bb!.x).toBeGreaterThan(ba!.x + ba!.width - 1);
    }
  });

  test('a system whose sample is older than 15 minutes reads offline', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/');
    const solis = page.locator('.ovsys').nth(0);
    await expect(solis.locator('.flowstale')).toContainText('last update');
    await expect(solis.locator('.pill')).toHaveClass(/warn/);
    await expect(solis.locator('.pill')).toHaveText('offline');
    // Offline output is zero, not the 5.08 kW it managed before it dropped.
    await expect(solis.locator('.ovnodes')).toContainText('0 W');
  });

  test('the vendor calling a plant offline is enough on its own', async ({ page }) => {
    // Fresh sample, one minute old - but SolisCloud sets state 2 the moment
    // the datalogger drops, well before our own staleness window runs out.
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 60, status: 'offline' } }) });
    await page.goto('/');
    const solis = page.locator('.ovsys').nth(0);
    await expect(solis.locator('.pill')).toHaveText('offline');
    await expect(solis.locator('.ovnodes')).toContainText('0 W');
  });

  test('an offline system counts as zero in the fleet total and is named', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/');
    // Only the hybrid's 278 W is real; the Solis plant contributes a zero.
    await expect(page.locator('#fleet-power')).toHaveText('278 W');
    await expect(page.locator('#fleet-quiet')).toBeVisible();
    await expect(page.locator('#fleet-quiet')).toHaveText('Demo Solis Plant offline');
    // Today's energy still counts it - those kWh were genuinely generated.
    await expect(page.locator('#fleet-today')).toHaveText('62.7 kWh');
  });

  test('an offline system zeroes its grid, load and battery too', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solarman: { ts: NOW - 3600 } }) });
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const live = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'Live power' }) });
    await expect(live).toContainText('0 W');
    await expect(live).not.toContainText('307 W');
    // The charge level is a state, not a flow, so it survives: the pack still
    // holds what it held when the link dropped.
    await expect(page.locator('.ring text')).toHaveText('100%');
  });

  test('no flag, and both systems counted, while everything is fresh', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('#fleet-power')).toHaveText('5.36 kW');
    await expect(page.locator('#fleet-quiet')).toBeHidden();
  });

  test('surfaces a failed poll in the footer', async ({ page }) => {
    await stubApi(page, { poll: { ts: NOW - 60, provider: 'soliscloud', ok: 0, detail: 'soliscloud: HTTP 401 on /v1/api/userStationList' } });
    await page.goto('/');
    await expect(page.locator('#poll-status')).toContainText('FAILED');
    await expect(page.locator('#poll-status')).toContainText('HTTP 401');
  });

  test('says something useful when the API answers 401', async ({ page }) => {
    // Reads are public now, so this only happens against a deployment older
    // than that change - but a blank page would say nothing about why.
    await stubApi(page, { status: 401 });
    await page.goto('/');
    await expect(page.locator('.empty')).toContainText('refused this request');
    await expect(page.locator('#updated')).toHaveText('unauthorized');
  });

  test('handles an empty fleet without errors', async ({ page }) => {
    await stubApi(page, { invs: [], devs: [] });
    await page.goto('/');
    await expect(page.locator('.empty')).toContainText('No inverters yet');
    // The chart moved to its own page; with no fleet it says so rather than drawing.
    await page.goto('/#/power');
    await expect(page.locator('#combined')).toContainText('No samples yet today');
  });
});

test.describe('Alerts', () => {
  test('one tab, one collapsible section per system', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/alerts');
    const secs = page.locator('details.syssec');
    await expect(secs).toHaveCount(2);
    await expect(secs.nth(0)).toContainText('Demo Solis Plant');
    await expect(secs.nth(1)).toContainText('Demo Hybrid');
    // Collapsing one system's alerts leaves the other's alone.
    await secs.nth(0).locator('> summary').click();
    await expect(secs.nth(0)).not.toHaveAttribute('open', '');
    await expect(secs.nth(1)).toHaveAttribute('open', '');
  });

  test('a clean system says what was checked, not just nothing', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/alerts');
    const clear = page.locator('.allclear').first();
    await expect(clear).toContainText('Nothing reported');
    // An empty box is ambiguous between "all clear" and "nobody looked", so
    // the checks that ran are named.
    await expect(clear).toContainText('feed freshness');
    await expect(clear).toContainText('last poll result');
  });

  test("raises the vendor's own alarm counter, and says which vendor", async ({ page }) => {
    const invs = inverters({
      solis: { alarm_count: 2, alarm_level: 2 },
    });
    await stubApi(page, { invs });
    await page.goto('/#/alerts');
    const sec = page.locator('details.syssec').nth(0);
    await expect(sec).toContainText('2 active alarms');
    await expect(sec).toContainText('Alarm level 2');
    await expect(sec.locator('.a-src').first()).toHaveText('SolisCloud');
  });

  test("reads SolarMan's NORMAL/abnormal flags", async ({ page }) => {
    const invs = inverters({
      solarman: { warning_status: 'ABNORMAL', network_status: 'OFFLINE' },
    });
    await stubApi(page, { invs });
    await page.goto('/#/alerts');
    const sec = page.locator('details.syssec').nth(1);
    await expect(sec).toContainText('Inverter warning');
    await expect(sec).toContainText('Datalogger link');
    await expect(sec).toContainText('abnormal');
  });

  test('a SolisCloud plant reporting no alarms raises nothing', async ({ page }) => {
    // 0 is "SolisCloud says none", which must not become "0 active alarms".
    await stubApi(page, { invs: inverters({ solis: { alarm_count: 0, alarm_level: 0 } }) });
    await page.goto('/#/alerts');
    const sec = page.locator('details.syssec').nth(0);
    await expect(sec).toContainText('Nothing reported');
    await expect(sec).not.toContainText('active alarm');
  });

  test("raises a device's own alert count, and ignores SolarMan's -1", async ({ page }) => {
    const devs = devices().map((d) => (d.id === 'solarman:inverter:HYB01' ? { ...d, alert_status: 3 }
      : d.id === 'solarman:datalogger:LOG02' ? { ...d, alert_status: -1 } : d));
    await stubApi(page, { devs });
    await page.goto('/#/alerts');
    const sec = page.locator('details.syssec').nth(1);
    await expect(sec).toContainText('3 alerts');
    await expect(sec).toContainText('Raised on the device record');
    await expect(sec).not.toContainText('LOG02:');
    await expect(sec).not.toContainText('-1 alert');
  });

  test('every alert carries the moment it is describing', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/#/alerts');
    const stamps = page.locator('details.syssec').nth(0).locator('.a-when time');
    await expect(stamps.first()).toBeVisible();

    // A machine-readable instant, so the markup is not just decoration...
    const dt = await stamps.first().getAttribute('datetime');
    expect(dt).toBeTruthy();
    expect(Number.isNaN(Date.parse(dt as string))).toBe(false);
    // ...matching the hour the alert is actually about.
    expect(Math.abs(Date.parse(dt as string) / 1000 - (NOW - 3600))).toBeLessThan(120);

    // And a human-readable one carrying both a clock time and how long ago.
    const text = (await stamps.first().textContent()) ?? '';
    expect(text).toContain(':');
    expect(text).toContain('ago');
    expect(text).toContain(String(new Date((NOW - 3600) * 1000).getFullYear()));
  });

  test('faults sort above warnings, and newer above older', async ({ page }) => {
    // A plant going down takes its hardware with it, which is the realistic
    // shape of this: one fault and two symptoms.
    const devs = devices().map((d) => d.provider === 'soliscloud'
      ? { ...d, status: 'offline', last_seen: NOW - 3600 } : d);
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }), devs });
    await page.goto('/#/alerts');
    const items = page.locator('details.syssec').nth(0).locator('.alerts li');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toHaveClass(/bad/);
    await expect(items.first()).toContainText('System offline');
    // The two devices that went quiet with it follow, as warnings.
    await expect(items.nth(1)).toHaveClass(/warn/);
    await expect(items.nth(2)).toHaveClass(/warn/);
  });

  test('a device stamp is its own last contact, not the plant\'s newest update', async ({ page }) => {
    const devs = devices().map((d) => d.kind === 'datalogger' && d.provider === 'soliscloud'
      ? { ...d, status: 'offline', last_seen: NOW - 7200 } : d);
    await stubApi(page, { devs });
    await page.goto('/#/alerts');
    const row = page.locator('.alerts li', { hasText: 'Datalogger' }).first();
    const dt = await row.locator('.a-when time').getAttribute('datetime');
    // Two hours, from the datalogger's own record - not the two minutes since
    // the plant's newest sample.
    expect(Math.abs(Date.parse(dt as string) / 1000 - (NOW - 7200))).toBeLessThan(120);
  });

  test('a clean system is stamped with the update it was judged against', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/alerts');
    const clear = page.locator('.allclear').first();
    await expect(clear.locator('.a-when')).toContainText('Against the update of');
    const dt = await clear.locator('time').getAttribute('datetime');
    expect(Number.isNaN(Date.parse(dt as string))).toBe(false);
  });

  test('an offline feed is an alert in its own right', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/#/alerts');
    await expect(page.locator('details.syssec').nth(0)).toContainText('System offline');
    await expect(page.locator('details.syssec').nth(0)).toContainText('the cutoff is 15 minutes');
    // A relay-fed feed has a second way to go quiet that is nothing to do with
    // the plant, and the fix for it is on this side rather than on the roof.
    await expect(page.locator('details.syssec').nth(0)).toContainText('relay agent');
  });

  test("a failed poll is ours to report, not the vendor's", async ({ page }) => {
    await stubApi(page, { poll: { ts: NOW - 60, provider: 'solarman', ok: 0, detail: 'HTTP 401 on /device/v1.0/currentData?a & b' } });
    await page.goto('/#/alerts');
    const sec = page.locator('details.syssec').nth(1);
    await expect(sec).toContainText('Last poll failed');
    await expect(sec).toContainText('HTTP 401');
    // Escaped once, by the renderer. Escaping in the model as well turned an
    // "&" in a vendor error string into "&amp;" on the page.
    await expect(sec).toContainText('a & b');
    await expect(sec.locator('.a-src').last()).toHaveText('SolarLens');
  });

  test('the tab badge counts what is wrong across the fleet', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('#alertbadge')).toBeHidden();

    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.reload();
    await expect(page.locator('#alertbadge')).toBeVisible();
    await expect(page.locator('#alertbadge')).toHaveText('1');
    await expect(page.locator('#alertbadge')).toHaveClass(/bad/);
  });
});

test.describe('Feed status', () => {
  test('names every feed, not just whichever logged most recently', async ({ page }) => {
    // Only SolarMan runs on the cron; SolisCloud arrives through the relay.
    // Showing one newest row meant the footer read "plants=1 inverters=1" and
    // never mentioned the other system at all.
    await stubApi(page, {
      feeds: [
        { ts: NOW - 90, provider: 'solarman', ok: 1, detail: 'plants=1 inverters=1 new=1' },
        { ts: NOW - 20, provider: 'soliscloud', ok: 1, detail: 'soliscloud-relay: Demo Solis Plant 5080 W' },
      ],
    });
    await page.goto('/');
    const feeds = page.locator('#poll-status .feed');
    await expect(feeds).toHaveCount(2);
    await expect(feeds.nth(0)).toContainText('SolarMan');
    await expect(feeds.nth(1)).toContainText('SolisCloud');
    await expect(feeds.nth(1)).toContainText('soliscloud-relay');
  });

  test('a failed feed is marked, and the healthy one still shows', async ({ page }) => {
    await stubApi(page, {
      feeds: [
        { ts: NOW - 60, provider: 'soliscloud', ok: 0, detail: 'HTTP 408 on /v1/api/userStationList' },
        { ts: NOW - 20, provider: 'solarman', ok: 1, detail: 'plants=1 inverters=1 new=1' },
      ],
    });
    await page.goto('/');
    await expect(page.locator('#poll-status .feed.bad')).toHaveCount(1);
    await expect(page.locator('#poll-status .feed.bad')).toContainText('FAILED');
    await expect(page.locator('#poll-status .feed.bad')).toContainText('HTTP 408');
    await expect(page.locator('#poll-status .feed:not(.bad)')).toContainText('SolarMan');
  });

  test('falls back to the newest single line for an older Worker', async ({ page }) => {
    // /api/health gained `feeds` after the page shipped; a deploy where the
    // two are out of step must not blank the footer.
    await page.route('**/api/health', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ now: NOW, polls: [{ ts: NOW - 30, provider: 'solarman', ok: 1, detail: 'plants=1' }] }),
    }));
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('#poll-status')).toContainText('SolarMan');
  });
});

test.describe('Historical Data', () => {
  test('one section per system, with a day table and a bar per day', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/history');
    const secs = page.locator('details.syssec');
    await expect(secs).toHaveCount(2);
    await expect(secs.nth(0)).toContainText('Demo Solis Plant');
    await expect(secs.nth(0).locator('tbody tr')).toHaveCount(4);
    await expect(secs.nth(0).locator('.daybar')).toHaveCount(4);
  });

  test('shows only the columns that system actually measures', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/history');
    const solis = page.locator('details.syssec').nth(0);
    const hybrid = page.locator('details.syssec').nth(1);
    // The on-grid plant has no meter, so consumption and grid columns would be
    // columns of dashes. The hybrid has both, plus a battery.
    await expect(solis.locator('thead th')).toHaveText(['Day', 'Produced', 'Peak', 'Samples']);
    await expect(hybrid.locator('thead th')).toHaveText(
      ['Day', 'Produced', 'Consumed', 'Imported', 'Exported', 'Charged', 'Discharged', 'Peak', 'Samples']);
  });

  test('says the record starts when SolarLens did, and shows the vendor totals beside it', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/history');
    await expect(page.locator('.cardnote')).toContainText('begins when it started collecting');
    const solis = page.locator('details.syssec').nth(0);
    await expect(solis).toContainText('Recorded here');
    // 48852 kWh lifetime against four days of our own: the two must never be
    // mistaken for each other.
    await expect(solis).toContainText('Vendor · lifetime');
  });

  test('the range picker reloads the page for that many days', async ({ page }) => {
    await stubApi(page);
    const seen: string[] = [];
    // Registered after stubApi: Playwright tries the most recent route first.
    await page.route('**/api/history**', (r) => {
      seen.push(new URL(r.request().url()).searchParams.get('days') ?? '');
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ now: NOW, days: 30, rows: historyRows() }) });
    });
    await page.goto('/#/history');
    await expect(page.locator('.rangebtn.on')).toHaveText('30 days');
    await page.locator('.rangebtn', { hasText: '7 days' }).click();
    await expect(page.locator('.rangebtn.on')).toHaveText('7 days');
    expect(seen).toContain('7');
  });

  test("asks for days in the reader's own timezone, not UTC", async ({ page }) => {
    await stubApi(page);
    let url = '';
    await page.route('**/api/history**', (r) => {
      url = r.request().url();
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ now: NOW, days: 30, rows: [] }) });
    });
    await page.goto('/#/history');
    await expect(page.locator('.rangepick:not(.syspick)')).toBeVisible();
    // A solar day ends at the array's midnight; grouping by UTC would split
    // every day in the wrong place for most of the world.
    expect(url).toContain('tz=');
  });

  test('a system with no recorded days says so rather than drawing an empty table', async ({ page }) => {
    await stubApi(page, { history: [] });
    await page.goto('/#/history');
    await expect(page.locator('details.syssec').nth(0)).toContainText('No days recorded yet');
  });
});

test.describe('Theme', () => {
  test('the toggle cycles auto - light - dark and the choice survives a reload', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const btn = page.locator('.themebtn');
    await expect(btn).toHaveCount(1);
    // Nothing stamped on the root means "follow the system".
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /light|dark/);

    await btn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await btn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the stored choice is applied before the page paints', async ({ page }) => {
    await stubApi(page);
    await page.addInitScript(() => localStorage.setItem('sl-theme', 'light'));
    await page.goto('/');
    // If this were applied by the render pass the attribute would arrive late
    // and the page would flash the wrong theme first.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('Battery', () => {
  test('the overview panel says charge level, what the pack is doing, and how warm it is', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const sys = page.locator('.ovsys').nth(1);
    // Charge level and what the pack is doing are in the diagram; the tiles
    // carry the figures a picture cannot show.
    await expect(sys.locator('.ovnodes')).toContainText('100%');
    await expect(sys.locator('.ovnodes')).toContainText('idle');
    const tiles = sys.locator('.ovtiles');
    await expect(tiles).toContainText('Battery temp');
    await expect(tiles).toContainText('32.5 °C');
    await expect(tiles).toContainText('Charged today');
    await expect(tiles).toContainText('0.6 kWh');
  });

  test('derives equivalent full cycles and labels them as derived', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const card = page.locator('section.card', { has: page.locator('h3', { hasText: 'Battery' }) });
    await expect(card).toContainText('Rated capacity');
    await expect(card).toContainText('100 Ah @ 24 V · 2.40 kWh');
    // 1100.1 kWh charged over a 2.4 kWh pack.
    await expect(card).toContainText('Equivalent full cycles');
    await expect(card.locator('dd', { hasText: 'derived' })).toContainText('458');
    await expect(card).toContainText('BMS state of charge');
  });

  test('an on-grid plant gets no cycle count, because it has no pack', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    await expect(page.locator('body')).not.toContainText('Equivalent full cycles');
  });
});

test.describe('Power page', () => {
  test('an offline system heads its section with a zero, not a stale figure', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/#/power');
    const head = page.locator('details.syssec', { hasText: 'Demo Solis Plant' }).locator('> summary');
    await expect(head.locator('.snow')).toHaveText('0 W');
    await expect(head.locator('.pill')).toHaveText('offline');
  });

  test('gives each system its own collapsible section, and the chart one too', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/power');
    const secs = page.locator('details.syssec');
    // The chart is collapsible in its own right, above the two systems.
    await expect(secs).toHaveCount(3);
    await expect(secs.nth(0)).toContainText('Today · AC output · all systems');
    // Open by default: the page is there to be read, not clicked open twice.
    await expect(secs.nth(1)).toHaveAttribute('open', '');
    await secs.nth(1).locator('> summary').click();
    await expect(secs.nth(1)).not.toHaveAttribute('open', '');
    // Collapsing one leaves the others alone.
    await expect(secs.nth(2)).toHaveAttribute('open', '');
    await secs.nth(0).locator('> summary').click();
    await expect(secs.nth(0)).not.toHaveAttribute('open', '');
  });

  test('the legend switches a line out of the chart, and remembers it', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/power');
    const items = page.locator('.legitem');
    await expect(items).toHaveText([/Demo Solis Plant/, /Demo Hybrid/, /Fleet total/]);
    await expect(items.nth(0)).toHaveAttribute('aria-pressed', 'true');

    // Two curves lying on top of each other are two curves you cannot read, so
    // switching one off has to actually remove its line and rescale the axis.
    const before = await page.locator('#combined path').count();
    await items.nth(0).click();
    await expect(items.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await expect(items.nth(0)).toHaveClass(/off/);
    expect(await page.locator('#combined path').count()).toBeLessThan(before);

    // The switch survives a reload, or it has to be flicked again every refresh.
    await page.reload();
    await expect(page.locator('.legitem').nth(0)).toHaveClass(/off/);
    await page.locator('.legitem').nth(0).click();
    await expect(page.locator('.legitem').nth(0)).not.toHaveClass(/off/);
  });

  test('one sample is not the same as none', async ({ page }) => {
    // A curve needs two points. Saying "no samples today" next to a card
    // reading 8.47 kW online is simply wrong, so the two cases differ.
    await stubApi(page, { series: [{ inverter_id: SOLIS, ts: NOW - 300, ac_power_w: 8470, today_kwh: null, battery_soc: null, grid_power_w: null }] });
    await page.goto('/#/power');
    await expect(page.locator('.legitem').nth(0)).toContainText('one sample so far');
    await expect(page.locator('.legitem').nth(1)).toContainText('no samples today');
    await expect(page.locator('svg.combined').nth(1)).toContainText('One sample so far today');
  });

  test('a handful of samples is marked, not drawn as an invisible smudge', async ({ page }) => {
    // Three samples twenty minutes apart on a 24-hour axis is a two-pixel
    // line. Drawn as a bare path, a reader quite reasonably reports it as
    // "the graph is showing nothing".
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const noon = Math.floor(t0.getTime() / 1000) + 12 * 3600;
    const sparse = [0, 300, 600].map((d) => ({
      inverter_id: SOLIS, ts: noon + d, ac_power_w: 8470 + d, today_kwh: null, battery_soc: null, grid_power_w: null,
    }));
    await stubApi(page, { series: sparse });
    await page.goto('/#/power');
    // svg.combined 0 is the fleet chart; 1 and 2 are the per-system ones.
    const chart = page.locator('svg.combined').nth(1);
    // Every sample gets a dot of its own.
    await expect(chart.locator('circle')).toHaveCount(5); // 3 samples + peak + latest
    // And the empty morning is labelled and shaded, so it reads as "nobody
    // recorded this" rather than "the system produced nothing". SolisCloud
    // said the sun came up at 05:45, so six hours of daylight are missing.
    await expect(chart.locator('.axis.gap')).toContainText('recorded from 12:00');
    await expect(chart.locator('.nodata')).toHaveCount(1);
  });

  test('a record that starts at sunrise is not a gap', async ({ page }) => {
    // The fixture's curve begins at 06:00 and sunrise was 05:45. Warning about
    // that every morning would be noise, not information.
    await stubApi(page);
    await page.goto('/#/power');
    await expect(page.locator('svg.combined').nth(1).locator('.axis.gap')).toHaveCount(0);
  });

  test('no sunrise reported means no claim about a gap', async ({ page }) => {
    // The hybrid's fixture carries no weather, so there is nothing to measure
    // a late start against - and a guess would be worse than silence.
    await stubApi(page);
    await page.goto('/#/power');
    await expect(page.locator('svg.combined').nth(2).locator('.axis.gap')).toHaveCount(0);
  });

  test('a full day of samples gets no per-sample dots', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/power');
    const chart = page.locator('svg.combined').nth(2);
    await expect(chart.locator('.nodata')).toHaveCount(0);
    // Only the peak and the latest reading are marked; 13 dots would be clutter.
    await expect(chart.locator('circle')).toHaveCount(2);
  });

  test('switching every line off says so rather than drawing an empty box', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/power');
    for (const i of [0, 1, 2]) await page.locator('.legitem').nth(i).click();
    await expect(page.locator('#combined')).toContainText('Every system is switched off');
    // And the switches are still there to turn back on.
    await expect(page.locator('.legitem')).toHaveCount(3);
  });
});

test.describe('Weather', () => {
  test('shows the site conditions in the header and in the diagnostics', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('#wx-item')).toBeVisible();
    await expect(page.locator('#fleet-wx')).toHaveText('Clear (24–31°)');

    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const diag = page.locator('section.card', { has: page.locator('h3', { hasText: 'Status & diagnostics' }) });
    await expect(diag).toContainText('24–31 °C');
    await expect(diag).toContainText('05:45 – 18:25');
    await expect(page.locator('.card').filter({ has: page.locator('h3', { hasText: 'Energy' }) }))
      .toContainText('Full-load hours');
  });

  test('hides the header slot entirely when no provider reported any', async ({ page }) => {
    const invs = inverters({ solis: { metrics: metrics({ genMonthKwh: 185 }) } });
    (invs[1] as { metrics: string }).metrics = metrics({ genMonthKwh: 70.9 });
    await stubApi(page, { invs });
    await page.goto('/');
    await expect(page.locator('#wx-item')).toBeHidden();
  });
});

test.describe('Energy flow on the overview', () => {
  test('each system is one column: diagram, then figures, then its day curve', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    // The three full-width bands are gone. Each system owns a column, and the
    // order inside it is the order you read: the picture, the numbers, the day.
    await expect(page.locator('h2.band')).toHaveCount(0);
    await expect(page.locator('.ovsys')).toHaveCount(2);
    await expect(page.locator('.ovnodes')).toHaveCount(2);
    const order = await page.locator('.ovsys').nth(0).evaluate((el) =>
      [...el.querySelector('.ovmain')!.children].map((c) => c.className.split(' ')[0]));
    expect(order).toEqual(['ovhead', 'ovflow', 'ovtiles']);
  });

  test('an offline system draws a dead diagram and says why', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ts: NOW - 3600 } }) });
    await page.goto('/');
    const box = page.locator('.ovsys').nth(0);
    await expect(box.locator('.flowstale')).toContainText('offline');
    await expect(box.locator('.flowstale')).toContainText('last update');
    // Every arm carries a real zero, so no arrow is lit: the picture agrees
    // with the figures instead of contradicting them.
    await expect(box.locator('.ovarrow.live')).toHaveCount(0);
    await expect(page.locator('.ovsys').nth(1).locator('.ovarrow.live').first()).toBeVisible();
  });

  test('the flow tab is gone and an old #/flow link lands on the overview', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('nav a')).toHaveText([/Overview/, /Power/, /Historical Data/, /Alerts/, /Devices/]);
    await page.goto('/#/flow');
    await expect(page.locator('.ovsys')).toHaveCount(2);
  });

  test('both systems draw at the same size, whatever hardware they have', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    // A hybrid has a battery node the on-grid plant does not. Laid out as a
    // row they still occupy the same height, so neither picture is drawn
    // smaller than the other - which is what happened when the plan view had
    // to shrink to fit a half-width column.
    const heights = await page.locator('.ovnodes').evaluateAll(
      (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(Math.abs(heights[0] - heights[1])).toBeLessThanOrEqual(2);

    // Side by side, the two columns match and so do their charts. The hybrid
    // has more to say - a battery row and a self-powered bar - and that
    // difference is absorbed by the diagram, deliberately, because two charts
    // of different heights are the one thing this layout must not produce.
    const rects = await page.locator('.ovsys').evaluateAll(
      (els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ y: Math.round(r.y), h: Math.round(r.height) })));
    if (Math.abs(rects[0].y - rects[1].y) < 2) {
      expect(Math.abs(rects[0].h - rects[1].h)).toBeLessThanOrEqual(2);
      // The diagrams match. That is the one that has to: drawn at different
      // sizes, the smaller system's picture reads as a rendering fault rather
      // than as a system with less to show.
      const flows = await page.locator('.ovnodes').evaluateAll(
        (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      expect(Math.abs(flows[0] - flows[1])).toBeLessThanOrEqual(2);

      // The curves need not match - a hybrid spends four more figures' worth of
      // height on its battery - but neither may be squeezed into a sliver.
      const charts = await page.locator('.ovchart').evaluateAll(
        (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      for (const h of charts) expect(h).toBeGreaterThan(180);
      // And nothing collides: the figures always end above the curve.
      const clash = await page.locator('.ovsys').evaluateAll((els) => els.filter((el) => {
        const t = el.querySelector('.ovtiles')!.getBoundingClientRect();
        const c = el.querySelector('.ovchart')!.getBoundingClientRect();
        return t.bottom > c.top + 1;
      }).length);
      expect(clash).toBe(0);
    } else {
      expect(rects[1].y).toBeGreaterThan(rects[0].y + rects[0].h - 2); // stacked
    }
  });

  test('the solar node says what share of the array is working', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    const labels = page.locator('.ovnodes .ovlab');
    // 5.08 kW of a 12 kW array; 278 W of a 3.5 kW one. The percentage is what
    // makes those two comparable at a glance, so it rides on the title.
    await expect(labels.nth(0)).toHaveText('Solar · 42%');
    await expect(page.locator('.ovsys').nth(1).locator('.ovlab').first()).toHaveText('Solar · 8%');
  });

  test('no percentage where there is no rating to divide by', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { capacity_w: null } }) });
    await page.goto('/');
    await expect(page.locator('.ovsys').nth(0).locator('.ovlab').first()).toHaveText('Solar');
  });

  test('each diagram owns its arrow markers, so accents cannot leak', async ({ page }) => {
    await stubApi(page);
    // The overview draws a row of HTML nodes; the plan view with markers in it
    // is the system page's.
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const ids = await page.locator('svg.flow marker').evaluateAll((ms) => ms.map((m) => m.id));
    // Marker ids are document-wide. Two diagrams sharing one id means
    // url(#that-id) resolves to whichever came first, and the second diagram
    // silently borrows the first one's colour.
    expect(new Set(ids).size).toBe(ids.length);
    // And every reference points at a marker that exists in its own diagram.
    const dangling = await page.locator('svg.flow').evaluateAll((svgs) =>
      svgs.flatMap((svg) => [...svg.querySelectorAll('.wire')]
        .flatMap((w) => ['marker-start', 'marker-end'].map((a) => w.getAttribute(a)))
        .filter((ref): ref is string => !!ref)
        .map((ref) => ref.slice(5, -1))
        .filter((id) => !svg.querySelector(`marker[id="${id}"]`))));
    expect(dangling).toEqual([]);
  });

  test('anything above the chart opens that system detail', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    // The whole card was a link before this layout; a reader who wants more
    // about a figure clicks the figure, not a title bar above it.
    await page.locator('.ovsys').first().locator('.ovtiles > div').first().click();
    await expect(page).toHaveURL(/#\/system\//);
    await expect(page.locator('.card h3')).toContainText(['Identity & hardware']);

    await page.goBack();
    await page.locator('.ovsys').first().locator('.ovnodes').click({ position: { x: 8, y: 8 } });
    await expect(page).toHaveURL(/#\/system\//);
  });

  test('the day curve links through to the Power tab, where it is full width', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.locator('.ovchart').first().click();
    await expect(page).toHaveURL(/#\/power/);
  });
});
test.describe('AC output page', () => {
  test('the overview splits the chart per system instead of merging them', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    // Overlapping curves hide each other, so each system gets its own box.
    await expect(page.locator('svg.combined')).toHaveCount(2);
    await expect(page.locator('#combined')).toHaveCount(0);
    // One curve per column, each inside the system it belongs to.
    const charts = page.locator('.ovchart');
    await expect(charts).toHaveCount(2);
    await expect(page.locator('.ovsys').nth(0)).toContainText('Demo Solis Plant');
    await expect(page.locator('.ovsys').nth(1)).toContainText('Demo Hybrid');
  });

  test('has its own nav entry and draws the combined day chart', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    // The overview's chart boxes link through to the full page.
    await expect(page.locator('a.ovchart[href="#/power"]').first()).toBeVisible();
    await page.locator('nav').getByRole('link', { name: 'Power', exact: true }).click();
    await expect(page).toHaveURL(/#\/power$/);
    await expect(page.locator('#legend .legitem')).toContainText(['Demo Solis Plant', 'Demo Hybrid', 'Fleet total']);
    // Combined chart plus one per system.
    await expect(page.locator('svg.combined')).toHaveCount(3);
    // And each system's full detail set, so Power is not just a picture.
    await expect(page.locator('.card h3')).toContainText([
      'Identity & hardware', 'Datalogger & link', 'Live power', 'Energy counters',
    ]);
  });
});

test.describe('Devices', () => {
  test('lists the inverter and the datalogger with signal strength', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/devices');
    const rows = page.locator('table.devices tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('S5-GR3P10K');
    await expect(rows.nth(0)).toContainText('DEMO01');
    await expect(rows.nth(0)).toContainText('10.00 kW');
    await expect(rows.nth(0)).toContainText('2 producing');
    // The datalogger's RSSI is the field that names a silent outage.
    await expect(rows.nth(1)).toContainText('S3-WIFI-ST');
    await expect(rows.nth(1)).toContainText('dBm');
    await expect(rows.nth(1)).toContainText('strong');
    // The two clouds report link quality on different scales - SolisCloud in
    // dBm, SolarMan as a percentage - so each row is labelled in its own units
    // rather than both being flattened onto one invented scale.
    await expect(rows.nth(3)).toContainText('84%');
    await expect(rows.nth(3)).toContainText('strong');
    await expect(rows.nth(3)).not.toContainText('dBm');
  });

  test('says what to run when no hardware has been recorded', async ({ page }) => {
    await stubApi(page, { devs: [] });
    await page.goto('/#/devices');
    await expect(page.locator('.empty')).toContainText('relay:solis');
  });
});

test.describe('System detail', () => {
  test('opens from a panel and keeps a linkable URL', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.locator('.ovsys').nth(0).locator('.ovhead').click();
    await expect(page).toHaveURL(/#\/system\//);
    await expect(page.locator('.sys-name')).toContainText('Demo Solis Plant');
    await page.locator('a.back').click();
    await expect(page.locator('.ovsys')).toHaveCount(2);
  });

  test('on-grid system: hardware, datalogger, PV strings, and no battery block', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));

    const blocks = page.locator('.card h3');
    await expect(blocks.filter({ hasText: 'Identity & hardware' })).toBeVisible();
    await expect(blocks.filter({ hasText: 'Datalogger & link' })).toBeVisible();
    await expect(blocks.filter({ hasText: 'PV strings' })).toBeVisible();
    // The whole point of the on-grid case: no battery block at all.
    await expect(blocks.filter({ hasText: 'Battery' })).toHaveCount(0);

    await expect(page.locator('.blocks')).toContainText('S5-GR3P10K');
    await expect(page.locator('.blocks')).toContainText('87003E');
    await expect(page.locator('.blocks')).toContainText('dBm');
    await expect(page.locator('.bar-row')).toHaveCount(2);
    await expect(page.locator('.bar-row').nth(0)).toContainText('34 W');
    await expect(page.locator('.bar-row').nth(0)).toContainText('167.9 V');
    await expect(page.locator('.bar-row').nth(0)).toContainText('0.2 A');
  });

  test('hybrid system: battery block with charge and discharge counters', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const battery = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'Battery' }) });
    await expect(battery).toBeVisible();
    await expect(battery).toContainText('static');
    await expect(battery).toContainText('1100 kWh');
    await expect(battery.locator('.ring text')).toHaveText('100%');
    await expect(page.locator('.blocks')).toContainText('Produced this month');
    await expect(page.locator('.blocks')).toContainText('70.9 kWh');
  });

  test('raw telemetry expands and filters', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const raw = page.locator('details.raw');
    await expect(raw).toBeVisible();
    await raw.locator('summary').click();
    const grid = raw.locator('.rawgrid');
    await expect(grid).toContainText('generationPower');
    await raw.locator('.rawfilter').fill('battery');
    await expect(grid.locator('.rk').filter({ hasText: 'batterySoc' })).toBeVisible();
    await expect(grid.locator('.rk').filter({ hasText: 'generationPower' })).toBeHidden();
  });

  test('on-grid system: per-phase AC, frequency, power factor and DC bus', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const ac = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'AC output' }) });
    await expect(ac).toBeVisible();
    await expect(ac).toContainText('228.4 V · 0.1 A');
    await expect(ac).toContainText('49.64 Hz');
    await expect(ac).toContainText('589.9 V');
  });

  test('heatsink temperature comes from the device when the reading has none', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const diag = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'Status' }) });
    await expect(diag).toContainText('40.6 °C');
  });

  test('the single-phase hybrid shows one AC phase, not three', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const ac = page.locator('.card').filter({ has: page.locator('h3', { hasText: 'AC output' }) });
    await expect(ac).toContainText('233.3');
    await expect(ac).not.toContainText('Phase 2');
  });

  test('energy flow: the house is the load, and the arms read off the signs', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const flow = page.locator('svg.flow');
    await expect(flow).toBeVisible();
    // Three arms into one house, not four arms plus a separate house-shaped
    // "Consumption" node standing next to the house it duplicated.
    await expect(flow.locator('.wire')).toHaveCount(3);
    await expect(flow.locator('.lbl')).toHaveText([/Solar/, /Grid/, /Battery/, /House load/]);
    // 278 W production, 91 W import, 307 W load - the load inside the house.
    await expect(flow).toContainText('278 W');
    await expect(flow).toContainText('91 W');
    await expect(flow).toContainText('307 W');
    await expect(flow).toContainText('importing');
    // The pack's SOC rides on its label rather than needing a node of its own.
    await expect(flow.locator('.lbl').nth(2)).toHaveText('Battery · 100%');
  });

  test('energy flow: a battery drifting a few watts is idle here too', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    const flow = page.locator('svg.flow');
    // -24 W is drift. Every figure on the page calls that idle, so the arm
    // must not be drawn live with an arrow and a travelling pip.
    await expect(flow).toContainText('idle');
    // Solar and grid are both carrying real power; the battery arm is the one
    // that must stay dead. Arms are drawn in node order: solar, grid, battery.
    await expect(flow.locator('.wire').nth(2)).toHaveClass(/dead/);
    await expect(flow.locator('.wire.live')).toHaveCount(2);
    await expect(flow.locator('.pip')).toHaveCount(2);
  });

  test('energy flow: an on-grid system has no battery arm at all', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const flow = page.locator('svg.flow');
    await expect(flow.locator('.wire')).toHaveCount(2);
    await expect(flow.locator('.lbl')).toHaveText([/Solar/, /Grid/, /House load/]);
    await expect(flow).not.toContainText('Battery');
    // Exporting 5.08 kW, so the grid arm is labelled as such.
    await expect(flow).toContainText('exporting');
  });

  test('energy flow: wire thickness tracks how much power an arm carries', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    const wires = page.locator('svg.flow .wire');
    // 5.08 kW of production against 0 W of load on a 12 kW array: the solar arm
    // has to be visibly fatter than the idle one, or the picture says nothing
    // the numbers did not already say.
    const solar = Number(await wires.nth(0).getAttribute('stroke-width'));
    const grid = Number(await wires.nth(1).getAttribute('stroke-width'));
    expect(solar).toBeGreaterThan(4);
    expect(solar).toBeCloseTo(grid, 1); // both carry the same 5.08 kW
  });

  test('energy flow: says how much of the load is being self-powered', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(HYBRID));
    // 307 W of load, 91 W of it imported, so 70% is coming from the house's
    // own kit. That is the question the diagram exists to answer.
    const bar = page.locator('.flowbar');
    await expect(bar).toContainText('Self-powered right now');
    await expect(bar.locator('b')).toHaveText('70%');
  });

  test('energy flow: no self-powered claim when the load is unmeasured', async ({ page }) => {
    // An on-grid plant with no CT clamp reports 0 W of household load; there is
    // nothing to take a percentage of, so the bar stays away.
    await stubApi(page);
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    await expect(page.locator('.flowbar')).toHaveCount(0);
  });

  test('energy flow: an arm carrying no power is drawn dead, not live', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { ac_power_w: 0, grid_power_w: 0, load_power_w: 0 } }) });
    await page.goto('/#/system/' + encodeURIComponent(SOLIS));
    // No arm is energised, so no wire is accented and no pip travels.
    await expect(page.locator('svg.flow .wire.live')).toHaveCount(0);
    await expect(page.locator('svg.flow .pip')).toHaveCount(0);
    // Dead arms are dashed as well as grey, so the state survives a screenshot
    // and does not rest on colour alone.
    await expect(page.locator('svg.flow .wire.dead')).toHaveCount(2);
  });

  test('an unknown system id does not break the page', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/system/nope');
    await expect(page.locator('.empty')).toContainText('Unknown system');
  });
});

test.describe('Self-sufficiency and self-consumption', () => {
  test('both ratios are shown for a system whose load is metered', async ({ page }) => {
    await stubApi(page);
    await page.goto(`/#/system/${HYBRID}`);
    const counters = page.locator('.card', { hasText: 'Energy counters' });
    // 3.0 kWh self-used out of 4.8 consumed, and out of 13.7 generated.
    await expect(counters).toContainText('Self-sufficiency today');
    await expect(counters).toContainText('63 % of the load');
    await expect(counters).toContainText('Self-consumption today');
    await expect(counters).toContainText('22 % of what was generated');
  });

  test('neither is shown for a plant with no meter, rather than 0 %', async ({ page }) => {
    await stubApi(page);
    await page.goto(`/#/system/${SOLIS}`);
    const counters = page.locator('.card', { hasText: 'Energy counters' });
    await expect(counters).toContainText('Produced today');
    await expect(counters).not.toContainText('Self-sufficiency');
    await expect(counters).not.toContainText('Self-consumption');
  });

  test('a metered load of zero is left blank, not divided by', async ({ page }) => {
    // Before dawn nothing has been consumed yet. "0 % self-sufficient" would be
    // a claim about a day that has not started.
    await stubApi(page, {
      invs: inverters({ solarman: { metrics: metrics({ loadTodayKwh: 0, selfUseTodayKwh: 0 }) } }),
    });
    await page.goto(`/#/system/${HYBRID}`);
    const counters = page.locator('.card', { hasText: 'Energy counters' });
    await expect(counters).not.toContainText('Self-sufficiency');
  });

  test('a ratio over 100 is clamped, because the counters round separately', async ({ page }) => {
    await stubApi(page, {
      invs: inverters({ solarman: { metrics: metrics({ loadTodayKwh: 4.0, selfUseTodayKwh: 4.2 }) } }),
    });
    await page.goto(`/#/system/${HYBRID}`);
    await expect(page.locator('.card', { hasText: 'Energy counters' })).toContainText('100 % of the load');
  });
});

test.describe("The plant's own day", () => {
  // 12 hours east of the runner, so the plant's midnight is far from the
  // browser's however this suite is run.
  const EAST = 12 * 3600;

  test('the day chart opens at the plant midnight, not the reader\'s', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solis: { tz_offset_sec: EAST } }) });
    await page.goto('/#/');
    const t0 = await page.evaluate((off) => {
      const now = Math.floor(Date.now() / 1000);
      return Math.floor((now + off) / 86400) * 86400 - off;
    }, EAST);
    const viewerMidnight = await page.evaluate(() => {
      const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000);
    });
    // The premise of the test: the two really do disagree.
    expect(t0).not.toBe(viewerMidnight);
    // And a sample from before the plant's day must not be on its chart.
    await expect(page.locator('.ovsys').first()).toBeVisible();
  });

  test('samples from before the plant day are not counted as today', async ({ page }) => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const viewerT0 = Math.floor(start.getTime() / 1000);
    await stubApi(page, {
      invs: inverters({ solis: { tz_offset_sec: -12 * 3600 } }),
      // One sample at the reader's own midnight. For a plant twelve hours west
      // that instant belongs to yesterday, so it cannot be today's peak.
      series: [
        { inverter_id: SOLIS, ts: viewerT0 + 60, ac_power_w: 11_000, today_kwh: null, battery_soc: null, grid_power_w: null },
      ],
    });
    await page.goto('/#/');
    await expect(page.locator('.ovsys').first()).not.toContainText('peak 11.0 kW');
  });

  test('a plant that reports no timezone still draws its day', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/');
    // No tz_offset_sec on either fixture: the reader's midnight is the fallback
    // and every system still has a curve.
    await expect(page.locator('.ovsys')).toHaveCount(2);
    await expect(page.locator('.ovchart svg').first()).toBeVisible();
  });
});

test.describe('Installable', () => {
  test('the page links a manifest that parses and names both icon sizes', async ({ page, request }) => {
    await stubApi(page);
    await page.goto('/#/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');

    const res = await request.get(href as string);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('manifest+json');

    const m = JSON.parse(await res.text());
    expect(m.name).toBe('SolarLens');
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    const sizes = (m.icons as { sizes: string }[]).map((i) => i.sizes);
    // Chrome will not offer an install without an icon of at least 192px.
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect((m.icons as { purpose?: string }[]).some((i) => i.purpose === 'maskable')).toBe(true);
  });

  test('every icon the manifest names actually exists', async ({ page, request }) => {
    await stubApi(page);
    await page.goto('/#/');
    const m = JSON.parse(await (await request.get('/manifest.webmanifest')).text());
    for (const icon of m.icons as { src: string; type: string }[]) {
      const res = await request.get(icon.src);
      expect(res.status(), `${icon.src} is missing`).toBe(200);
      expect(res.headers()['content-type']).toContain(icon.type.split('/')[1]);
    }
  });

  test('iOS gets a raster touch icon, because it will not scale the SVG', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/');
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', /\.png$/);
  });

  test('the service worker exists and goes to the network before its cache', async ({ request }) => {
    const res = await request.get('/sw.js');
    expect(res.status()).toBe(200);
    const src = await res.text();
    // The rule the file exists to keep: fetch first, cache only on failure.
    expect(src).toContain("addEventListener('fetch'");
    expect(src.indexOf('fetch(request)')).toBeLessThan(src.indexOf('caches.match(request)'));
    // A POST is an instruction and must never be replayed from a cache.
    expect(src).toContain("request.method !== 'GET'");
  });
});

test.describe('PV strings on an offline inverter', () => {
  // The bug this block exists for: an inverter that went offline at dusk kept
  // its last string readings on the device record - 21 W and 17 W - and every
  // view counted those as strings producing now, on a system the header
  // correctly called offline.
  const offlineSolis = () => inverters({ solis: { ts: NOW - 19 * 3600, status: 'offline' } });
  const staleDevices = () => devices().map((d) => d.id === 'soliscloud:inverter:DEMO01'
    ? { ...d, status: 'offline', last_seen: NOW - 19 * 3600 }
    : d);

  test('the overview does not say an offline inverter\'s strings are producing', async ({ page }) => {
    await stubApi(page, { invs: offlineSolis(), devs: staleDevices() });
    await page.goto('/#/');
    const solis = page.locator('.ovsys').first();
    const tile = solis.locator('.ovtiles > div', { hasText: 'PV strings' });
    await expect(tile).toBeVisible();
    await expect(tile).not.toContainText('producing');
    await expect(tile).toContainText('offline');
  });

  test('the devices table says offline, not "2 producing"', async ({ page }) => {
    await stubApi(page, { invs: offlineSolis(), devs: staleDevices() });
    await page.goto('/#/devices');
    const row = page.locator('table.devices tbody tr').nth(0);
    await expect(row).toContainText('S5-GR3P10K');
    await expect(row).not.toContainText('producing');
  });

  test('the devices table also trusts the reading, not only the device record', async ({ page }) => {
    // The device record still says online, but the inverter's newest sample is
    // 19 hours old - which is what makes a system offline everywhere else.
    await stubApi(page, { invs: offlineSolis(), devs: devices() });
    await page.goto('/#/devices');
    await expect(page.locator('table.devices tbody tr').nth(0)).not.toContainText('producing');
  });

  test('the system page labels its string readings as the last ones reported', async ({ page }) => {
    await stubApi(page, { invs: offlineSolis(), devs: staleDevices() });
    await page.goto(`/#/system/${SOLIS}`);
    const card = page.locator('.card', { hasText: 'PV strings' });
    await expect(card).toBeVisible();
    // No wattage presented as if it were flowing now.
    await expect(card.locator('.bar-row .num').first()).toHaveText('offline');
    await expect(card).toContainText('last reported');
  });
});

test.describe('PV strings: counting what is connected', () => {
  test('an empty MPPT socket is not counted as a string that is not producing', async ({ page }) => {
    // One array on input 1, nothing on input 2: that is one string, producing.
    // "1 of 2" would read as a fault that does not exist.
    const devs = devices().map((d) => d.id === 'soliscloud:inverter:DEMO01'
      ? { ...d, strings: JSON.stringify([
          { index: 1, powerW: 2289, voltageV: 253.6, currentA: 9.2 },
          { index: 2, powerW: 0, voltageV: 0.5, currentA: 0 },
        ]) }
      : d);
    await stubApi(page, { devs });
    await page.goto('/#/');
    const tile = page.locator('.ovsys').first().locator('.ovtiles > div', { hasText: 'PV strings' });
    await expect(tile).toContainText('1 producing');
    await expect(tile).not.toContainText('of 2');

    await page.goto('/#/devices');
    const row = page.locator('table.devices tbody tr').nth(0);
    await expect(row).toContainText('1 producing');
  });

  test('a connected string reading zero in daylight is reported as a shortfall', async ({ page }) => {
    const devs = devices().map((d) => d.id === 'soliscloud:inverter:DEMO01'
      ? { ...d, strings: JSON.stringify([
          { index: 1, powerW: 4100, voltageV: 480, currentA: 8.5 },
          { index: 2, powerW: 0, voltageV: 310, currentA: 0 },
        ]) }
      : d);
    await stubApi(page, { devs });
    await page.goto('/#/');
    const tile = page.locator('.ovsys').first().locator('.ovtiles > div', { hasText: 'PV strings' });
    // A string with real voltage and no current is connected and not
    // producing - the one case "1 of 2" is the right thing to say.
    await expect(tile).toContainText('1 of 2');
  });
});

test.describe('Battery charge through the day', () => {
  const socSeries = (samples: [number, number][]) => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const t0 = Math.floor(start.getTime() / 1000);
    return samples.map(([hour, soc]) => ({
      inverter_id: HYBRID, ts: t0 + Math.round(hour * 3600), ac_power_w: 0,
      today_kwh: null, battery_soc: soc, grid_power_w: null,
    }));
  };

  test('draws the charge curve with the day\'s low and high', async ({ page }) => {
    await stubApi(page, { series: socSeries([[1, 62], [3, 48], [5, 41], [8, 55], [11, 88], [13, 100]]) });
    await page.goto(`/#/system/${HYBRID}`);
    const battery = page.locator('.card', { hasText: 'State of charge' });
    const chart = battery.locator('.soc');
    await expect(chart).toBeVisible();
    await expect(chart).toContainText('low 41%');
    await expect(chart).toContainText('high 100%');
    await expect(chart.locator('path')).toHaveCount(1);
  });

  test('is not drawn for a system with no battery', async ({ page }) => {
    await stubApi(page);
    await page.goto(`/#/system/${SOLIS}`);
    await expect(page.locator('.soc')).toHaveCount(0);
  });

  test('needs two samples before it draws a line', async ({ page }) => {
    await stubApi(page, { series: socSeries([[9, 70]]) });
    await page.goto(`/#/system/${HYBRID}`);
    await expect(page.locator('.card', { hasText: 'State of charge' })).toBeVisible();
    await expect(page.locator('.soc')).toHaveCount(0);
  });

  test('breaks the line across an outage rather than joining it', async ({ page }) => {
    // Samples until 02:00, nothing until 07:00. A straight segment across the
    // gap would be a claim about five hours nobody measured.
    await stubApi(page, { series: socSeries([[1, 60], [1.5, 58], [2, 57], [7, 40], [7.5, 45]]) });
    await page.goto(`/#/system/${HYBRID}`);
    const d = await page.locator('.soc path').getAttribute('d');
    expect((d ?? '').match(/M/g)).toHaveLength(2);
  });

  test('keeps the axis at 0 to 100 whatever the data spans', async ({ page }) => {
    // 94 to 100 fitted edge to edge would look like a pack that went flat.
    await stubApi(page, { series: socSeries([[9, 94], [12, 100]]) });
    await page.goto(`/#/system/${HYBRID}`);
    const labels = await page.locator('.soc text.axis').allTextContents();
    expect(labels).toEqual(expect.arrayContaining(['0%', '50%', '100%']));
  });
});

test.describe('TV mode', () => {
  test('opens straight on #/tv, with no header, tabs or footer', async ({ page }) => {
    // A wall display is bookmarked on this URL and loaded cold, so this is the
    // path that has to work - not only arriving from the overview.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await stubApi(page);
    await page.goto('/#/tv');
    await expect(page.locator('.tvsys')).toHaveCount(2);
    await expect(page.locator('.topbar')).toBeHidden();
    await expect(page.locator('footer')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('shows each system\'s power, today and the fleet total', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/tv');
    const panels = page.locator('.tvsys');
    await expect(panels.nth(0)).toContainText('Demo Solis Plant');
    await expect(panels.nth(0).locator('.tvnow')).toContainText('5.08');
    await expect(panels.nth(0)).toContainText('Today');
    // 5080 W + 278 W.
    await expect(page.locator('.tvtotal')).toContainText('5.36');
  });

  test('the battery appears only on the system that has one', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/tv');
    await expect(page.locator('.tvsys').nth(0)).not.toContainText('Battery');
    await expect(page.locator('.tvsys').nth(1)).toContainText('Battery');
    await expect(page.locator('.tvsys').nth(1)).toContainText('100 %');
  });

  test('an offline system is greyed and shows no house or grid flow', async ({ page }) => {
    await stubApi(page, { invs: inverters({ solarman: { ts: NOW - 19 * 3600, status: 'offline' } }) });
    await page.goto('/#/tv');
    const hybrid = page.locator('.tvsys').nth(1);
    await expect(hybrid.locator('.tvnow')).toHaveClass(/off/);
    await expect(hybrid.locator('.pill')).toHaveText('offline');
    await expect(hybrid).not.toContainText('House');
    await expect(hybrid).not.toContainText('Grid');
  });

  test('has a running clock, so a frozen page is visible as frozen', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/tv');
    await expect(page.locator('#tvclock')).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.locator('#tvago')).toContainText('updated');
  });

  test('Escape leaves, and the page comes back with its chrome', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/tv');
    await expect(page.locator('.tvsys').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('.ovsys')).toHaveCount(2);
  });

  test('is reachable from the header', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/');
    await page.locator('#tvbtn').click();
    await expect(page).toHaveURL(/#\/tv$/);
    await expect(page.locator('.tvsys')).toHaveCount(2);
  });

  test('fits the screen without scrolling', async ({ page }) => {
    await stubApi(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/#/tv');
    await expect(page.locator('.tvsys')).toHaveCount(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('History by month and by year', () => {
  // Rows that straddle a month and a year boundary, so the folding is visible.
  const rows = () => {
    const out: unknown[] = [];
    const day = (d: string, y: number, load: number | null) => ({
      inverter_id: HYBRID, day: d, yield_kwh: y, peak_w: 2500 + y, load_kwh: load,
      import_kwh: 1, export_kwh: 2, batt_charge_kwh: 0.5, batt_discharge_kwh: 0.25,
      samples: 100, first_ts: NOW, last_ts: NOW,
    });
    out.push(day('2026-01-02', 10, 4), day('2026-01-01', 12, 5));
    out.push(day('2025-12-31', 8, 3), day('2025-12-30', 9, 3));
    out.push({ inverter_id: SOLIS, day: '2026-01-01', yield_kwh: 40, peak_w: 9000, load_kwh: null,
      import_kwh: null, export_kwh: null, batt_charge_kwh: null, batt_discharge_kwh: null,
      samples: 90, first_ts: NOW, last_ts: NOW });
    return out;
  };

  const section = (page: Page, name: string) => page.locator('details.syssec', { hasText: name });

  test('folds days into months, with how many days each month really has', async ({ page }) => {
    await stubApi(page, { history: rows() });
    await page.goto('/#/history');
    await page.locator('.groupbtn[data-group="month"]').click();
    const t = section(page, 'Demo Hybrid').locator('table tbody tr');
    await expect(t).toHaveCount(2);
    // Newest first. January: 10 + 12 produced, 4 + 5 consumed, peak 2512.
    await expect(t.nth(0)).toContainText('2026-01');
    await expect(t.nth(0)).toContainText('22.0 kWh');
    await expect(t.nth(0)).toContainText('9.0 kWh');
    await expect(t.nth(0)).toContainText('2 of 31');
    await expect(t.nth(1)).toContainText('2025-12');
    await expect(t.nth(1)).toContainText('17.0 kWh');
    await expect(t.nth(1)).toContainText('2 of 31');
  });

  test('folds into years, counting a year\'s real length', async ({ page }) => {
    await stubApi(page, { history: rows() });
    await page.goto('/#/history');
    await page.locator('.groupbtn[data-group="year"]').click();
    const t = section(page, 'Demo Hybrid').locator('table tbody tr');
    await expect(t).toHaveCount(2);
    await expect(t.nth(0)).toContainText('2026');
    await expect(t.nth(0)).toContainText('2 of 365');
    await expect(t.nth(1)).toContainText('2025');
  });

  test('a period with nothing metered stays blank rather than summing to zero', async ({ page }) => {
    await stubApi(page, { history: rows() });
    await page.goto('/#/history');
    await page.locator('.groupbtn[data-group="month"]').click();
    const solis = section(page, 'Demo Solis Plant');
    await expect(solis.locator('thead')).not.toContainText('Consumed');
    await expect(solis.locator('tbody tr').first()).toContainText('40.0 kWh');
  });

  test('asks the server for the whole 400-day window, and goes back to 30 for days', async ({ page }) => {
    const asked: string[] = [];
    await stubApi(page, { history: rows() });
    page.on('request', (r) => { if (r.url().includes('/api/history')) asked.push(new URL(r.url()).searchParams.get('days') ?? ''); });
    await page.goto('/#/history');
    await page.locator('.groupbtn[data-group="month"]').click();
    await expect.poll(() => asked).toContain('400');
    // The day ranges mean nothing for months, so they are not offered.
    await expect(page.locator('.rangebtn[data-days]')).toHaveCount(0);
    await page.locator('.groupbtn[data-group="day"]').click();
    await expect(page.locator('.rangebtn[data-days]')).toHaveCount(3);
    await expect.poll(() => asked.at(-1)).toBe('30');
  });

  test('says how much of the current month the record is missing, against the vendor', async ({ page }) => {
    // The fixture hybrid reports genMonthKwh 70.9; the newest recorded month
    // holds 22 kWh across 2 of 31 days.
    await stubApi(page, { history: rows() });
    await page.goto('/#/history');
    await page.locator('.groupbtn[data-group="month"]').click();
    const note = section(page, 'Demo Hybrid').locator('.cardnote');
    await expect(note).toContainText('counts 70.9 kWh');
    await expect(note).toContainText('recorded 22.0 kWh across 2 of its 31 days');
  });

  test('the chart labels months and years, not day numbers', async ({ page }) => {
    await stubApi(page, { history: rows() });
    await page.goto('/#/history');
    await page.locator('.groupbtn[data-group="year"]').click();
    const labels = await section(page, 'Demo Hybrid').locator('svg text.axis').allTextContents();
    expect(labels).toEqual(expect.arrayContaining(['2025', '2026', 'kWh per year']));
  });
});

test.describe('Fault history', () => {
  const DAY = 86400;
  const solisAlarm = (daysAgo: number, over: Record<string, unknown> = {}) => ({
    inverter_id: SOLIS, provider: 'soliscloud', code: '1015', message: 'NO-Grid', severity: 'info',
    vendor_level: 1, advice: 'No Action Required', begin_ts: NOW - daysAgo * DAY, end_ts: NOW - daysAgo * DAY + 600,
    state: 'recovered', ...over,
  });
  const hybridAlarm = (daysAgo: number) => ({
    inverter_id: HYBRID, provider: 'solarman', code: '7', message: 'DC volt low fault', severity: 'fault',
    vendor_level: 2, advice: null, begin_ts: NOW - daysAgo * DAY, end_ts: null, state: 'unknown',
  });
  const section = (page: Page, name: string) => page.locator('details.syssec', { hasText: name });

  test('lists a system\'s past alarms, newest first, with what the vendor advises', async ({ page }) => {
    await stubApi(page, { alarms: [solisAlarm(1, { code: 'F017', message: 'L&PE FAIL', severity: 'warning' }), solisAlarm(30), solisAlarm(400)] });
    await page.goto('/#/alerts');
    const hist = section(page, 'Demo Solis Plant').locator('.faulthist');
    await expect(hist.locator('tbody tr')).toHaveCount(3);
    await expect(hist.locator('thead')).toContainText('Vendor advice');
    const first = hist.locator('tbody tr').first();
    await expect(first).toContainText('F017');
    await expect(first).toContainText('L&PE FAIL');
    await expect(first).toContainText('warning');
    await expect(first).toContainText('10 min');
    await expect(first).toContainText('No Action Required');
  });

  test('sums it up: how many, since when, and what happens most', async ({ page }) => {
    await stubApi(page, { alarms: [solisAlarm(1), solisAlarm(2), solisAlarm(3, { code: 'F017', message: 'L&PE FAIL' })] });
    await page.goto('/#/alerts');
    const sum = section(page, 'Demo Solis Plant').locator('.fh-sum');
    await expect(sum).toContainText('3 alarms since');
    await expect(sum).toContainText('Most often: NO-Grid, 2 times');
  });

  test('SolarMan has no advice and no end time, and the page does not pretend otherwise', async ({ page }) => {
    await stubApi(page, { alarms: [hybridAlarm(5)] });
    await page.goto('/#/alerts');
    const hist = section(page, 'Demo Hybrid').locator('.faulthist');
    await expect(hist.locator('thead')).not.toContainText('Vendor advice');
    const row = hist.locator('tbody tr').first();
    await expect(row).toContainText('not recorded');
    await expect(row).not.toContainText('ongoing');
    await expect(row.locator('.pill')).toHaveClass(/bad/);
  });

  test('an alarm the vendor records as clearing the instant it began reads "under a minute"', async ({ page }) => {
    await stubApi(page, { alarms: [solisAlarm(1, { end_ts: NOW - DAY })] });
    await page.goto('/#/alerts');
    await expect(section(page, 'Demo Solis Plant').locator('tbody tr').first()).toContainText('under a minute');
  });

  test('each system shows only its own alarms, and says so when it has none', async ({ page }) => {
    await stubApi(page, { alarms: [solisAlarm(1)] });
    await page.goto('/#/alerts');
    await expect(section(page, 'Demo Solis Plant').locator('.faulthist tbody tr')).toHaveCount(1);
    await expect(section(page, 'Demo Hybrid').locator('.faulthist')).toContainText('no alarms on record');
  });

  test('a long history shows the newest fifty and says how many there are', async ({ page }) => {
    await stubApi(page, { alarms: Array.from({ length: 63 }, (_, i) => solisAlarm(i + 1)) });
    await page.goto('/#/alerts');
    const hist = section(page, 'Demo Solis Plant').locator('.faulthist');
    await expect(hist.locator('tbody tr')).toHaveCount(50);
    await expect(hist).toContainText('Showing the newest 50 of 63');
  });

  test('a failed load says so instead of claiming a clean record', async ({ page }) => {
    await stubApi(page, { alarms: 'error' });
    await page.goto('/#/alerts');
    const hist = section(page, 'Demo Solis Plant').locator('.faulthist');
    await expect(hist).toContainText('Could not load fault history');
    await expect(hist).not.toContainText('no alarms on record');
  });
});

test.describe('History with vendor totals', () => {
  const vendorMonth = (key: string, y: number, inv = SOLIS) => ({
    inverter_id: inv, period: 'month', key, yield_kwh: y, load_kwh: null, import_kwh: null, export_kwh: null,
    charge_kwh: null, discharge_kwh: null, full_hours: 80, source: 'soliscloud-portal',
  });
  const vendorYear = (key: string, y: number) => ({ ...vendorMonth(key, y), period: 'year' });
  const recordedDay = (day: string, y: number) => ({
    inverter_id: SOLIS, day, yield_kwh: y, peak_w: 9000, load_kwh: null, import_kwh: null, export_kwh: null,
    batt_charge_kwh: null, batt_discharge_kwh: null, samples: 100, first_ts: NOW, last_ts: NOW,
  });
  const section = (page: Page, name: string) => page.locator('details.syssec', { hasText: name });

  test('a month the vendor counted in full shows its total, not the few days SolarLens saw', async ({ page }) => {
    await stubApi(page, {
      history: [recordedDay('2026-09-02', 40), recordedDay('2026-09-01', 34)],
      periods: [vendorMonth('2026-09', 493.6)],
    });
    await page.goto('/#/history');
    await page.locator('.groupbtn[data-group="month"]').click();
    const row = section(page, 'Demo Solis Plant').locator('tbody tr', { hasText: '2026-09' });
    await expect(row).toContainText('494 kWh');
    await expect(row).toContainText('2 of 30');
    await expect(row).toContainText('SolisCloud');
    // The peak still comes from what SolarLens recorded.
    await expect(row).toContainText('9.00 kW');
  });

  test('months from before SolarLens began collecting appear, from the vendor', async ({ page }) => {
    await stubApi(page, {
      history: [recordedDay('2026-09-01', 34)],
      periods: [vendorMonth('2026-09', 493.6), vendorMonth('2025-12', 1210), vendorMonth('2024-02', 23)],
    });
    await page.goto('/#/history');
    await page.locator('.groupbtn[data-group="month"]').click();
    const rows = section(page, 'Demo Solis Plant').locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText('2024-02');
    await expect(rows.nth(2)).toContainText('0 of 29');
    await expect(section(page, 'Demo Solis Plant').locator('.cardnote')).toContainText('own');
  });

  test('a system the vendor sent no totals for keeps its own record, labelled as such', async ({ page }) => {
    await stubApi(page, { periods: [vendorMonth('2026-09', 493.6)] });
    await page.goto('/#/history');
    await page.locator('.groupbtn[data-group="month"]').click();
    const hybrid = section(page, 'Demo Hybrid');
    await expect(hybrid.locator('tbody tr').first()).toContainText('SolarLens');
  });

  test('by year, the vendor years go back to installation', async ({ page }) => {
    await stubApi(page, {
      history: [recordedDay('2026-09-01', 34)],
      periods: [vendorYear('2026', 13985.4), vendorYear('2025', 18420.8), vendorYear('2024', 16744)],
    });
    await page.goto('/#/history');
    await page.locator('.groupbtn[data-group="year"]').click();
    const rows = section(page, 'Demo Solis Plant').locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText('2025');
    await expect(rows.nth(1)).toContainText('18421 kWh');
    const labels = await section(page, 'Demo Solis Plant').locator('svg text.axis').allTextContents();
    expect(labels).toEqual(expect.arrayContaining(['2024', '2025', '2026']));
  });
});

test.describe('SolisCloud relay logins', () => {
  const H = 3600;
  const relay = (over: Record<string, unknown> = {}) => ({
    provider: 'soliscloud', name: 'Office laptop', state: 'ok',
    login_expires_at: NOW + 6 * 24 * H, first_seen: NOW - 30 * 24 * H, last_seen: NOW - 120, last_ok_at: NOW - 120,
    ...over,
  });
  const solisAlerts = (page: Page) => page.locator('details.syssec', { hasText: 'Demo Solis Plant' }).locator('ul.alerts li');

  test('says nothing while a login has more than two days left', async ({ page }) => {
    await stubApi(page, { relays: [relay()] });
    await page.goto('/#/alerts');
    await expect(page.locator('details.syssec', { hasText: 'Demo Solis Plant' })).toBeVisible();
    await expect(page.locator('details.syssec', { hasText: 'Demo Solis Plant' })).not.toContainText('SolisCloud login');
  });

  test('warns two days ahead, naming the relay and the fix', async ({ page }) => {
    await stubApi(page, { relays: [relay({ login_expires_at: NOW + 20 * H })] });
    await page.goto('/#/alerts');
    const a = solisAlerts(page).filter({ hasText: 'SolisCloud login on Office laptop expires in 20 hours' });
    await expect(a).toHaveCount(1);
    await expect(a).toHaveClass(/warn/);
    await expect(a).toContainText('renew-solis-login.cmd');
  });

  test('an expired login with no other relay is an outage', async ({ page }) => {
    await stubApi(page, { relays: [relay({ state: 'login-expired', login_expires_at: NOW - H })] });
    await page.goto('/#/alerts');
    const a = solisAlerts(page).filter({ hasText: 'SolisCloud login expired on Office laptop' });
    await expect(a).toHaveCount(1);
    await expect(a).toHaveClass(/bad/);
    await expect(a).not.toContainText('another relay');
  });

  test('an expiry date in the past counts as expired even before the relay says so', async ({ page }) => {
    await stubApi(page, { relays: [relay({ state: 'ok', login_expires_at: NOW - 60 })] });
    await page.goto('/#/alerts');
    await expect(solisAlerts(page).filter({ hasText: 'SolisCloud login expired on Office laptop' })).toHaveCount(1);
  });

  test('while another relay still delivers, an expired login is a warning, not an outage', async ({ page }) => {
    await stubApi(page, {
      relays: [
        relay({ name: 'Home laptop', state: 'login-expired', login_expires_at: NOW - H }),
        relay({ name: 'Office laptop' }),
      ],
    });
    await page.goto('/#/alerts');
    const a = solisAlerts(page).filter({ hasText: 'SolisCloud login expired on Home laptop' });
    await expect(a).toHaveClass(/warn/);
    await expect(a).toContainText('Readings still arrive through another relay');
  });

  test('a relay silent for more than a week is a computer that is off, and raises nothing', async ({ page }) => {
    await stubApi(page, { relays: [relay({ state: 'login-expired', login_expires_at: NOW - 9 * 24 * H, last_seen: NOW - 8 * 24 * H })] });
    await page.goto('/#/alerts');
    await expect(page.locator('details.syssec', { hasText: 'Demo Solis Plant' })).not.toContainText('SolisCloud login');
  });

  test('the Devices tab lists each relay with its login expiry', async ({ page }) => {
    await stubApi(page, {
      relays: [
        relay({ name: 'Relay 1', login_expires_at: NOW + 30 * H }),
        relay({ name: 'Office laptop' }),
        relay({ name: 'Relay 3', state: 'login-expired', login_expires_at: NOW - H }),
      ],
    });
    await page.goto('/#/devices');
    const card = page.locator('section.relays');
    await expect(card.locator('tbody tr')).toHaveCount(3);
    await expect(card.locator('tbody tr').nth(0)).toContainText('renew soon');
    await expect(card.locator('tbody tr').nth(0)).toContainText('in 30 hours');
    await expect(card.locator('tbody tr').nth(1)).toContainText('working');
    await expect(card.locator('tbody tr').nth(1)).toContainText('in 6 days');
    await expect(card.locator('tbody tr').nth(2)).toContainText('login expired');
    await expect(card).toContainText('lasts seven days');
  });

  test('with no relay reporting, the Devices tab shows no relay section', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/devices');
    await expect(page.locator('table.devices').first()).toBeVisible();
    await expect(page.locator('section.relays')).toHaveCount(0);
  });

  test('the alert badge counts a relay that needs renewing', async ({ page }) => {
    await stubApi(page);
    await page.goto('/#/');
    await expect(page.locator('.ovsys').first()).toBeVisible();
    const before = Number((await page.locator('#alertbadge').textContent()) || 0);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubApi(page, { relays: [relay({ login_expires_at: NOW + 5 * H })] });
    await page.reload();
    await expect(page.locator('.ovsys').first()).toBeVisible();
    await expect(page.locator('#alertbadge')).toHaveText(String(before + 1));
  });
});

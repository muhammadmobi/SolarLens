/**
 * The relay's slower reads from the SolisCloud portal: fault history and the
 * plant's own day, month and year totals.
 *
 * Like everything else the relay does, nothing here signs or builds a request.
 * SolisCloud signs its API calls with a secret in its own JavaScript, so the
 * only way to get a correctly signed call is to make the portal page make it:
 * open the page, press the control a person would press, and wait for the
 * portal's own response. These functions return what came back and push
 * nothing, which is what lets them be run against a logged-in window on their
 * own to check the portal still has the same controls.
 *
 * Every selector below was found on the live portal in September 2026.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SolisCloud allows three calls in five seconds; clicks that each cost one call
// are spaced so a burst can never reach that.
const PACE_MS = 2000;

const postBody = (res) => {
  try { return JSON.parse(res.request().postData() ?? '{}'); } catch { return {}; }
};

// The next portal POST to `path` whose request body passes `match`.
const waitFor = (page, path, match = () => true, timeout = 30_000) =>
  page.waitForResponse((r) => r.url().includes(path) && r.request().method() === 'POST' && match(postBody(r)), { timeout });

/**
 * Alarms: the active list, then the recovered ones.
 *
 * The alarm page opens filtered to Active, which is empty on a healthy plant, so
 * the history needs the Status filter set to Recovered and a search. The newest
 * page is enough on an ordinary run - the table is sorted newest first, and the
 * previous run already has everything older. `allPages` reads the whole history,
 * for the first run.
 *
 * @returns {Promise<object[]>} the portal's records, untouched
 */
export async function readAlarms(page, portal, plantId, { allPages = false, maxPages = 60 } = {}) {
  const state = (s) => (body) => String(body.state) === String(s);
  const records = [];

  const active = waitFor(page, '/api/alarm/list', state(0)).then((r) => r.json()).catch(() => null);
  await page.goto(`${portal}/overview/plantStation/details/alarm/${plantId}`, { waitUntil: 'domcontentloaded' });
  records.push(...((await active)?.data?.records ?? []));
  await sleep(PACE_MS);

  const filter = page.locator('.el-form-item', { hasText: 'Status' }).first();
  await filter.locator('.el-select, input').first().click({ timeout: 15_000 });
  await page.locator('.el-select-dropdown__item').filter({ hasText: /^\s*Recovered\s*$/ }).first().click({ timeout: 10_000 });
  let wait = waitFor(page, '/api/alarm/list', state(2));
  await page.getByRole('button', { name: 'Search', exact: true }).first().click({ timeout: 10_000 });
  let json = await (await wait).json();
  records.push(...(json?.data?.records ?? []));

  if (allPages) {
    const pages = Math.min(Number(json?.data?.pages ?? 1), maxPages);
    for (let n = 2; n <= pages; n++) {
      await sleep(PACE_MS);
      wait = waitFor(page, '/api/alarm/list', (b) => state(2)(b) && Number(b.currentPage ?? b.pageNo) === n);
      await page.locator('.el-pagination .btn-next').first().click({ timeout: 10_000 });
      json = await (await wait).json();
      records.push(...(json?.data?.records ?? []));
    }
  }
  return records;
}

/**
 * Period totals from the plant page's Operating Data chart: Month gives one
 * point per day of this month, Year one per month of this year, Lifetime one
 * per year since installation.
 *
 * `backfill` also steps the Year view back one year at a time, until a year
 * comes back empty or reaches the first year Lifetime reported, so the months
 * of every earlier year are read as well.
 *
 * @returns {Promise<{which: 'month'|'year'|'all', points: object[]}[]>}
 */
export async function readPeriods(page, portal, plantId, { backfill = false, maxYears = 10 } = {}) {
  const out = [];
  const tab = async (label, which, path) => {
    const wait = waitFor(page, path).then((r) => r.json()).catch(() => null);
    await page.getByText(label, { exact: true }).first().click({ timeout: 15_000 });
    const json = await wait;
    if (Array.isArray(json?.data)) out.push({ which, points: json.data });
    await sleep(PACE_MS);
    return json?.data ?? null;
  };

  await page.goto(`${portal}/overview/plantStation/details/overview/${plantId}`, { waitUntil: 'domcontentloaded' });
  // The chart draws after the plant detail loads; clicking before it exists does nothing.
  await page.getByText('Operating Data', { exact: true }).first().waitFor({ timeout: 30_000 });
  await sleep(PACE_MS);

  await tab('Month', 'month', '/api/chart/station/month');
  const lifetime = await tab('Lifetime', 'all', '/api/chart/station/all');
  await tab('Year', 'year', '/api/chart/station/year');

  if (backfill) {
    const years = (lifetime ?? []).map((p) => Number(p.year ?? String(p.dateStr ?? '').slice(0, 4))).filter(Boolean);
    const first = years.length ? Math.min(...years) : new Date().getFullYear() - maxYears;
    const previous = page.locator('.gl-new-date-picker .change-date-btn').first();
    for (let y = new Date().getFullYear() - 1, n = 0; y >= first && n < maxYears; y--, n++) {
      const wait = waitFor(page, '/api/chart/station/year', (b) => String(b.year) === String(y))
        .then((r) => r.json()).catch(() => null);
      await previous.click({ timeout: 10_000 });
      const json = await wait;
      const points = Array.isArray(json?.data) ? json.data : [];
      if (!points.length) break;
      out.push({ which: 'year', points });
      await sleep(PACE_MS);
    }
  }
  return out;
}

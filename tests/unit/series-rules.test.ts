/**
 * Two rules the chart depends on, and neither had a test.
 *
 * A backfilled point and a live one can exist for the same instant: the relay
 * pushes today's curve from the portal, and it has already pushed the readings
 * it took itself. The series query prefers the live sample, because a
 * backfilled point is the vendor's five-minute average of what the live one
 * measured. And a window that opens "at midnight" has to mean each plant's own
 * midnight, falling back to the reader's only where the vendor never said.
 */
import { describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1';
import { dayStartSec, earliestDayStart, insertReading, nowSec, series, upsertInverter } from '../../src/db';
import { aliasFor } from '../../src/public-view';

// A system, and a reading from it, with only what a test cares about set.
const inverter = (over: Record<string, unknown> = {}) => ({
  id: 'soliscloud:station:p1', provider: 'soliscloud', vendorId: 'p1', serial: null,
  name: 'Plant', plantId: 'p1', plantName: 'Plant', capacityW: 12_000, tzOffsetSec: 5 * 3600,
  ...over,
});

const reading = (over: Record<string, unknown> = {}) => ({
  inverterId: 'soliscloud:station:p1', ts: 1_700_000_000, source: 'soliscloud-relay', acPowerW: 100,
  dcPowerW: null, todayKwh: null, totalKwh: null, batterySoc: null, batteryPowerW: null,
  gridPowerW: null, loadPowerW: null, tempC: null, status: null, metrics: null, raw: null,
  ...over,
});

describe('a backfilled point beside a live one', () => {
  it('serves the live sample, whichever arrived first', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, inverter() as never);

    // Backfill first, then the live reading for the same instant.
    await insertReading(d1.db, reading({ source: 'soliscloud-history', acPowerW: 800 }) as never);
    await insertReading(d1.db, reading({ source: 'soliscloud-relay', acPowerW: 850 }) as never);

    // And the other way round, at a different instant.
    await insertReading(d1.db, reading({ ts: 1_700_000_300, source: 'soliscloud-relay', acPowerW: 900 }) as never);
    await insertReading(d1.db, reading({ ts: 1_700_000_300, source: 'soliscloud-history', acPowerW: 700 }) as never);

    const rows = await series(d1.db, 1_699_999_000, 1_700_001_000);
    expect(rows.map((r) => r.ac_power_w)).toEqual([850, 900]);
    d1.close();
  });

  it('keeps a backfilled point when it is the only one for that instant', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, inverter() as never);
    await insertReading(d1.db, reading({ source: 'soliscloud-history', acPowerW: 640 }) as never);
    const rows = await series(d1.db, 1_699_999_000, 1_700_001_000);
    expect(rows.map((r) => r.ac_power_w)).toEqual([640]);
    d1.close();
  });
});

describe('re-pushing a sample the database already has', () => {
  it('stores no second row, and says so', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, inverter() as never);
    expect(await insertReading(d1.db, reading() as never)).toBe(true);
    expect(await insertReading(d1.db, reading({ acPowerW: 120 }) as never)).toBe(false);

    const rows = d1.raw.prepare('SELECT COUNT(*) AS n FROM readings').get() as { n: number };
    expect(rows.n).toBe(1);
    // The existing row's derived columns are refreshed, so improving a
    // normaliser reaches the newest sample without waiting for a new one.
    const stored = d1.raw.prepare('SELECT ac_power_w FROM readings').get() as { ac_power_w: number };
    expect(stored.ac_power_w).toBe(120);
    d1.close();
  });
});

describe('where a plant\'s day begins', () => {
  it('cuts the day at the plant\'s own midnight when the vendor said where it is', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, inverter({ tzOffsetSec: 5 * 3600 }) as never);
    await insertReading(d1.db, reading() as never);

    const at = nowSec();
    const start = await earliestDayStart(d1.db, at, 0);
    expect(start).toBe(dayStartSec(at, 5 * 3600));
    d1.close();
  });

  it('falls back to the reader\'s own offset for a plant the vendor never placed', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, inverter({ tzOffsetSec: null }) as never);
    await insertReading(d1.db, reading() as never);

    const at = nowSec();
    const readerOffset = -3 * 3600;
    expect(await earliestDayStart(d1.db, at, readerOffset)).toBe(dayStartSec(at, readerOffset));
    d1.close();
  });

  it('opens the window at the earliest of several plants\' midnights', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, inverter({ tzOffsetSec: 5 * 3600 }) as never);
    await upsertInverter(d1.db, inverter({ id: 'solarman:station:p2', vendorId: 'p2', plantId: 'p2', tzOffsetSec: 9 * 3600 }) as never);
    await insertReading(d1.db, reading() as never);
    await insertReading(d1.db, reading({ inverterId: 'solarman:station:p2' }) as never);

    const at = nowSec();
    // The further east a plant is, the later its midnight began in UTC terms,
    // so the earliest start is the westward one.
    expect(await earliestDayStart(d1.db, at, 0)).toBe(Math.min(dayStartSec(at, 5 * 3600), dayStartSec(at, 9 * 3600)));
    d1.close();
  });
});

describe('the alias map, given an id with no parts', () => {
  it('still answers for the whole id, and for an id it has never seen', () => {
    const alias = aliasFor(['plain-id', 'solarman:station:1']);
    expect(alias('plain-id')).toBe('s1');
    expect(alias('solarman:station:1')).toBe('s2');
    expect(alias('1')).toBe('s2');          // the trailing segment maps too
    expect(alias('never-seen')).toBe('unknown');
    expect(alias(null)).toBeNull();
  });
});

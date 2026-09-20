/**
 * A plant in a zone that observes daylight saving.
 *
 * The offset used to be a number on the inverter row, refreshed on every poll,
 * and every day of history was cut with whatever that number said today. So a
 * summer day, read back in winter, was cut an hour out - and for the five
 * minutes around the switch itself, so was the current day.
 *
 * Now the zone's own name is stored, and each reading carries the offset that
 * was in force at its own timestamp. These tests put readings either side of a
 * real switch and check each lands in the day it belongs to.
 */
import { describe, expect, it } from 'vitest';
import { createTestD1 } from '../helpers/d1';
import { daily, insertReading, upsertInverter } from '../../src/db';
import { offsetOfZoneAt, tzNameOf, tzOffsetSec } from '../../src/providers/units';

/** Europe/London: BST (+1) until 02:00 on 25 October 2026, GMT (+0) after. */
const SUMMER = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000);   // 15 July, midday UTC
const WINTER = Math.floor(Date.UTC(2026, 10, 15, 12, 0, 0) / 1000);  // 15 November, midday UTC

const london = (over: Record<string, unknown> = {}) => ({
  id: 'solarman:station:london', provider: 'solarman', vendorId: 'london', serial: null,
  name: 'London Plant', plantId: 'london', plantName: 'London Plant', capacityW: 4000,
  tzName: 'Europe/London', tzOffsetSec: 3600,
  ...over,
});

const reading = (ts: number, over: Record<string, unknown> = {}) => ({
  inverterId: 'solarman:station:london', ts, source: 'test', acPowerW: 500,
  dcPowerW: null, todayKwh: 10, totalKwh: null, batterySoc: null, batteryPowerW: null,
  gridPowerW: null, loadPowerW: null, tempC: null, status: null, metrics: null, raw: null,
  ...over,
});

describe('the zone itself', () => {
  it('is read from the vendor payload and kept, not only turned into a number', () => {
    expect(tzNameOf({ regionTimezone: 'Europe/London' })).toBe('Europe/London');
    expect(tzNameOf({ timeZone: 1 })).toBeNull();            // a number is not a place
    expect(tzNameOf({ regionTimezone: 'BST' })).toBeNull();  // nor is a label
  });

  it('answers a different offset either side of a switch', () => {
    expect(offsetOfZoneAt('Europe/London', SUMMER)).toBe(3600);
    expect(offsetOfZoneAt('Europe/London', WINTER)).toBe(0);
    // The same instant, in a zone that does not switch at all.
    expect(offsetOfZoneAt('Asia/Karachi', SUMMER)).toBe(5 * 3600);
    expect(offsetOfZoneAt('Asia/Karachi', WINTER)).toBe(5 * 3600);
  });

  it('answers null for a zone the runtime does not know', () => {
    expect(offsetOfZoneAt('Mars/Olympus_Mons', SUMMER)).toBeNull();
  });

  it('still reads a plain offset from a vendor that only sends one', () => {
    expect(tzOffsetSec({ timeZone: 5 })).toBe(5 * 3600);
  });
});

describe('a reading keeps the offset it was taken under', () => {
  it('stamps summer readings with +1 and winter readings with +0', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, london() as never);
    await insertReading(d1.db, reading(SUMMER) as never);
    await insertReading(d1.db, reading(WINTER) as never);

    const rows = d1.raw.prepare('SELECT ts, tz_offset_sec FROM readings ORDER BY ts').all() as { ts: number; tz_offset_sec: number }[];
    expect(rows).toEqual([
      { ts: SUMMER, tz_offset_sec: 3600 },
      { ts: WINTER, tz_offset_sec: 0 },
    ]);
    d1.close();
  });

  it('falls back to the plant\'s stored offset when the vendor never named the zone', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, london({ id: 'soliscloud:station:p', vendorId: 'p', plantId: 'p', tzName: null, tzOffsetSec: 5 * 3600 }) as never);
    await insertReading(d1.db, reading(SUMMER, { inverterId: 'soliscloud:station:p' }) as never);

    const row = d1.raw.prepare('SELECT tz_offset_sec FROM readings').get() as { tz_offset_sec: number };
    expect(row.tz_offset_sec).toBe(5 * 3600);
    d1.close();
  });
});

describe('a day of history, read back after the clocks change', () => {
  it('keeps a summer evening in its own day', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, london() as never);

    // 23:30 local on 15 July is 22:30 UTC, because London is +1 in July.
    const summerEvening = Math.floor(Date.UTC(2026, 6, 15, 22, 30, 0) / 1000);
    await insertReading(d1.db, reading(summerEvening, { todayKwh: 21 }) as never);

    // The plant is read in winter, when its current offset is +0. Cutting the
    // day with today's offset would push that evening into the 16th.
    d1.raw.prepare('UPDATE inverters SET tz_offset_sec = 0').run();

    const rows = await daily(d1.db, summerEvening - 86_400, summerEvening + 86_400, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe('2026-07-15');
    expect(rows[0].yield_kwh).toBe(21);
    d1.close();
  });

  it('puts two readings an hour apart across midnight into two days', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, london() as never);

    const beforeMidnight = Math.floor(Date.UTC(2026, 6, 15, 22, 45, 0) / 1000); // 23:45 local
    const afterMidnight = Math.floor(Date.UTC(2026, 6, 15, 23, 15, 0) / 1000);  // 00:15 local, next day
    await insertReading(d1.db, reading(beforeMidnight, { todayKwh: 30 }) as never);
    await insertReading(d1.db, reading(afterMidnight, { todayKwh: 0.2 }) as never);

    const rows = await daily(d1.db, beforeMidnight - 86_400, afterMidnight + 86_400, 0);
    expect(rows.map((r) => r.day)).toEqual(['2026-07-16', '2026-07-15']);
    d1.close();
  });

  it('still cuts the day for a plant nobody ever placed, using the reader\'s own offset', async () => {
    const d1 = createTestD1();
    await upsertInverter(d1.db, london({ tzName: null, tzOffsetSec: null }) as never);
    const at = Math.floor(Date.UTC(2026, 6, 15, 22, 30, 0) / 1000);
    await insertReading(d1.db, reading(at) as never);

    // The reader is five hours east, so that instant is already the 16th there.
    const rows = await daily(d1.db, at - 86_400, at + 86_400, -300);
    expect(rows[0].day).toBe('2026-07-16');
    d1.close();
  });
});

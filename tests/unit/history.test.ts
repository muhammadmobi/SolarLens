import { describe, expect, it } from 'vitest';
import { historyFromChart } from '../../src/providers/soliscloud';

/**
 * Backfill exists because the relay only records while it is running: a laptop
 * asleep until noon leaves the morning blank on a graph that then looks like a
 * system which produced nothing. The portal keeps the whole day.
 *
 * The chart payload is the least documented thing either vendor returns, so the
 * normaliser reads it defensively and these tests pin down what "defensively"
 * is allowed to mean. Anything that does not yield both a time and a number is
 * skipped rather than guessed at.
 */
describe('historyFromChart', () => {
  const noon = Date.UTC(2026, 8, 8, 7, 0, 0); // 12:00 in Asia/Karachi

  it('reads the documented shape: a power[] array under data', () => {
    const pts = historyFromChart({
      data: {
        power: [
          { time: noon, power: 8470, powerStr: 'W' },
          { time: noon + 300_000, power: 9170, powerStr: 'W' },
        ],
      },
    });
    expect(pts).toEqual([
      { ts: Math.floor(noon / 1000), acPowerW: 8470 },
      { ts: Math.floor(noon / 1000) + 300, acPowerW: 9170 },
    ]);
  });

  it('scales through the paired unit string, like every other Solis field', () => {
    const pts = historyFromChart({ power: [{ time: noon, power: 8.47, powerStr: 'kW' }] });
    expect(pts[0].acPowerW).toBe(8470);
  });

  it('accepts epoch seconds as well as milliseconds', () => {
    const secs = Math.floor(noon / 1000);
    expect(historyFromChart({ power: [{ time: secs, power: 100 }] })[0].ts).toBe(secs);
  });

  it('accepts a local datetime string', () => {
    const pts = historyFromChart({ power: [{ time: '2026-09-08 12:00:00', power: 100 }] });
    expect(pts[0].ts).toBe(Math.floor(Date.parse('2026-09-08T12:00:00') / 1000));
  });

  it('finds the series under the other keys the portal has used', () => {
    for (const key of ['dataList', 'records', 'list', 'chartData']) {
      const pts = historyFromChart({ data: { [key]: [{ time: noon, value: 500 }] } });
      expect(pts, key).toHaveLength(1);
      expect(pts[0].acPowerW, key).toBe(500);
    }
  });

  it('sorts by time, whatever order the payload arrived in', () => {
    const pts = historyFromChart({
      power: [
        { time: noon + 600_000, power: 3 },
        { time: noon, power: 1 },
        { time: noon + 300_000, power: 2 },
      ],
    });
    expect(pts.map((p) => p.acPowerW)).toEqual([1, 2, 3]);
  });

  it('trims the zeros the portal pads the rest of the day with', () => {
    // The chart runs to midnight whatever the time is; those trailing zeros are
    // the axis, not readings, and storing them would draw a flat line across
    // the evening as though the inverter had reported one.
    const pts = historyFromChart({
      power: [
        { time: noon, power: 8470 },
        { time: noon + 300_000, power: 9170 },
        { time: noon + 600_000, power: 0 },
        { time: noon + 900_000, power: 0 },
      ],
    });
    expect(pts).toHaveLength(2);
  });

  it('keeps a zero that sits between two real readings', () => {
    const pts = historyFromChart({
      power: [
        { time: noon, power: 100 },
        { time: noon + 300_000, power: 0 },
        { time: noon + 600_000, power: 200 },
      ],
    });
    expect(pts.map((p) => p.acPowerW)).toEqual([100, 0, 200]);
  });

  it('skips rows missing either half, rather than inventing the other', () => {
    const pts = historyFromChart({
      power: [
        { time: noon, power: 100 },
        { power: 200 },              // no time
        { time: noon + 600_000 },    // no value
        { time: 'not a date', power: 300 },
        null,
        'nonsense',
      ],
    });
    expect(pts).toEqual([{ ts: Math.floor(noon / 1000), acPowerW: 100 }]);
  });

  it('returns nothing for a payload with no series at all', () => {
    expect(historyFromChart({})).toEqual([]);
    expect(historyFromChart({ data: { power: [] } })).toEqual([]);
    expect(historyFromChart(null)).toEqual([]);
    expect(historyFromChart('not json')).toEqual([]);
  });

  it('reads a bare array, for a response that skips the wrapper', () => {
    expect(historyFromChart([{ time: noon, power: 42 }])).toHaveLength(1);
  });
});

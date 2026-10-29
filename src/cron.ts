/**
 * The Worker's two crons, told apart by their expressions (wrangler.jsonc
 * triggers; src/index.ts scheduled hands each its work).
 *
 * - Every five minutes: poll every vendor, then judge notifications - the
 *   readings and the alerts, and nothing else, so that run stays small.
 * - Once an hour (hourly, below): the week's agents and summary when they are
 *   due, the weather, and the housekeeping.
 *
 * Kept out of src/index.ts so the Worker's entry module exports its handlers
 * and nothing else.
 */
import type { Env } from './db';
import { forgetExpiredKv, forgetOldDeviceSamples, forgetOldRaw, nowSec } from './db';
import { runWeeklyAgents } from './agents';
import { sendWeekly } from './summary';
import { refreshWeather } from './weather';
import { forgetOldMessages } from './push';
import { resealChannels } from './channels';

/** The crons, as wrangler.jsonc sets them: readings and alerts every five minutes, everything slower once an hour. */
export const FIVE_MINUTES = '*/5 * * * *';
export const HOURLY = '7 * * * *';

/**
 * One run of the hourly cron: the week's agents and summary when they are due,
 * the weather, and the housekeeping.
 *
 * These rode on the five-minute run until 3.0's review, which measured what
 * that cost on a Monday: every step of the week in one invocation - ninety-odd
 * database queries, where the free plan allows fifty - and a failure in any one
 * could take the rest with it. Now the five-minute run keeps to the readings
 * and the alerts, and this runs once an hour, each step on its own: a failure
 * is logged and the next step runs. In the hour the week's agents run, the
 * rest waits for the next: the agents are the heaviest thing any run does, and
 * the weekly summary waits for their report in any case (./summary sendWeekly).
 */
export async function hourly(env: Env, now = nowSec()): Promise<void> {
  let agentsRan = false;
  try {
    agentsRan = await runWeeklyAgents(env, now);
  } catch (e) {
    console.error('agents:', String(e));
  }
  if (agentsRan) return;
  const steps: [string, () => Promise<unknown>][] = [
    ['summary', () => sendWeekly(env, now)],
    ['weather', () => refreshWeather(env.DB, now)],
    ['housekeeping', async () => {
      await forgetOldMessages(env.DB, now);
      await forgetOldDeviceSamples(env.DB, now);
      await forgetExpiredKv(env.DB, now);
      await forgetOldRaw(env.DB, now);
      await resealChannels(env);
    }],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      console.error(`${name}:`, String(e));
    }
  }
}

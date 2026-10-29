// Types for watch.mjs, which the watcher workflow runs as plain JavaScript and
// the unit tests import from TypeScript.
export const STALE_MIN: number;
export interface StatusAnswer {
  ok?: boolean;
  status?: number;
  error?: string;
  body?: { feeds?: { provider: string; ok: number | boolean; ts: number }[] } | null;
}
export function judge(res: StatusAnswer | null, now?: number): { state: 'ok' | 'stale' | 'down'; lines: string[] };

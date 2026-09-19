/**
 * A D1 database, for tests, backed by real SQLite.
 *
 * The Worker's routes and every line of SQL in `src/db.ts` had no automated
 * test at all: the end-to-end suite stubs `/api/*`, so nothing exercised the
 * queries themselves until they ran in production. The reason was that D1 needs
 * Cloudflare's runtime - but D1 *is* SQLite, and Node ships one. This adapts
 * `node:sqlite` to the slice of the D1 interface the Worker actually uses:
 * `prepare().bind().all() / .first() / .run()`, and `batch()`.
 *
 * What it does not reproduce is workerd itself - `crypto.subtle`, the asset
 * binding, real network. Those are covered by the end-to-end suite, the probe
 * scripts, and the smoke test that runs after every deploy.
 *
 * Node 22 keeps `node:sqlite` behind `--experimental-sqlite`, which the test
 * script passes; Node 24 and newer need no flag and ignore it.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, unknown>;

/** D1 speaks `?1`, `?2`; node:sqlite binds named parameters, so they are rewritten. */
function toNamed(sql: string): { sql: string; numbered: boolean } {
  if (!/\?\d/.test(sql)) return { sql, numbered: false };
  return { sql: sql.replace(/\?(\d+)/g, (_, n) => `:p${n}`), numbered: true };
}

/**
 * SQLite accepts anything; D1 refuses a bound value that is not a primitive.
 * Catching that here is the point - an object bound by mistake reaches
 * production as "D1_TYPE_ERROR", which is a poor way to find out.
 */
function checkBindable(values: unknown[]): void {
  for (const v of values) {
    if (v === null || ['string', 'number', 'bigint', 'boolean'].includes(typeof v)) continue;
    throw new TypeError(`D1 cannot bind a ${typeof v}: ${JSON.stringify(v)}`);
  }
}

export interface TestD1 {
  db: D1Database;
  /** Every statement run, in order: what a test asserts about when the SQL matters. */
  sql: string[];
  /** Straight SQLite, for arranging state or checking it without going through D1. */
  raw: DatabaseSync;
  close(): void;
}

export function createTestD1(options: { migrationsDir?: string } = {}): TestD1 {
  const sqlite = new DatabaseSync(':memory:');
  const sql: string[] = [];

  const bindValues = (stmt: ReturnType<DatabaseSync['prepare']>, numbered: boolean, values: unknown[]) => {
    if (!numbered) return stmt as unknown as { all(...a: unknown[]): Row[] };
    return stmt as unknown as { all(...a: unknown[]): Row[] };
  };

  const run = (text: string, values: unknown[], kind: 'all' | 'run' | 'get') => {
    const { sql: prepared, numbered } = toNamed(text);
    const stmt = sqlite.prepare(prepared);
    const args = numbered
      ? [Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v as never]))]
      : values;
    if (kind === 'all') return stmt.all(...(args as never[])) as Row[];
    if (kind === 'get') return (stmt.get(...(args as never[])) ?? null) as Row | null;
    return stmt.run(...(args as never[]));
  };

  const makeStatement = (text: string, values: unknown[] = []): D1PreparedStatement => ({
    bind(...next: unknown[]) {
      checkBindable(next);
      return makeStatement(text, next);
    },
    async all<T = Row>() {
      sql.push(text);
      const results = run(text, values, 'all') as T[];
      return { results, success: true, meta: {} } as D1Result<T>;
    },
    async first<T = Row>(column?: string) {
      sql.push(text);
      const row = run(text, values, 'get') as Row | null;
      if (row === null) return null as never;
      return (column === undefined ? row : row[column]) as never;
    },
    async run<T = Row>() {
      sql.push(text);
      const res = run(text, values, 'run') as { changes: number | bigint; lastInsertRowid: number | bigint };
      return {
        results: [] as T[],
        success: true,
        meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) },
      } as unknown as D1Result<T>;
    },
    async raw<T = unknown[]>() {
      sql.push(text);
      const rows = run(text, values, 'all') as Row[];
      return rows.map((r) => Object.values(r)) as T[];
    },
  }) as unknown as D1PreparedStatement;

  const db = {
    prepare: (text: string) => makeStatement(text),
    async batch<T = Row>(statements: D1PreparedStatement[]) {
      const out: D1Result<T>[] = [];
      for (const s of statements) out.push(await s.run<T>());
      return out;
    },
    async exec(text: string) {
      sqlite.exec(text);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
    withSession: () => { throw new Error('sessions are not used by this Worker'); },
  } as unknown as D1Database;

  const dir = options.migrationsDir ?? 'migrations';
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(dir, file), 'utf8'));
  }

  return { db, sql, raw: sqlite, close: () => sqlite.close() };
}

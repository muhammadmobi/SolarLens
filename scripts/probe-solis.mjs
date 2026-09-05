#!/usr/bin/env node
/**
 * Standalone SolisCloud signing probe. Runs in plain Node with node:crypto so a
 * signature bug can be isolated without a Worker, a database, or a cron in the
 * way. Prints the raw vendor JSON, which is also how we learn the real field
 * names for your inverters before tightening the normaliser.
 *
 *   npm run probe:solis           # stations only
 *   npm run probe:solis -- --deep # stations -> inverters -> detail for each
 *
 * Reads SOLIS_KEY_ID / SOLIS_KEY_SECRET from the environment or from .dev.vars.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE_URL = 'https://www.soliscloud.com:13333';
const CONTENT_TYPE = 'application/json';

function loadDevVars() {
  try {
    for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .dev.vars — rely on the environment */
  }
}
loadDevVars();

const keyId = process.env.SOLIS_KEY_ID;
const keySecret = process.env.SOLIS_KEY_SECRET;
if (!keyId || !keySecret) {
  console.error('Set SOLIS_KEY_ID and SOLIS_KEY_SECRET (env or .dev.vars). Get them at SolisCloud -> Service -> API Management.');
  process.exit(1);
}

function headersFor(path, body) {
  const md5 = createHash('md5').update(body).digest('base64');
  const date = new Date().toUTCString();
  const stringToSign = ['POST', md5, CONTENT_TYPE, date, path].join('\n');
  const sign = createHmac('sha1', keySecret).update(stringToSign).digest('base64');
  return { 'Content-Type': CONTENT_TYPE, 'Content-MD5': md5, Date: date, Authorization: `API ${keyId}:${sign}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(BASE_URL + path, { method: 'POST', headers: headersFor(path, body), body });
  const text = await res.text();
  console.log(`\n=== POST ${path}  ->  HTTP ${res.status}`);
  if (res.status === 408) console.log('408 = your clock is >15 min off SolisCloud time. Sync it and retry.');
  let json;
  try { json = JSON.parse(text); } catch { console.log(text); throw new Error('non-JSON response'); }
  console.log(JSON.stringify(json, null, 2));
  if (!(json.success === true || String(json.code) === '0')) throw new Error(`API error code=${json.code} msg=${json.msg}`);
  await sleep(2000); // 3 calls / 5 s per IP
  return json.data;
}

const deep = process.argv.includes('--deep');

const stations = await call('/v1/api/userStationList', { pageNo: 1, pageSize: 20 });
if (!deep) {
  console.log('\nSignature OK. Re-run with --deep to walk inverters and their detail payloads.');
  process.exit(0);
}
for (const st of stations?.page?.records ?? []) {
  const invs = await call('/v1/api/inverterList', { pageNo: 1, pageSize: 20, stationId: st.id });
  for (const inv of invs?.page?.records ?? []) {
    await call('/v1/api/inverterDetail', { id: inv.id, sn: inv.sn });
  }
}

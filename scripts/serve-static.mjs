// Minimal static server for public/ - used by the Playwright e2e suite so the
// dashboard can be tested without a Worker. Any /api/* request is answered 404
// here; the tests intercept those routes in the browser and supply fixtures.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'public');
const PORT = Number(process.env.PORT ?? 4173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('no api in static mode'); return; }
  let file = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

// Two browser projects running 30-odd tests in parallel reuse keep-alive
// sockets hard. Node's 5 s default closes an idle one just as the browser
// sends its next request on it, which surfaces as a flaky
// "net::ERR_ABORTED; maybe frame was detached?" on page.goto. Outliving the
// whole suite removes the race; a generous backlog absorbs the burst at start.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.listen(PORT, '127.0.0.1', 512, () => console.log(`static: http://127.0.0.1:${PORT}/  (serving ${ROOT})`));

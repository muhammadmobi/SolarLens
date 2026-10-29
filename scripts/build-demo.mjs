/**
 * Build the demo: the real dashboard, running on made-up data, as a static site
 * for GitHub Pages.
 *
 * It is public/ as it ships, with two changes and nothing else:
 *
 * - demo/demo.js is loaded before the dashboard's own script. It answers every
 *   /api and /auth request with sample data, and puts a banner above the page
 *   saying so.
 * - Paths that start at the site's root - "/icon.svg" - are made relative.
 *   GitHub Pages serves a project under /<repository>/, not at the root, so a
 *   root path would reach the owner's own site instead of this one.
 *
 * The service worker and the web-app manifest are left out: the demo is a page
 * to look at, not an app to install, and a worker registered under the Pages
 * root would outlive the visit.
 *
 * Usage: node scripts/build-demo.mjs [out]   (out defaults to site/)
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function buildDemo(out = 'site') {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  let html = readFileSync('public/index.html', 'utf8');
  // Relative, not root-absolute: see the note above.
  html = html.replace(/(src|href)="\/(?!\/)/g, '$1="./');
  // No manifest: nothing to install.
  html = html.replace(/\s*<link rel="manifest"[^>]*>/, '');
  // The demo script first, so its answers are in place before the dashboard asks.
  const head = html.indexOf('<head>');
  if (head < 0) throw new Error('public/index.html has no <head>');
  html = `${html.slice(0, head + 6)}\n<script src="./demo.js"></script>${html.slice(head + 6)}`;
  // The worker is not registered in the demo; see above.
  html = html.replace("navigator.serviceWorker.register('/sw.js').catch(() => {});", '/* no service worker in the demo */');
  writeFileSync(join(out, 'index.html'), html);

  copyFileSync('demo/demo.js', join(out, 'demo.js'));
  for (const f of ['icon.svg', 'icon-192.png', 'icon-512.png']) copyFileSync(join('public', f), join(out, f));
  // GitHub Pages runs Jekyll over a site unless told not to, and Jekyll drops
  // files it does not recognise.
  writeFileSync(join(out, '.nojekyll'), '');
  return out;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const out = buildDemo(process.argv[2] ?? 'site');
  console.log(`demo built in ${out}/`);
}

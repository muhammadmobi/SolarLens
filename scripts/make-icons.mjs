/**
 * Render public/icon.svg to the PNG sizes a web app manifest needs.
 *
 * The project has no build step on purpose, so these are generated once and
 * committed rather than produced at deploy time. Re-run after editing the SVG:
 *
 *   node scripts/make-icons.mjs
 *
 * Playwright is already a dev dependency for the end-to-end suite, so this
 * needs no new tooling. Chromium rasterises the same SVG the browser tab does,
 * which is the point: the installed icon and the favicon cannot drift.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SVG = path.join(ROOT, 'public', 'icon.svg');
const SIZES = [192, 512];

// Installed icons are drawn on the launcher's own surface, which is not the
// page's. A transparent PNG picks up whatever is behind it - black on some
// Android launchers - so the ground is painted in, matching the light theme.
const GROUND = '#f7f6f2';

const svg = await fs.readFile(SVG, 'utf8');
// The e2e suite drives the Chrome already on the machine rather than a
// downloaded build, so this uses the same one - no extra install to keep green.
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:${GROUND}}
       svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
      { waitUntil: 'load' },
    );
    const out = path.join(ROOT, 'public', `icon-${size}.png`);
    await page.screenshot({ path: out, omitBackground: false });
    const { size: bytes } = await fs.stat(out);
    console.log(`icon-${size}.png  ${bytes} bytes`);
    await page.close();
  }
} finally {
  await browser.close();
}

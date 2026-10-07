// Launch the Chromium bundled in a packaged app, as the app does for コドモン・みてね. Usage: node scripts/smoke-browser.mjs <App>.app
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const base = join(process.argv[2], 'Contents/Resources/browsers');
const executable = readdirSync(base).filter(x => /^chromium-\d+$/.test(x)).sort().reverse()
  .map(folder => join(base, folder, `chrome-mac-${process.arch}`, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find(existsSync);
assert.ok(executable, `chrome-mac-${process.arch} のブラウザが同梱されていません`);
const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<p id="ok">ok</p>');
  assert.equal(await page.textContent('#ok'), 'ok');
  console.log(`PASS bundled browser: ${process.arch} Chromium ${browser.version()}`);
} finally { await browser.close(); }

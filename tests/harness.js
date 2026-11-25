// Opens the Scheduler in a headless browser as a preview (sample data, nothing saved or sent),
// so the page can be checked without touching real data. Nothing here reaches MISMO except a
// read of the shared Back helper, which is tested as it is live.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOST = 'http://sched.test/scheduler/';

/* Playwright's own browser if it is installed, otherwise the machine's Chrome or Chromium */
async function launch() {
  try { return await chromium.launch(); } catch (e) {
    for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
      if (fs.existsSync(p)) return chromium.launch({ executablePath: p });
    }
    throw e;
  }
}

async function open(opts = {}) {
  const browser = opts.browser || await launch();
  const page = await browser.newPage({ viewport: { width: opts.w || 1440, height: opts.h || 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.route('**/*', async r => {
    const u = r.request().url();
    if (u.includes('/assets/back.js')) return r.fulfill({ contentType: 'application/javascript', body: await backJs() });
    if (u.startsWith(HOST)) {
      const f = u.slice(HOST.length).split(/[?#]/)[0] || 'index.html';
      const file = path.join(ROOT, f);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) return r.fulfill({ status: 404, body: '' });
      const type = f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html';
      return r.fulfill({ body: fs.readFileSync(file), contentType: type });
    }
    return r.abort();
  });
  await page.goto(HOST + (opts.hash || ''));
  await page.waitForTimeout(opts.settle || 2500);
  return { browser, page, errs, close: () => opts.browser ? page.close() : browser.close() };
}

/* The shared Back-button helper (resources.mismo.org/assets/back.js) is tested as it is live:
   MISMO_BACK can point at a local copy instead (for trying a change before it is published). */
let BACK = null;
async function backJs() {
  if (BACK !== null) return BACK;
  try {
    if (process.env.MISMO_BACK) BACK = fs.readFileSync(process.env.MISMO_BACK, 'utf8');
    else { const r = await fetch('https://resources.mismo.org/assets/back.js'); BACK = r.ok ? await r.text() : ''; }
  } catch (e) { BACK = ''; }
  return BACK;
}

module.exports = { open, launch, ROOT };

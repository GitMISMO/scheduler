// Scheduler page checks. Run with:  npm test   (or: node tests/run.js [part of a check's name])
// Every check opens the page as a preview with its sample data, so nothing real is read,
// saved or sent. The run fails (exit code 1) if any check fails.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { open, launch, ROOT } = require('./harness');

const results = [];
const only = process.argv.slice(2);
async function check(name, fn) {
  if (only.length && !only.some(o => name.toLowerCase().includes(o.toLowerCase()))) return;
  try { await fn(); results.push({ name, ok: true }); console.log('  PASS  ' + name); }
  catch (e) { results.push({ name, ok: false }); console.log('  FAIL  ' + name + '\n        ' + String(e.message).split('\n').join('\n        ')); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
const noErrors = errs => expect(!errs.length, 'Page errors:\n' + errs.join('\n'));

(async () => {
  const browser = await launch();
  const opts = o => Object.assign({ browser }, o || {});

  /* 1. Every script reads as valid JavaScript */
  await check('Every script parses', async () => {
    const bad = [];
    for (const f of fs.readdirSync(ROOT).filter(f => f.endsWith('.js'))) {
      try { new vm.Script(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f }); } catch (e) { bad.push(f + ': ' + e.message); }
    }
    for (const f of fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g; let m, i = 0;
      while ((m = re.exec(html))) { i++; try { new vm.Script(m[2], { filename: f + ' script ' + i }); } catch (e) { bad.push(f + ' script ' + i + ': ' + e.message); } }
    }
    expect(!bad.length, bad.join('\n'));
  });

  /* 2. Every page in the left menu, and Help, opens with no errors */
  await check('Every page opens without errors', async () => {
    const s = await open(opts());
    for (const tab of ['stats', 'health', 'help', 'dash']) {
      await s.page.click('[data-hq="' + tab + '"]'); await s.page.waitForTimeout(600);
      const cur = await s.page.evaluate(() => [...document.querySelectorAll('[data-hq][aria-current]')].map(b => b.dataset.hq).join(','));
      expect(cur === tab, tab + ' did not become the marked page (aria-current on ' + cur + ')');
    }
    noErrors(s.errs); await s.close();
  });

  /* 3. The browser's Back button (CN-033, Nov 25, 2026): the shared /assets/back.js, loaded
        right after session.js; the page adds no history steps of its own */
  await check('Back helper is loaded the shared way', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(/session\.js[^\n]*\n<script src="\/assets\/back\.js"><\/script>/.test(html), 'index.html should load /assets/back.js on the line right after session.js');
    expect(!fs.existsSync(path.join(ROOT, 'back.js')), 'back.js must not be copied into this repository');
    for (const f of fs.readdirSync(ROOT).filter(f => f.endsWith('.js')))
      expect(!/history\.pushState/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f + ' adds its own history.pushState');
  });

  await check('Back button: closes the panel or dialog, then returns to the last page', async () => {
    const s = await open(opts());
    const state = () => s.page.evaluate(() => ({
      tab: (document.querySelector('[data-hq][aria-current]') || {}).dataset?.hq || '',
      pane: !!document.querySelector('#pane.on'), dlg: document.querySelectorAll('.scrim').length,
      hash: location.hash, helper: !!window.MismoBack }));
    expect((await state()).helper, 'the shared Back helper (/assets/back.js) did not load');
    const go = async tab => { await s.page.click('[data-hq="' + tab + '"]'); await s.page.waitForTimeout(700); };
    const back = async () => { await s.page.evaluate(() => history.back()); await s.page.waitForTimeout(900); };
    const start = (await state()).tab;
    expect(start === 'dash', 'the page should open on the Dashboard: ' + start);
    await go('stats'); await go('health');
    let st = await state(); expect(st.tab === 'health', 'System Health did not open: ' + JSON.stringify(st));
    await back(); st = await state(); expect(st.tab === 'stats', 'Back from System Health should land on Statistics: ' + JSON.stringify(st));
    await s.page.evaluate(() => history.forward()); await s.page.waitForTimeout(900);
    st = await state(); expect(st.tab === 'health', 'Forward should go to System Health again: ' + JSON.stringify(st));
    await back(); await back(); st = await state(); expect(st.tab === 'dash', 'Back twice should land on the Dashboard: ' + JSON.stringify(st));
    /* Help, outside the menu, is a page too */
    await go('help'); await back(); st = await state(); expect(st.tab === 'dash', 'Back from Help should land on the Dashboard: ' + JSON.stringify(st));
    /* a request in the panel: Back closes it and stays on the page */
    await go('stats'); await go('dash');
    await s.page.click('#app .row'); await s.page.waitForTimeout(800);
    expect((await state()).pane, 'a request did not open in the right-hand panel');
    await back(); st = await state();
    expect(!st.pane && st.tab === 'dash', 'Back should close the panel and stay on the Dashboard: ' + JSON.stringify(st));
    await back(); st = await state(); expect(st.tab === 'stats', 'Back after the panel should go to the page before: ' + JSON.stringify(st));
    /* closing the panel with its × leaves no step behind */
    await go('dash'); await s.page.click('#app .row'); await s.page.waitForTimeout(800);
    await s.page.click('#pane .pane-x'); await s.page.waitForTimeout(800);
    expect(!(await state()).pane, 'the × did not close the panel');
    await back(); st = await state(); expect(st.tab === 'stats' && !st.pane, 'after closing the panel with ×, Back should go straight to the page before: ' + JSON.stringify(st));
    /* a dialog over the panel: Back closes the dialog, then the panel */
    await go('dash'); await s.page.click('#app .row'); await s.page.waitForTimeout(800);
    const opened = await s.page.evaluate(() => { const b = [...document.querySelectorAll('#pane-b button')].find(x => /^Edit/.test(x.textContent.trim())); if (b) b.click(); return !!b; });
    await s.page.waitForTimeout(800);
    expect(opened && (await state()).dlg === 1, 'Edit details did not open a dialog');
    await back(); st = await state(); expect(st.dlg === 0 && st.pane, 'Back should close the dialog and leave the panel open: ' + JSON.stringify(st));
    await back(); st = await state(); expect(!st.pane && st.tab === 'dash', 'Back should then close the panel: ' + JSON.stringify(st));
    expect(st.hash === '', 'the address changed: ' + st.hash);
    noErrors(s.errs); await s.close();
  });

  /* 4. A link from an email or a Team HQ task (#r=<id>) still opens that request */
  await check('A #r= link opens the request, and closing it tidies the address', async () => {
    const s0 = await open(opts());
    const id = await s0.page.evaluate(() => (window.allReqs()[0] || {}).id); await s0.close();
    expect(id, 'the preview has no sample requests');
    const s = await open(opts({ hash: '#r=' + id }));
    expect(await s.page.evaluate(() => !!document.querySelector('#pane.on')), 'the #r= link did not open the request');
    await s.page.click('#pane .pane-x'); await s.page.waitForTimeout(600);
    expect(await s.page.evaluate(() => !document.querySelector('#pane.on') && location.hash === ''), 'closing the request did not close it and tidy the address');
    noErrors(s.errs); await s.close();
  });

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' of ' + results.length + ' checks passed.');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

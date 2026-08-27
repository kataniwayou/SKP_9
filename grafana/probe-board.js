// Load the whole board once and collect what a panel-by-panel probe cannot see:
// browser console errors, failed network calls, and whether the template variables
// actually resolved. A panel can render perfectly while a variable silently fell back
// to its "All" default, which is how a board looks fine and filters nothing.
const { chromium } = require('playwright');

const URL = process.env.GRAFANA_URL || 'http://localhost:13000';
const BOARD = process.env.BOARD || 'skp-processor';
const OUT = process.env.OUT_DIR || '.';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 2400 } });

  const errors = [];
  const failed = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + String(e).slice(0, 200)));
  page.on('response', r => {
    if (r.status() >= 400) failed.push(r.status() + ' ' + r.url().slice(0, 120));
  });

  await page.goto(`${URL}/d/${BOARD}/${BOARD}?from=now-30m&to=now&kiosk`,
                  { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForSelector('[data-testid^="data-testid Panel header"]', { timeout: 60000 });
  await page.waitForTimeout(6000);

  const vars = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="data-testid Dashboard template variables"]')]
      .map(el => el.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean));

  const panels = await page.evaluate(() => {
    const out = [];
    for (const h of document.querySelectorAll('[data-testid^="data-testid Panel header"]')) {
      const s = h.closest('section');
      out.push({
        title: h.innerText.replace(/\s+/g, ' ').trim(),
        error: !!s?.querySelector('[data-testid="data-testid Panel status error"]'),
        noData: /No data/i.test(s ? s.innerText : ''),
      });
    }
    return out;
  });

  await page.screenshot({ path: OUT + '/board-full.png', fullPage: true });

  console.log('variables on screen:');
  vars.forEach(v => console.log('   ' + v));
  console.log('\npanels rendered on the open board: ' + panels.length);
  const bad = panels.filter(p => p.error);
  console.log('panels in ERROR state: ' + (bad.length ? bad.map(p => p.title).join(', ') : 'none'));
  const nd = panels.filter(p => p.noData);
  console.log('panels reading No data: ' + (nd.length ? nd.map(p => p.title).join(', ') : 'none'));

  const noisy = errors.filter(e => !/xychart|already registered/i.test(e));
  console.log('\nconsole errors (' + noisy.length + '):');
  noisy.slice(0, 12).forEach(e => console.log('   ' + e));
  const realFail = failed.filter(f => !/\/api\/live\/|favicon|\/avatar\//.test(f));
  console.log('\nfailed requests (' + realFail.length + '):');
  realFail.slice(0, 12).forEach(f => console.log('   ' + f));

  await browser.close();
})();

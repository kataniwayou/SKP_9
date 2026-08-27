// Render the processor board's runtime row panel by panel, the same way probe-panels.js
// reads the pipeline thirteen: open each panel in a real browser and look at what draws.
// The row is COLLAPSED on the board, so `viewPanel=<id>` is the only way to see them.
// Pass BOARD and GRAFANA_URL to point it elsewhere; OUT_DIR receives one PNG per panel.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.GRAFANA_URL || 'http://localhost:13000';
const BOARD = process.env.BOARD || 'skp-processor';
const OUT = process.env.OUT_DIR || '.';
const REPO = __dirname;

fs.mkdirSync(OUT, { recursive: true });
const board = JSON.parse(fs.readFileSync(path.join(REPO, 'dashboards', BOARD + '.json'), 'utf8'));
// The COLLAPSED row, found by structure rather than by title: only a collapsed row
// nests its children, and titles have already changed once under this script.
const rt = board.panels.find(p => p.type === 'row' && (p.panels || []).length);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const results = [];

  for (const panel of rt.panels) {
    const url = URL + '/d/' + BOARD + '/' + BOARD + '?viewPanel=' + panel.id + '&from=now-30m&to=now&kiosk';
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('[data-testid^="data-testid Panel header"]', { timeout: 60000 });
    try {
      await page.waitForFunction(() => !document.body.innerText.includes('Cancel'), { timeout: 45000 });
    } catch { console.log('  (still in flight, capturing anyway)'); }
    await page.waitForTimeout(2500);

    const st = await page.evaluate(() => {
      const s = document.querySelector('[data-testid^="data-testid Panel header"]')?.closest('section');
      const body = s ? s.innerText : document.body.innerText;
      return {
        noData: /No data/i.test(body),
        error: !!s?.querySelector('[data-testid="data-testid Panel status error"]'),
        text: body.replace(/\s+/g, ' ').slice(0, 160),
      };
    });

    const verdict = st.error ? 'ERROR' : st.noData ? 'NO DATA' : 'DRAWS';
    await page.screenshot({ path: path.posix.join(OUT, 'rt-' + panel.id + '.png') });
    console.log('  ' + verdict.padEnd(8) + ' ' + panel.title);
    console.log('           ' + st.text);
    results.push(verdict);
  }

  await browser.close();
  const bad = results.filter(r => r !== 'DRAWS').length;
  console.log('\n  ' + (results.length - bad) + '/' + results.length + ' draw.');
  process.exit(bad ? 1 : 0);
})();

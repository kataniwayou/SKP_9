// Screenshot every SKP Grafana board and report what each panel actually rendered.
//
// The point is not the pictures. Two defects in these boards were invisible to a query
// check and visible only on screen: a p95 reading 4.9s because the histogram buckets were
// a millisecond ladder, and a board showing another service's data because an All value
// was ".*". So this walks each panel and reports its rendered state -- No data, an error
// corner, or a value -- which is the thing a PromQL check cannot see.

const { chromium } = require('playwright');

const TARGET_URL = process.env.GRAFANA_URL || 'http://localhost:13000';
const OUT = process.env.OUT_DIR || 'C:\\Users\\UserL\\AppData\\Local\\Temp\\claude\\C--Users-UserL-source-repos-SK-P9\\8e2b26df-9d8c-4e55-980d-3d7009ffab18\\scratchpad';

const BOARDS = [
  { uid: 'skp-flow', slug: 'skp-flow', name: 'SKP Flow' },
  { uid: 'skp-baseapi', slug: 'skp-baseapi', name: 'SKP BaseAPI' },
  { uid: 'skp-orchestrator', slug: 'skp-orchestrator', name: 'SKP Orchestrator' },
  { uid: 'skp-processor', slug: 'skp-processor', name: 'SKP Processor' },
];

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1800, height: 2600 } });

  const report = [];

  for (const board of BOARDS) {
    const url = `${TARGET_URL}/d/${board.uid}/${board.slug}?from=now-1h&to=now&kiosk`;
    console.log(`\n=== ${board.name} ===`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

    // Grafana paints panel frames before the queries return. Wait for the frames, then
    // for the queries: the refresh control reads "Cancel" while any query is in flight.
    await page.waitForSelector('[data-testid^="data-testid Panel header"]', { timeout: 60000 });
    try {
      await page.waitForFunction(
        () => !document.body.innerText.includes('Cancel'),
        { timeout: 45000 },
      );
    } catch {
      console.log('  (queries still in flight after 45s -- capturing anyway)');
    }
    await page.waitForTimeout(3000);

    const panels = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[data-testid^="data-testid Panel header"]')) {
        const section = el.closest('section') || el.parentElement;
        const title = (el.innerText || '').trim().split('\n')[0];
        const body = section ? (section.innerText || '') : '';
        out.push({
          title,
          noData: /No data/i.test(body),
          error: !!(section && section.querySelector('[data-testid="data-testid Panel status error"]')),
          text: body.replace(/\s+/g, ' ').slice(0, 150),
        });
      }
      return out;
    });

    const noData = panels.filter(p => p.noData);
    const errored = panels.filter(p => p.error);
    console.log(`  panels: ${panels.length}   No data: ${noData.length}   errors: ${errored.length}`);
    noData.forEach(p => console.log(`    NO DATA  ${p.title}`));
    errored.forEach(p => console.log(`    ERROR    ${p.title}`));

    const file = `${OUT}\\board-${board.uid}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  screenshot -> ${file}`);

    report.push({ board: board.name, panels: panels.length, noData: noData.map(p => p.title), errors: errored.map(p => p.title) });
  }

  console.log('\n================ SUMMARY ================');
  for (const r of report) {
    const flag = r.errors.length ? 'ERRORS' : r.noData.length ? `${r.noData.length} No data` : 'all rendered';
    console.log(`  ${r.board.padEnd(20)} ${String(r.panels).padStart(2)} panels   ${flag}`);
  }

  await browser.close();
})();

// Read the three panels named in the brief as they actually render, not as PromQL says they
// should. Each is opened alone (viewPanel) so the plot is large, the series list is read from the
// legend, and the plotted values are read by hovering the canvas -- uPlot draws to a canvas, so
// the tooltip is the only place the rendered numbers exist as text.
const { chromium } = require('playwright');
const path = require('path');

const URL = process.env.GRAFANA_URL || 'http://localhost:13000';
const OUT = (process.env.OUT_DIR || '.').replace(/\\/g, '/');
const RANGE = process.env.RANGE || 'from=now-15m&to=now';

const PANELS = [
  { board: 'SKP Flow',      uid: 'skp-flow',      slug: 'skp-flow',      id: 24,  name: 'Step duration p95 / p99', file: 'flow-step-duration' },
  { board: 'SKP Flow',      uid: 'skp-flow',      slug: 'skp-flow',      id: 25,  name: 'Queue wait by hop',       file: 'flow-queue-wait-by-hop' },
  { board: 'SKP Processor', uid: 'skp-processor', slug: 'skp-processor', id: 112, name: 'Queue wait p95 / p99',    file: 'processor-queue-wait' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

  for (const p of PANELS) {
    const url = `${URL}/d/${p.uid}/${p.slug}?viewPanel=${p.id}&${RANGE}&kiosk`;
    console.log(`\n=== ${p.board} / ${p.name} ===`);
    console.log(`  ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('[data-testid^="data-testid Panel header"]', { timeout: 60000 });
    try {
      await page.waitForFunction(() => !document.body.innerText.includes('Cancel'), { timeout: 45000 });
    } catch { console.log('  (queries still in flight after 45s - capturing anyway)'); }
    await page.waitForTimeout(4000);

    const state = await page.evaluate(() => {
      const section = document.querySelector('[data-testid^="data-testid Panel header"]')?.closest('section');
      const body = section ? section.innerText : document.body.innerText;
      const legend = [...document.querySelectorAll('[data-testid="data-testid VizLegend"] button, [class*="VizLegendListItem"]')]
        .map(el => el.innerText.trim()).filter(Boolean);
      return {
        noData: /No data/i.test(body),
        error: !!section?.querySelector('[data-testid="data-testid Panel status error"]'),
        legend: [...new Set(legend)],
        text: body.replace(/\s+/g, ' ').slice(0, 300),
      };
    });
    console.log(`  noData=${state.noData}  error=${state.error}`);
    console.log(`  series (${state.legend.length}): ${state.legend.join(' ; ') || state.text}`);

    const file = path.posix.join(OUT, `${p.file}.png`);
    await page.screenshot({ path: file });
    console.log(`  screenshot -> ${file}`);

    // No attempt is made to scrape the plotted numbers as text. The visualisation is a canvas and
    // this Grafana serves anonymous viewers, for whom neither the hover tooltip nor Inspect > Data
    // materialises in the DOM. The screenshot is the rendered evidence; exact values are read from
    // Prometheus using the panel's own expressions, which is what the panel plots.
  }
  await browser.close();
})();

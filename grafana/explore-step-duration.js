// Show, in Grafana rather than in arithmetic, what the "Step duration p95 / p99" peak is.
//
// Three captures, each one an observation on screen:
//   1. the bucket census -- one series per `le`, so you can see which buckets ever receive a sample
//   2. the panel's own p99 beside a count of samples that exceeded 100ms
//   3. the dashboard panel itself, zoomed onto a single peak so the top is legible
const { chromium } = require('playwright');
const path = require('path');

const URL = process.env.GRAFANA_URL || 'http://localhost:13000';
const OUT = (process.env.OUT_DIR || '.').replace(/\\/g, '/');
const FROM = process.env.FROM || '1787681340000';
const TO = process.env.TO || '1787682240000';
const DS = { type: 'prometheus', uid: 'skp-prometheus' };

const SEL = '{type="step-outcome"}';
const SELB = (le) => `{type="step-outcome",le="${le}"}`;

const CAPTURES = [
  {
    file: 'explore-bucket-census',
    title: 'bucket census: samples per ladder rung',
    queries: [
      { refId: 'A', expr: `sum by (le) (increase(pipeline_step_elapsed_seconds_bucket${SEL}[1m]))`, legendFormat: 'le={{le}}' },
    ],
  },
  {
    file: 'explore-p99-vs-overflow',
    title: 'the plotted p99 beside the number of samples that exceeded 100ms',
    queries: [
      { refId: 'A', expr: `histogram_quantile(0.99, sum by (le) (rate(pipeline_step_elapsed_seconds_bucket${SEL}[1m]))) * 1000`, legendFormat: 'panel p99 (ms)' },
      { refId: 'B', expr: `sum(increase(pipeline_step_elapsed_seconds_count${SEL}[1m])) - sum(increase(pipeline_step_elapsed_seconds_bucket${SELB('0.1')}[1m]))`, legendFormat: 'samples over 100ms' },
      { refId: 'C', expr: `sum(increase(pipeline_step_elapsed_seconds_sum${SEL}[1m])) / sum(increase(pipeline_step_elapsed_seconds_count${SEL}[1m])) * 1000`, legendFormat: 'true mean (ms)' },
    ],
  },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1700, height: 1700 } });

  // Explore is closed to the anonymous Viewer this Grafana serves, so sign in first. The session
  // cookie is set on the context, so every later navigation carries it.
  const login = await context.request.post(`${URL}/login`, {
    data: { user: process.env.GF_USER || 'admin', password: process.env.GF_PASS || 'admin' },
  });
  console.log(`login -> ${login.status()}`);

  const page = await context.newPage();

  for (const c of CAPTURES) {
    const panes = {
      exp: {
        datasource: DS,
        queries: c.queries.map(q => ({ ...q, datasource: DS, range: true, instant: false, editorMode: 'code' })),
        range: { from: FROM, to: TO },
      },
    };
    const url = `${URL}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
    console.log(`\n=== ${c.title} ===`);
    for (const q of c.queries) console.log(`  ${q.refId}: ${q.expr}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(9000);
    // With three query editors open the graph is below the fold; bring it into view.
    // Collapse the query editors so the graph is not pushed below the fold.
    for (const btn of await page.$$('[data-testid="data-testid Query editor row"] button[aria-label*="ollapse"], button[aria-label="Collapse query row"]')) {
      await btn.click().catch(() => {});
    }
    await page.waitForTimeout(2500);
    const file = path.posix.join(OUT, `${c.file}.png`);
    await page.screenshot({ path: file });
    console.log(`  screenshot -> ${file}`);
  }

  // The panel itself, zoomed onto one peak.
  const zoomFrom = Number(FROM) + 3 * 60 * 1000;
  const zoomTo = Number(FROM) + 8 * 60 * 1000;
  const purl = `${URL}/d/skp-flow/skp-flow?viewPanel=24&from=${zoomFrom}&to=${zoomTo}&kiosk`;
  console.log(`\n=== the panel, zoomed onto one peak ===\n  ${purl}`);
  await page.goto(purl, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('[data-testid^="data-testid Panel header"]', { timeout: 60000 });
  await page.waitForTimeout(6000);
  const pfile = path.posix.join(OUT, 'flow-step-duration-zoom.png');
  await page.screenshot({ path: pfile });
  console.log(`  screenshot -> ${pfile}`);

  await browser.close();
})();

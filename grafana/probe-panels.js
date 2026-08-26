// Read the rewritten metric set's panels as they actually RENDER, not as PromQL says they should.
//
// WHY THIS EXISTS SEPARATELY FROM check-expressions.py. That script resolves dashboard variables
// and issues instant queries -- it proves the PromQL parses and that a series exists somewhere. It
// opens no panel, runs no range query, and cannot tell a panel that draws from a panel that renders
// "No data" over a perfectly valid expression. Every board defect this repository has shipped got
// past a green expression check; the two that cost the most -- a `_ratio` suffix nobody queried and
// a confident green 0 over a broker holding 7 -- were both invisible to it.
//
// Panels are resolved BY TITLE from the generated JSON rather than by hardcoded id. Ids come from
// build-dashboards.py's `_next_id()` counter, so inserting one panel renumbers every panel after
// it, and a probe pinned to ids silently starts reading the wrong panels the next time the
// generator runs.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL   = process.env.GRAFANA_URL || 'http://localhost:13000';
const OUT   = (process.env.OUT_DIR || '.').replace(/\\/g, '/');
const RANGE = process.env.RANGE || 'from=now-30m&to=now';
const BOARD = process.env.BOARD || 'skp-processor';

// The thirteen panels of the rewritten set, in spec section 7 order, keyed by the title the
// generator gives them. A row whose title resolves to nothing is reported as MISSING rather than
// skipped -- an absent panel is exactly the kind of gap this probe exists to surface.
const WANTED = [
  { row:  1, want: 'Loop iterations',    title: 'Loop iterations by loop' },
  { row:  2, want: 'Gate probe outcomes', title: 'Gate probe outcomes' },
  { row:  3, want: 'Gate probe duration', title: 'Gate probe duration' },
  { row:  4, want: 'Gate open',          title: 'Gate open and trips by replica' },
  { row:  5, want: 'Identity ready',     title: 'Identity ready by replica' },
  { row:  6, want: 'Restarts',           title: 'Restarts' },
  { row:  7, want: 'Queue depth',        title: 'Queue depth by queue' },
  { row:  8, want: 'Consumers attached', title: 'Consumers attached by queue' },
  { row:  9, want: 'Dead-letter depth',  title: 'Dead-letter depth by queue' },
  { row: 10, want: 'Messages consumed',  title: 'Messages consumed by disposition' },
  { row: 11, want: 'Queue wait',         title: 'Queue wait by queue' },
  { row: 12, want: 'Consumer duration',  title: 'Consumer duration by disposition' },
  { row: 13, want: 'Produce duration',   title: 'Produce duration' },
];

const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'dashboards', `${BOARD}.json`), 'utf8'));
const byTitle = new Map(
  board.panels.filter(p => p.type !== 'row').map(p => [p.title, p]));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const results = [];

  for (const w of WANTED) {
    const panel = byTitle.get(w.title);

    if (!panel) {
      console.log(`\n=== row ${w.row}: ${w.want} ===`);
      console.log(`  MISSING - no panel titled "${w.title}" on ${BOARD}`);
      results.push({ ...w, verdict: 'MISSING' });
      continue;
    }

    const url = `${URL}/d/${BOARD}/${BOARD}?viewPanel=${panel.id}&${RANGE}&kiosk`;
    console.log(`\n=== row ${w.row}: ${w.want}  ->  "${panel.title}" (id ${panel.id}) ===`);
    console.log(`  ${url}`);

    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('[data-testid^="data-testid Panel header"]', { timeout: 60000 });
    try {
      await page.waitForFunction(() => !document.body.innerText.includes('Cancel'), { timeout: 45000 });
    } catch { console.log('  (queries still in flight after 45s - capturing anyway)'); }
    await page.waitForTimeout(3000);

    const state = await page.evaluate(() => {
      const section = document.querySelector('[data-testid^="data-testid Panel header"]')?.closest('section');
      const body = section ? section.innerText : document.body.innerText;
      const legend = [...document.querySelectorAll(
        '[data-testid="data-testid VizLegend"] button, [class*="VizLegendListItem"]')]
        .map(el => el.innerText.trim()).filter(Boolean);
      return {
        noData: /No data/i.test(body),
        error:  !!section?.querySelector('[data-testid="data-testid Panel status error"]'),
        legend: [...new Set(legend)],
        text:   body.replace(/\s+/g, ' ').slice(0, 200),
      };
    });

    // `noData` is the verdict to trust. THE SERIES COUNT IS NOT: the legend selector below does
    // not match every Grafana version's DOM, and was observed reporting 0 for a panel whose legend
    // was plainly rendered in the screenshot beside it. Treat a zero count as "not read", never as
    // "no series" -- and read the screenshot, which is the rendered evidence.
    const verdict = state.error ? 'ERROR' : state.noData ? 'NO DATA' : 'DRAWS';
    console.log(`  ${verdict}   series(${state.legend.length}): ${state.legend.join(' ; ') || state.text}`);

    const file = path.posix.join(OUT, `panel-${String(w.row).padStart(2, '0')}-${BOARD}.png`);
    await page.screenshot({ path: file });
    console.log(`  screenshot -> ${file}`);

    results.push({ ...w, id: panel.id, verdict, series: state.legend.length });
  }

  await browser.close();

  console.log('\n\n================ SUMMARY ================');
  for (const r of results) {
    console.log(
      `  row ${String(r.row).padStart(2)}  ${r.verdict.padEnd(8)}  ` +
      `${r.series !== undefined ? String(r.series).padStart(2) + ' series  ' : '           '}${r.want}`);
  }
  const bad = results.filter(r => r.verdict !== 'DRAWS');
  console.log(`\n  ${results.length - bad.length}/${results.length} draw.`);
  if (bad.length) {
    console.log('  not drawing: ' + bad.map(r => `${r.want} (${r.verdict})`).join(', '));
  }

  // Deliberately does NOT exit non-zero on NO DATA. A panel can legitimately read no-data on an
  // idle stack -- gate trips is a counter that exists only once the gate has tripped. The verdict
  // table is the output; deciding which absences are expected is the reader's job, and encoding
  // that judgment in an exit code would make this script lie the first time the workload changed.
  process.exit(bad.some(r => r.verdict === 'ERROR' || r.verdict === 'MISSING') ? 1 : 0);
})();

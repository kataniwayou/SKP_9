// Sample every SKP board at intervals across a fault window, so before / during / after
// are comparable for one outage.
//
// audit-boards.js and audit-nav.js each capture a single moment, which is enough to ask
// "does this panel render". It cannot answer the question a chaos run asks: does this
// panel CHANGE when the thing it watches breaks, and how long does it take. A panel that
// is green before the fault, green during it and green after it is a finding, and only a
// timeline shows that.
//
// Why five long-lived tabs rather than a fresh load per sample. A cold Grafana board takes
// 15-25s to paint; loading five of them per sample would cost ~100s a sweep and the fault
// window is 60s, so the whole outage would fall between two samples. Loading once and
// letting `&refresh=` repaint in place costs ~2s a board, so a sweep fits inside the
// window several times over.
//
// Background tabs get their timers throttled by Chromium, which stalls Grafana's own
// refresh loop, so each page is brought to the front before it is read. That also
// guarantees the screenshot is of a freshly composited frame rather than a stale one.
//
//   node grafana/chaos-timeline.js --label s2-redis --duration 660
//
// Env: GRAFANA_URL, OUT_DIR, RANGE (default now-15m), INTERVAL (s), HEADED=1.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const GRAFANA = process.env.GRAFANA_URL || 'http://localhost:13000';
const LABEL = arg('label', 'run');
const DURATION = Number(arg('duration', process.env.DURATION || 660));
const INTERVAL = Number(arg('interval', process.env.INTERVAL || 15));
const RANGE = process.env.RANGE || 'now-15m';
const REFRESH = process.env.REFRESH || '5s';
const OUT = path.join(process.env.OUT_DIR || path.join(__dirname, '..', '.chaos-timeline'), LABEL);

// Tall viewport, and a viewport screenshot rather than fullPage: Grafana virtualises the
// panel list, so a fullPage capture re-renders while it scrolls and the board comes out
// drawn twice. Every board fits inside 3200px; the surplus is black.
const BOARDS = [
  { uid: 'skp-flow', name: 'Flow' },
  { uid: 'skp-orchestrator', name: 'Orchestrator' },
  { uid: 'skp-processor', name: 'Processor' },
  { uid: 'skp-baseapi', name: 'BaseAPI' },
  { uid: 'skp-runtime', name: 'Runtime' },
];

// Read one board's panels the way a reader sees them: the rendered state, not the query.
// `value` is the panel body with the title stripped -- for a stat that is the number the
// verdict tier exists to show, and for a timeseries it is the legend, which is what says
// WHICH series vanished.
const SCRAPE = () => {
  const out = [];
  for (const el of document.querySelectorAll('[data-testid^="data-testid Panel header"]')) {
    const section = el.closest('section') || el.parentElement;
    const title = (el.innerText || '').trim().split('\n')[0];
    let body = section ? (section.innerText || '') : '';
    if (body.startsWith(title)) body = body.slice(title.length);
    out.push({
      title,
      noData: /No data/i.test(body),
      error: !!(section && section.querySelector('[data-testid="data-testid Panel status error"]')),
      value: body.replace(/\s+/g, ' ').trim().slice(0, 220),
    });
  }
  return out;
};

// A board is painted when every panel has resolved to something -- a value, a legend, or
// an explicit "No data". audit-boards.js waits instead for the refresh control to stop
// reading "Cancel", which cannot work here: this Grafana renders the value INSIDE the
// panel header element, and on a board opened without the toolbar the control is not in
// the DOM at all, so that wait returns instantly and the sample catches an empty grid.
async function painted(page, budgetMs) {
  try {
    await page.waitForFunction(() => {
      const heads = [...document.querySelectorAll('[data-testid^="data-testid Panel header"]')];
      if (!heads.length) return false;
      return heads.every((el) => {
        const sec = el.closest('section') || el.parentElement;
        const body = sec ? sec.innerText || '' : '';
        const title = (el.innerText || '').trim().split(String.fromCharCode(10))[0];
        return body.replace(title, '').trim().length > 0;
      });
    }, { timeout: budgetMs });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(OUT, 'png'), { recursive: true });
  const jsonl = fs.createWriteStream(path.join(OUT, 'timeline.jsonl'), { flags: 'a' });

  const browser = await chromium.launch({ headless: !process.env.HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 3200 } });

  const pages = [];
  for (const b of BOARDS) {
    const page = await ctx.newPage();
    const url = `${GRAFANA}/d/${b.uid}?from=${RANGE}&to=now&refresh=${REFRESH}&kiosk`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForSelector('[data-testid^="data-testid Panel header"]', { timeout: 90000 });
    pages.push({ ...b, page });
    console.log(`  opened ${b.name.padEnd(13)} ${url}`);
  }

  // One unhurried first paint for every board before the clock starts. Sampling into a
  // half-painted grid produces "No data" rows that are the load, not the system.
  console.log('  warming up (first paint is 15-25s a board) ...');
  for (const p of pages) {
    await p.page.bringToFront();
    const ok = await painted(p.page, 45000);
    if (!ok) console.log(`    ${p.name}: some panels still unresolved after 45s -- sampling anyway`);
  }
  await pages[0].page.waitForTimeout(5000);

  const t0 = Date.now();
  let sweep = 0;

  console.log(`\n  sampling every ${INTERVAL}s for ${DURATION}s -> ${OUT}\n`);
  console.log(`  ${'t'.padStart(5)}  ${'board'.padEnd(13)} panels  noData  err   verdict tier`);

  while ((Date.now() - t0) / 1000 < DURATION) {
    const sweepStart = Date.now();
    sweep++;

    for (const p of pages) {
      await p.page.bringToFront();
      // A foregrounded tab un-throttles its timers, so this dwell is one refresh cycle
      // plus the query. Nothing here reloads the board -- that is the whole point.
      await p.page.waitForTimeout(2500);
      const at = new Date();
      const elapsed = Math.round((at - t0) / 1000);
      const panels = await p.page.evaluate(SCRAPE);
      const file = path.join(OUT, 'png', `${String(elapsed).padStart(4, '0')}s-${p.uid}.png`);
      await p.page.screenshot({ path: file });

      jsonl.write(JSON.stringify({
        label: LABEL, sweep, elapsed, at: at.toISOString(), board: p.uid, panels, png: file,
      }) + '\n');

      const nd = panels.filter(x => x.noData).length;
      const er = panels.filter(x => x.error).length;
      // The verdict tier is the top row of stats; print it inline so the run is readable
      // live rather than only in the post-mortem.
      const verdict = panels.slice(0, 8).filter(x => x.value && x.value.length < 40)
        .map(x => `${x.title}=${x.value}`).join(' ');
      console.log(`  ${String(elapsed).padStart(5)}  ${p.name.padEnd(13)} ${String(panels.length).padStart(6)}  ${String(nd).padStart(6)}  ${String(er).padStart(3)}   ${verdict.slice(0, 150)}`);
    }

    const spent = (Date.now() - sweepStart) / 1000;
    if (spent < INTERVAL) await pages[0].page.waitForTimeout((INTERVAL - spent) * 1000);
  }

  jsonl.end();
  await browser.close();
  console.log(`\n  ${sweep} sweeps -> ${path.join(OUT, 'timeline.jsonl')}`);
})();

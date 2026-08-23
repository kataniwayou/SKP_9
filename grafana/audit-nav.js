// Every board must offer a route to every other board.
//
// skp-runtime carried the `skp` tag but no `links`, so it appeared in everyone else's nav
// while showing none of its own: clicking into it stranded the reader, and only there.
// A tag and a link are separate things and nothing had been checking they agreed.

const { chromium } = require('playwright');

const TARGET_URL = process.env.GRAFANA_URL || 'http://localhost:13000';
const BOARDS = ['skp-flow', 'skp-baseapi', 'skp-orchestrator', 'skp-processor', 'skp-runtime'];

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });

  let stranded = 0;

  for (const uid of BOARDS) {
    // Bare uid: Grafana redirects to the canonical slug. A made-up slug does not always
    // survive kiosk mode, which is what made the first run of this script time out.
    await page.goto(`${TARGET_URL}/d/${uid}?kiosk`, { waitUntil: 'networkidle', timeout: 60000 });
    // The dashboard-links bar is built from a tag SEARCH issued after first paint, so the
    // links appear seconds after the page is otherwise idle. Waiting a fixed few seconds
    // under-counted them and reported healthy boards as stranded.
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('a[href*="/d/"]').length >= 4,
        { timeout: 30000 },
      );
    } catch { /* fall through and report what did render */ }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: (process.env.OUT_DIR || '.') + '/nav-' + uid + '.png', clip: { x: 0, y: 0, width: 1800, height: 120 } });

    // Dashboard links render as anchors to /d/<uid>/... in the sub-menu.
    const targets = await page.evaluate(() =>
      [...document.querySelectorAll('a[href*="/d/"]')]
        .map(a => (a.getAttribute('href') || '').match(/\/d\/([a-z0-9-]+)/))
        .filter(Boolean)
        .map(m => m[1]),
    );

    const reachable = [...new Set(targets)].filter(t => t !== uid).sort();
    const missing = BOARDS.filter(b => b !== uid && !reachable.includes(b));

    const verdict = missing.length ? `STRANDED -- cannot reach ${missing.join(', ')}` : 'reaches all 4 others';
    if (missing.length) stranded++;
    console.log(`  ${uid.padEnd(18)} ${String(reachable.length).padStart(2)} links   ${verdict}`);
  }

  console.log(stranded ? `\n${stranded} board(s) strand the reader` : '\nNav is complete: every board reaches every other');
  await browser.close();
  process.exit(stranded ? 1 : 0);
})();

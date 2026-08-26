// Every board must offer a route to every other board.
//
// skp-runtime carried the `skp` tag but no `links`, so it appeared in everyone else's nav
// while showing none of its own: clicking into it stranded the reader, and only there.
// A tag and a link are separate things and nothing had been checking they agreed.

const { chromium } = require('playwright');

const TARGET_URL = process.env.GRAFANA_URL || 'http://localhost:13000';
const BOARDS = ['skp-baseapi', 'skp-orchestrator', 'skp-processor'];

// Grafana marks a dashboard link with this on the ANCHOR itself, identically on 11.1.0 and
// 12.3.9 -- only the container around it differs (`section[aria-label="Dashboard submenu"]`
// on 11, `div[data-testid="data-testid dashboard controls"]` on 12), which is why the
// anchor rather than its parent is what this matches.
//
// It replaces `a[href*="/d/"]`, which was too broad in the way that matters: on a Grafana
// serving anonymous users, the header carries a **"Sign in"** anchor whose href embeds the
// current board as its redirect target. That anchor is a chrome control, not nav, and it
// counted. It escaped notice only because it points at the board you are already on and so
// fell to the `t !== uid` filter below -- on any page where the redirect target differed it
// would have inflated the count and turned a stranded board into a pass.
const LINK = 'a[data-testid="data-testid Dashboard link"]';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });

  let stranded = 0;

  for (const uid of BOARDS) {
    // Bare uid: Grafana redirects to the canonical slug. A made-up slug does not always
    // survive, which is what made the first run of this script time out.
    //
    // NO `?kiosk`, and that is a compatibility fix rather than a preference. Grafana 11.1.0
    // hides the dashboard-links bar in kiosk mode; 12.3.9 keeps it. Asking for kiosk made
    // this script report all five boards STRANDED on 11.1 while their links and `skp` tags
    // were stored and rendering correctly -- a clean false positive, and on the one signal
    // this script exists to give. Without kiosk both versions render the bar, so the check
    // means the same thing on each. The chrome kiosk would have hidden is excluded by
    // LINK instead, which is the more precise instrument anyway.
    await page.goto(`${TARGET_URL}/d/${uid}`, { waitUntil: 'networkidle', timeout: 60000 });
    // The dashboard-links bar is built from a tag SEARCH issued after first paint, so the
    // links appear seconds after the page is otherwise idle. Waiting a fixed few seconds
    // under-counted them and reported healthy boards as stranded.
    try {
      await page.waitForFunction(
        (sel) => document.querySelectorAll(sel).length >= 4,
        LINK,
        { timeout: 30000 },
      );
    } catch { /* fall through and report what did render */ }
    await page.waitForTimeout(1500);

    // Dashboard links render as anchors to /d/<uid>/... in the sub-menu.
    const targets = await page.evaluate((sel) =>
      [...document.querySelectorAll(sel)]
        .map(a => (a.getAttribute('href') || '').match(/\/d\/([a-z0-9-]+)/))
        .filter(Boolean)
        .map(m => m[1]),
      LINK,
    );

    // Frame the shot on the links that were actually counted. The old fixed
    // `{0,0,1800,120}` clip was a kiosk-mode assumption too: without kiosk that band is
    // Grafana's own header, so the evidence for a STRANDED verdict showed none of the
    // thing being judged.
    const clip = await page.evaluate((sel) => {
      const els = [...document.querySelectorAll(sel)];
      if (!els.length) return null;
      const r = els.map(e => e.getBoundingClientRect());
      const x = Math.max(0, Math.min(...r.map(b => b.left)) - 20);
      const y = Math.max(0, Math.min(...r.map(b => b.top)) - 20);
      return { x, y,
               width: Math.min(1800 - x, Math.max(...r.map(b => b.right)) - x + 20),
               height: Math.min(1000 - y, Math.max(...r.map(b => b.bottom)) - y + 20) };
    }, LINK);
    await page.screenshot({
      path: (process.env.OUT_DIR || '.') + '/nav-' + uid + '.png',
      clip: clip || { x: 0, y: 0, width: 1800, height: 120 },
    });

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

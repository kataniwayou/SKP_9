// Screenshot a workflow SVG as the dashboard panel shows it, and report the vertical bands:
// where the boxes end, where the legend starts, and how much empty height sits between them.
const { chromium } = require('playwright');
const URL_ = process.argv[2], OUT = process.argv[3];
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 700 } });
  await page.goto(URL_, { waitUntil: 'load' });
  const d = await page.evaluate(() => {
    const s = document.querySelector('svg');
    const bb = e => { const b = e.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const rows = [...s.querySelectorAll('rect[class^="node-box"]')].map(bb);
    const legend = [...s.querySelectorAll('text.lg-num, text.lg-step, text.lg-cfg')].map(bb);
    const caption = [...s.querySelectorAll('text.legend-txt')].map(bb);
    const vb = s.getAttribute('viewBox').split(' ').map(Number);
    return {
      vb,
      boxBottom: Math.max(...rows.map(r => r.y + r.h)),
      legendTop: legend.length ? Math.min(...legend.map(t => t.y)) : null,
      legendBottom: legend.length ? Math.max(...legend.map(t => t.y + t.h)) : null,
      captionBottom: caption.length ? Math.max(...caption.map(t => t.y + t.h)) : null,
      root: bb(s),
    };
  });
  const gap = d.legendTop - d.boxBottom;
  console.log(JSON.stringify({ ...d, gapBoxesToLegend: gap,
    tailBelowCaption: d.vb[3] - d.captionBottom }, null, 1));
  await page.setViewportSize({ width: d.vb[2], height: d.vb[3] });
  await page.screenshot({ path: OUT });
  await browser.close();
})();

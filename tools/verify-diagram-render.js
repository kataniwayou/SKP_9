/*
 * Renders a workflow's served diagram in a real browser and asserts it arrives intact.
 *
 * WHY A BROWSER AND NOT curl. curl proves the bytes are served; it cannot prove a browser DISPLAYS
 * them, and the two came apart here. The first run of this test found the drawings arriving with no
 * intrinsic size: the pages carry a viewBox but no width/height, which is enough while the <svg>
 * lives in a page that sizes it with CSS, and useless once it is served on its own. A viewBox-only
 * SVG referenced by an <img> with no width falls back to the 300px default for a replaced element,
 * so every drawing would have rendered as a thumbnail. Status 200 and correct bytes throughout.
 *
 * WHY THE <img> HAS EMPTY ALT, and why loading is asserted rather than eyeballed. The dashboard's
 * TSVB panel emits a bare `![](url)`, whose alt text is deliberately empty so that a missing image
 * collapses to nothing instead of showing a broken-image icon. That also means a failed load is
 * INVISIBLE in a screenshot - it looks exactly like an empty panel - so naturalWidth is the only
 * honest witness.
 *
 * Test A reproduces the panel's own mechanism, with no width styling of any kind. Test B navigates
 * to the SVG so its DOM can be MEASURED with getBBox, the same instrument the drawing prompt
 * insists on: reading coordinates back from source cannot catch a collision that depends on font
 * metrics.
 *
 *   node run.js tools/verify-diagram-render.js          # via the playwright skill's executor
 *   SKP_API=http://127.0.0.1:18099 SKP_WORKFLOW_ID=<guid> node ...
 */
const { chromium } = require('playwright');

const API = process.env.SKP_API || 'http://localhost:18080';
const SIMPLE_ABC = process.env.SKP_WORKFLOW_ID || '4a77ba79-095b-4eee-a2ba-e1117189dac5';  // simple-abc_1.0.0
const URL = `${API}/api/v1/workflows/${SIMPLE_ABC}.svg`;

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1700, height: 900 });
  const failures = [];

  // TEST A - the panel's ACTUAL mechanism, with NO width styling of any kind, because the TSVB
  // markdown emits a bare ![](url). Alt text is empty exactly as the panel has it, so a broken
  // image renders no icon and nothing at all - which is why loading has to be ASSERTED here and
  // cannot be judged by looking at the screenshot.
  await page.setContent(`<body style="margin:0;background:#fff"><img id="d" src="${URL}" alt=""></body>`);
  await page.waitForTimeout(1500);

  const img = await page.evaluate(() => {
    const i = document.getElementById('d');
    const r = i.getBoundingClientRect();
    return { complete: i.complete, nw: i.naturalWidth, nh: i.naturalHeight, lw: Math.round(r.width), lh: Math.round(r.height) };
  });
  console.log(`A) bare <img alt="">  loaded=${img.complete}  intrinsic=${img.nw}x${img.nh}  laid out=${img.lw}x${img.lh}`);
  if (!img.complete || img.nw === 0) failures.push('the image did not load');
  if (img.nw !== 1580 || img.nh !== 330) failures.push(`intrinsic ${img.nw}x${img.nh}, expected 1580x330`);
  if (img.lw < 1000) failures.push(`laid out only ${img.lw}px wide - it would be a thumbnail in the panel`);
  await page.screenshot({ path: '/tmp/placeholder-in-img-tag.png' });

  // TEST B - the SVG on its own, so its DOM is readable and the drawing can be MEASURED.
  const resp = await page.goto(URL, { waitUntil: 'load' });
  console.log(`B) status=${resp.status()}  content-type=${resp.headers()['content-type']}`);
  if (resp.status() !== 200) failures.push(`status ${resp.status()}`);
  if (!(resp.headers()['content-type'] || '').includes('image/svg+xml')) failures.push('wrong content-type');

  const svg = await page.evaluate(() => {
    const s = document.querySelector('svg');
    return {
      viewBox: s.getAttribute('viewBox'), w: s.getAttribute('width'), h: s.getAttribute('height'),
      label: s.getAttribute('aria-label'),
      texts: [...s.querySelectorAll('text')].map(t => { const b = t.getBBox(); return { s: t.textContent.trim(), b: {x:b.x,y:b.y,width:b.width,height:b.height} }; }),
      root: (() => { const b = s.getBBox(); return {x:b.x,y:b.y,width:b.width,height:b.height}; })(),
    };
  });
  console.log(`   viewBox="${svg.viewBox}"  width="${svg.w}"  height="${svg.h}"`);
  svg.texts.forEach((t, i) => console.log(`   text[${i}] "${t.s}"  measured ${t.b.width.toFixed(0)}x${t.b.height.toFixed(0)}px`));

  if (!svg.texts.some(t => t.s.includes('No diagram published'))) failures.push('placeholder does not say a diagram is missing');
  if (svg.viewBox !== '0 0 1580 330') failures.push(`viewBox ${svg.viewBox}`);
  svg.texts.forEach((t, i) => { if (t.b.width === 0) failures.push(`text[${i}] measured 0px wide - did not render`); });
  // No text may overlap another, and nothing may escape the viewBox - the same assertions the
  // drawing prompt makes of a real diagram, applied to the placeholder.
  for (let i = 0; i < svg.texts.length; i++)
    for (let j = i + 1; j < svg.texts.length; j++) {
      const a = svg.texts[i].b, b = svg.texts[j].b;
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height)
        failures.push(`text[${i}] overlaps text[${j}]`);
    }
  const r = svg.root;
  if (r.x < 0 || r.y < 0 || r.x + r.width > 1580 || r.y + r.height > 330)
    failures.push(`content escapes the viewBox: ${JSON.stringify(r)}`);

  await page.screenshot({ path: '/tmp/placeholder-rendered.png' });
  console.log('\nscreenshots: /tmp/placeholder-in-img-tag.png  /tmp/placeholder-rendered.png');
  if (failures.length) { console.log('\nFAILED:'); failures.forEach(f => console.log('  - ' + f)); }
  else console.log('\nPASS - placeholder loads and renders full width through the panel\'s own img mechanism');

  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();

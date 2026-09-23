/*
 * Step 3 of the operator's process: render a workflow's served diagram in a real browser and
 * assert it arrives intact.
 *
 * WHY A BROWSER AND NOT curl. curl proves the bytes are served; it cannot prove a browser DISPLAYS
 * them, and the two came apart twice here. Once the drawings arrived with no intrinsic size - the
 * pages carry a viewBox but no width/height, which is enough while the <svg> lives in a page that
 * sizes it with CSS and useless once it is served alone, so the browser fell back to the 300px
 * default for a replaced element. Once an <svg> declared xmlns twice, which makes the document
 * malformed and a browser answers by rendering nothing. Both served 200 image/svg+xml with correct
 * bytes throughout.
 *
 * WHY THE <img> HAS EMPTY ALT, and why loading is asserted rather than eyeballed. The dashboard's
 * TSVB panel emits a bare `![](url)`, whose alt text is deliberately empty so a missing image
 * collapses to nothing instead of showing a broken-image icon. A failed load is therefore INVISIBLE
 * in a screenshot - it looks exactly like an empty panel - so naturalWidth is the only honest
 * witness.
 *
 * IT ACCEPTS EITHER STATE AND SAYS WHICH. A workflow with no published diagram serves a placeholder
 * and that is an ordinary state, not a failure. An earlier version of this file asserted the
 * placeholder's own dimensions and its caption, so publishing a real diagram made it report three
 * failures that were all itself being out of date - and a fourth, a viewBox bound hardcoded to the
 * placeholder's 330, which called a perfectly contained 520-tall drawing "escaping".
 *
 *   node run.js tools/verify-diagram-render.js
 *   SKP_API=http://host:18080 SKP_WORKFLOW_ID=<guid> node run.js tools/verify-diagram-render.js
 */
const { chromium } = require('playwright');

const API = process.env.SKP_API || 'http://localhost:18080';
const WORKFLOW = process.env.SKP_WORKFLOW_ID || '4a77ba79-095b-4eee-a2ba-e1117189dac5';
const URL = `${API}/api/v1/workflows/${WORKFLOW}.svg`;

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1700, height: 900 });
  const failures = [];

  // TEST A - the panel's ACTUAL mechanism, with no width styling of any kind.
  await page.setContent(`<body style="margin:0;background:#fff"><img id="d" src="${URL}" alt=""></body>`);
  await page.waitForTimeout(1500);

  const img = await page.evaluate(() => {
    const i = document.getElementById('d');
    return { complete: i.complete, nw: i.naturalWidth, nh: i.naturalHeight,
             lw: Math.round(i.getBoundingClientRect().width) };
  });
  console.log(`A) bare <img alt="">  loaded=${img.complete}  intrinsic=${img.nw}x${img.nh}  laid out=${img.lw}px`);
  if (!img.complete || img.nw === 0) failures.push('the image did not load in an <img> tag');
  if (img.nw !== 1580) failures.push(`intrinsic width ${img.nw}, expected the 1580 contract`);
  if (img.lw < 1000) failures.push(`laid out only ${img.lw}px wide - it would be a thumbnail in the panel`);
  await page.screenshot({ path: '/tmp/diagram-in-img-tag.png' });

  // TEST B - the SVG on its own, so its DOM is readable and the drawing can be MEASURED.
  const resp = await page.goto(URL, { waitUntil: 'load' });
  console.log(`B) status=${resp.status()}  content-type=${resp.headers()['content-type']}`);
  if (resp.status() !== 200) failures.push(`status ${resp.status()}, expected 200`);
  if (!(resp.headers()['content-type'] || '').includes('image/svg+xml')) failures.push('wrong content-type');

  const svg = await page.evaluate(() => {
    const s = document.querySelector('svg');
    const bb = e => { const b = e.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    return {
      vb: s.getAttribute('viewBox').split(' ').map(Number),
      w: s.getAttribute('width'), h: s.getAttribute('height'),
      label: s.getAttribute('aria-label') || '',
      texts: [...s.querySelectorAll('text')].map(t => ({ s: t.textContent.trim(), ...bb(t) })),
      boxes: s.querySelectorAll('rect[class^="node-box"]').length,
      root: bb(s),
    };
  });
  const placeholder = /No diagram published/i.test(svg.label)
                      || svg.texts.some(t => /No diagram published/i.test(t.s));
  console.log(`   viewBox=${svg.vb.join(' ')}  width=${svg.w} height=${svg.h}  boxes=${svg.boxes}`);
  console.log(`   -> ${placeholder ? 'PLACEHOLDER - no diagram published for this workflow'
                                   : `REAL DIAGRAM - ${svg.boxes} step boxes`}`);

  // The intrinsic size must equal the viewBox, whichever state this is.
  if (+svg.w !== svg.vb[2] || +svg.h !== svg.vb[3])
    failures.push(`width/height ${svg.w}x${svg.h} disagrees with viewBox ${svg.vb[2]}x${svg.vb[3]}`);
  if (img.nh !== svg.vb[3])
    failures.push(`the <img> reported ${img.nh} tall, the SVG says ${svg.vb[3]}`);

  // Measured, not read back from source: a zero-width text node rendered nothing at all.
  svg.texts.forEach((t, i) => { if (t.w === 0) failures.push(`text[${i}] "${t.s}" measured 0px wide`); });
  for (let i = 0; i < svg.texts.length; i++)
    for (let j = i + 1; j < svg.texts.length; j++) {
      const a = svg.texts[i], b = svg.texts[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        failures.push(`text overlap: "${a.s}" x "${b.s}"`);
    }
  // Bounds come from THIS drawing's viewBox, never a remembered number.
  const r = svg.root;
  if (r.x < 0 || r.y < 0 || r.x + r.w > svg.vb[2] || r.y + r.h > svg.vb[3])
    failures.push(`content escapes the viewBox: ${JSON.stringify(r)} vs ${svg.vb[2]}x${svg.vb[3]}`);

  if (!placeholder && svg.boxes === 0) failures.push('a published diagram with no step boxes');

  await page.screenshot({ path: '/tmp/diagram-rendered.png' });
  console.log(`\n${svg.texts.length} texts measured, 0 overlaps expected`);
  failures.length ? (console.log('\nFAILED:'), failures.forEach(f => console.log('  - ' + f)))
                  : console.log('\nPASS - the drawing loads and renders through the panel\'s own img mechanism');

  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();

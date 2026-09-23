/*
 * Renders the operator dashboard in a real browser and asserts every panel and control arrived.
 *
 * WHY A BROWSER AND NOT verify-kibana-dashboard.py. That script asks Elasticsearch whether the
 * DATA a panel needs exists, which is the half that can be checked without a browser. It cannot
 * see a panel that failed to mount, a control bound to a field the mapping does not have, or a
 * chart that drew its axes and nothing else. Those are the failures this file exists for, and all
 * three have happened here.
 *
 * A CANVAS IS NOT DATA, and that distinction is the point of the series check. Lens renders its
 * axes whether or not a single bar was plotted, so "the panel contains a canvas" passes on an
 * empty chart - a check that looks strong and proves almost nothing. elastic-charts emits one
 * legend item per rendered series, so counting those asks whether anything was actually drawn.
 *
 * SELECTORS ARE MEASURED, NOT GUESSED. [data-test-subj="dashboardPanel"] returns exactly one
 * element per panel on this Kibana. A PREFIX match on that attribute does not: it also catches
 * every embeddablePanelHeading wrapper, which reported 44 panels for 4 and then failed the blank
 * check on the containers. Kibana's layout class names also move between versions -
 * .react-grid-item returns 0 on 9.3.4 - so the stable anchors are the exact test-subj and the
 * document title. If this file starts reporting a wrong panel count after an upgrade, re-measure
 * the selector before believing the dashboard broke.
 *
 * AUTO-REFRESH IS PAUSED IN THE URL. A refreshing dashboard never reaches networkidle, so every
 * wait burns its full timeout and the run takes minutes for no benefit; it also repaints panels
 * underneath the assertions.
 *
 * PLATFORM NOISE IS FILTERED. With security disabled Kibana 404s its own
 * /internal/security/user_profile, and with telemetry off it 403s the product-intercept endpoints.
 * Six of those fire on every load and say nothing about this dashboard. An ERR_ABORTED is likewise
 * the browser cancelling an in-flight search, which is what closing the page does - counting it
 * made an earlier version of this gate fail on its own teardown.
 *
 *   node run.js tools/verify-kibana-panels.js
 *   SKP_KIBANA=http://host:15601 node run.js tools/verify-kibana-panels.js
 */
const { chromium } = require('playwright');

const KIBANA = process.env.SKP_KIBANA || process.env.KIBANA_URL || 'http://localhost:15601';
const URL = `${KIBANA}/app/dashboards#/view/skp-operator-outcomes` +
            `?_g=(time:(from:now-30m,to:now),refreshInterval:(pause:!t,value:0))`;

const EXPECTED_CONTROLS = ['Workflow', 'Step', 'Outcome', 'Whitelist'];
const EXPECTED_PANELS = 4;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1400 } });
  const failedReq = [];
  const IGNORE = /user_profile|intercepts/;
  page.on('response', r => { if (r.status() >= 400 && !IGNORE.test(r.url())) failedReq.push(`${r.status()} ${r.url().slice(0,95)}`); });
  page.on('requestfailed', r => {
    const why = r.failure()?.errorText || '';
    if (!IGNORE.test(r.url()) && !/ABORTED/i.test(why)) failedReq.push(`FAILED ${r.url().slice(0,95)}`);
  });

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.title.startsWith('SKP'), { timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
    // Scroll the whole board so lazily-rendered panels below the fold actually mount.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 300)); }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(10000);

    const dom = await page.evaluate(() => {
      // ONE ELEMENT PER PANEL, verified against this Kibana: dashboardPanel returns exactly 4.
      // An earlier union included [data-test-subj^="embeddablePanel"], and that PREFIX match also
      // caught every embeddablePanelHeading wrapper - 44 "panels" for 4 real ones, with the empty
      // containers then failing the blank check. Prefix matches on test-subj are a trap here.
      const panelEls = [...document.querySelectorAll('[data-test-subj="dashboardPanel"]')];
      const panels = panelEls.map(el => {
        const t = el.innerText || '';
        return {
          title: (t.split('\n')[0] || '').slice(0, 44),
          error: /An error occurred|Error loading|could not be found|Unable to load/i.test(t),
          noData: /No results found|No data/i.test(t),
          hasVisual: !!el.querySelector('canvas, svg, img, table'),
          // A CANVAS IS NOT DATA. Lens draws its axes whether or not a single bar was plotted, so
          // "has a canvas" passed on a chart that had rendered nothing - which is exactly the
          // failure this board hit. elastic-charts emits one legend item per rendered series, so
          // counting those asks whether anything was actually drawn.
          series: el.querySelectorAll('[class*="echLegendItem"], .echLegendItem').length,
          imgs: [...el.querySelectorAll('img')].filter(i => i.src.includes('/api/v1/workflows/'))
                  .map(i => ({ w: i.naturalWidth, h: i.naturalHeight })),
        };
      });
      // Same nesting problem on the controls: take only the outermost frame per control.
      const frames = [...document.querySelectorAll('[class*="controlFrame"]')]
        .filter(el => !el.parentElement?.closest('[class*="controlFrame"]'));
      const controls = frames.map(el => {
        const t = (el.innerText || '').trim();
        return { text: t.replace(/\n+/g, '=').slice(0, 50), error: /An error occurred/i.test(t) };
      });
      return { panels, controls: controls.filter(c => c.text) };
    });

    check('all panels rendered', dom.panels.length >= EXPECTED_PANELS,
      `${dom.panels.length} found: ${dom.panels.map(p => p.title || '(untitled)').join(' | ')}`);

    const errored = dom.panels.filter(p => p.error);
    check('no panel is in an error state', errored.length === 0,
      errored.length ? errored.map(p => p.title).join(', ') : 'none');

    const blank = dom.panels.filter(p => !p.hasVisual && !p.noData);
    check('every panel drew something', blank.length === 0,
      blank.length ? `blank: ${blank.map(p => p.title).join(', ')}` : `${dom.panels.length} panels have a canvas/svg/img/table`);

    const empty = dom.panels.filter(p => p.noData);
    check('no panel reports "no data"', empty.length === 0,
      empty.length ? empty.map(p => p.title).join(', ') : 'none');

    // Only the chart panels: the diagram panel is markdown+images and has no legend.
    const charts = dom.panels.filter(p => !/diagram/i.test(p.title));
    const noSeries = charts.filter(p => p.series === 0);
    check('every chart panel plotted at least one series', noSeries.length === 0,
      noSeries.length ? `no series: ${noSeries.map(p => p.title).join(', ')}`
                      : charts.map(p => `${p.title}=${p.series}`).join(', '));

    const diagrams = dom.panels.flatMap(p => p.imgs);
    check('diagram images loaded from BaseApi', diagrams.length > 0 && diagrams.every(i => i.w > 0),
      diagrams.length ? diagrams.map(i => `${i.w}x${i.h}`).join(', ') : 'NO DIAGRAM IMAGES FOUND');

    const controlText = dom.controls.map(c => c.text).join(' ');
    const missing = EXPECTED_CONTROLS.filter(c => !controlText.includes(c));
    check('all four controls present', missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : dom.controls.map(c => c.text).join(' | '));

    check('no control is in an error state', dom.controls.every(c => !c.error),
      dom.controls.filter(c => c.error).map(c => c.text).join(', ') || 'none');

    // Each options list must actually offer values.
    const lists = await page.locator('[data-test-subj*="optionsList"]').all();
    const offered = [];
    for (let i = 0; i < Math.min(lists.length, 4); i++) {
      await lists[i].click({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3500);
      const opts = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')]
        .map(e => e.innerText.trim().split('\n')[0]).filter(t => t && t !== 'Exists').length);
      offered.push(opts);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    }
    check('every control offers options', offered.length > 0 && offered.every(n => n > 0),
      `option counts per control: [${offered.join(', ')}]`);

    check('no failing requests', failedReq.length === 0,
      failedReq.length ? [...new Set(failedReq)].slice(0, 3).join(' | ') : 'none (platform noise filtered)');

    // OUT OF THE REPO by default, like verify-diagram-render.js. A gate that drops an
    // untracked artefact in the working tree every run is a gate people learn to ignore.
    await page.screenshot({ path: process.env.SHOT || '/tmp/kibana-panels.png', fullPage: true });
  } catch (e) {
    check('test completed', false, `${e.name}: ${e.message.slice(0, 200)}`);
  } finally {
    await browser.close();
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();

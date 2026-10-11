import sansFont from '@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-400-normal.woff2?inline';
import monoFont from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?inline';
import type { CSSProperties, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StudioDocument } from '../app/document';
import artCss from '../canvas/art.css?raw';
import canvasCss from '../canvas/canvas.css?raw';
import tokensCss from '../canvas/tokens.css?raw';
import { CableEdgeView, type CableEdgeData } from '../canvas/edges/CableEdge';
import type { TextFitter } from '../canvas/fitText';
import { CacheView } from '../canvas/nodes/CacheNode';
import { StepView } from '../canvas/nodes/StepNode';
import { WorkflowView } from '../canvas/nodes/WorkflowNode';
import { SvgDefs } from '../canvas/SvgDefs';
import { pathOf } from '../canvas/svgPath';
import { toFlow } from '../canvas/toFlow';
import { CONDITIONS } from '../model/entryConditions';

/**
 * The workflow as drawn on the canvas, as one standalone SVG (the user's rule, 2026-10-11): published to the workflow row
 * on every applied Save, so the Kibana dashboard's diagram panel shows the saved drawing in the canvas's own art. The
 * canvas's components are rendered here as they are on the canvas, with its styles and its two faces built in (an image
 * fetches nothing), on the canvas's ground, the legend below. A snapshot carries no live state: no health colours, no
 * pulse and no run state in the dial, which would be stale by the time it is read; the title names the workflow.
 */
export function diagramSvg(doc: StudioDocument, fitter: TextFitter): string {
  const { nodes, edges } = toFlow(doc, fitter);
  const wf = doc.graph.workflow;

  // bounds of everything drawn: every node box (the dial's glow reaches 28 past its ring) and every wire point
  const xs: number[] = [], ys: number[] = [];
  for (const n of nodes) {
    const pad = n.type === 'workflow' ? 28 : 0;
    xs.push(n.position.x - pad, n.position.x + (n.width ?? 0) + pad);
    ys.push(n.position.y - pad, n.position.y + (n.height ?? 0) + pad);
  }
  for (const e of edges) for (const [x, y] of e.data?.points ?? []) { xs.push(x); ys.push(y); }
  const M = 32, HEAD = 48, FOOT = 56;
  const left = Math.floor(Math.min(...xs)) - M, top = Math.floor(Math.min(...ys)) - M - HEAD;
  const width = Math.ceil(Math.max(...xs)) + M - left, height = Math.ceil(Math.max(...ys)) + M + FOOT - top;

  const body = (
    <g className="studio-canvas">
      {edges.map((e) => (e.type === 'cable'
        ? <CableEdgeView key={e.id} {...(e.data as CableEdgeData)} flowing={false} />
        : <path key={e.id} className="tether" d={pathOf(e.data!.points)} />))}
      {nodes.map((n) => (
        <g key={n.id} transform={`translate(${n.position.x} ${n.position.y})`}>
          {n.type === 'workflow' && <WorkflowView {...n.data} started={false} status="stopped" />}
          {n.type === 'step' && <StepView {...n.data} health="undetermined" />}
          {n.type === 'cache' && <CacheView {...n.data} />}
        </g>
      ))}
      <text className="dg-title" x={left + M} y={top + 30}>{wf.name}<tspan className="dg-version" dx="10">{wf.version}</tspan></text>
      <Legend x={left + M} y={top + height - FOOT / 2 - 4} />
    </g>
  );

  // the run state is live, so the snapshot's dial shows WORKFLOW alone
  // rendered inside an <svg> so React treats every element as SVG (a gradient outside one is HTML to it); the wrapper goes
  const art = renderToStaticMarkup(<svg>{body}</svg>).replace(/^<svg>/, '').replace(/<\/svg>$/, '').replace(/<text class="nx-state[^"]*"[^>]*>[\s\S]*?<\/text>/g, '');
  const defs = /<defs>[\s\S]*<\/defs>/.exec(renderToStaticMarkup(<SvgDefs />))?.[0] ?? '';
  const css = [
    `@font-face{font-family:"IBM Plex Sans Condensed";font-weight:400;src:url(${sansFont}) format("woff2")}`,
    `@font-face{font-family:"IBM Plex Mono";font-weight:400;src:url(${monoFont}) format("woff2")}`,
    tokensCss, canvasCss, artCss, SNAPSHOT_CSS,
  ].join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(`${wf.name} ${wf.version}`)}">`
    + `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>${defs}`
    + `<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#0A1220"/>${art}</svg>`;
}

/** What a still picture needs over the canvas's own styles: nothing moves, nothing is a control, the title and legend. */
const SNAPSHOT_CSS = `
*{animation:none!important}
.nx-hit,.nx-pulse{display:none}
.dg-title{font:600 18px var(--sans);fill:var(--ink)}
.dg-version{font:400 13px var(--mono);fill:var(--muted)}
.dg-lg{font:400 13px var(--sans);fill:var(--muted)}
.dg-pill{font:700 10px var(--sans);fill:#04111F}
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The canvas legend (canvas/Legend.tsx) drawn in SVG: each family's pill and wire, then undecided and short circuit. */
function Legend({ x, y }: { x: number; y: number }) {
  const items: { w: number; el: (at: number) => ReactElement }[] = [
    ...CONDITIONS.map((c) => ({
      w: 54 + c.name.length * 7,
      el: (at: number) => (
        <g key={c.value} className="cmark" transform={`translate(${at} ${y})`} style={{ '--nc': c.colour } as CSSProperties}>
          <rect x={0} y={-9} width={16} height={18} rx={4} fill={c.colour} />
          <text className="dg-pill" x={8} y={4} textAnchor="middle">{c.letter}</text>
          <circle className="lg-src" cx={23} cy={0} r={2} />
          <path className="lg-w" d="M25 0H43" stroke={c.colour} />
          <path className="lg-head" d="M38 -3.5L43 0L38 3.5" stroke={c.colour} />
          <text className="dg-lg" x={50} y={4.5}>{c.name}</text>
        </g>
      ),
    })),
    {
      w: 112,
      el: (at: number) => (
        <g key="undecided" className="legend" transform={`translate(${at} ${y})`}>
          <circle className="lg-ring" cx={3} cy={0} r={2.2} />
          <path className="lg-undecided" d="M5 0H26" />
          <path className="lg-arrow" d="M21 -4L26 0L21 4" />
          <text className="dg-lg" x={34} y={4.5}>undecided</text>
        </g>
      ),
    },
    {
      w: 120,
      el: (at: number) => (
        <g key="short" className="legend" transform={`translate(${at} ${y})`}>
          <path className="lg-line" d="M1 0H29" />
          <circle className="lg-short" cx={15} cy={0} r={3.5} />
          <text className="dg-lg" x={36} y={4.5}>short circuit</text>
        </g>
      ),
    },
  ];
  let at = x;
  return <g>{items.map((it) => { const el = it.el(at); at += it.w; return el; })}</g>;
}


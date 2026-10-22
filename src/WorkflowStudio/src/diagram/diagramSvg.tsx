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
 * Light, unlike the canvas (the user's rule, 2026-10-11): the Kibana dashboard is light, so the snapshot is drawn on white
 * with the canvas's art recoloured for it (LIGHT_CSS, the deeper wire colours, the silver cap); the canvas stays dark.
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
  const art = lightWires(renderToStaticMarkup(<svg>{body}</svg>).replace(/^<svg>/, '').replace(/<\/svg>$/, '').replace(/<text class="nx-state[^"]*"[^>]*>[\s\S]*?<\/text>/g, ''));
  const defs = (/<defs>[\s\S]*<\/defs>/.exec(renderToStaticMarkup(<SvgDefs />))?.[0] ?? '')
    .replace('stop-color="#FFFFFF" stop-opacity=".95"', `stop-color="${LIGHT_CAP[0]}" stop-opacity="1"`)
    .replace('stop-color="#B9C9E2" stop-opacity=".72"', `stop-color="${LIGHT_CAP[1]}" stop-opacity="1"`);
  const css = [
    `@font-face{font-family:"IBM Plex Sans Condensed";font-weight:400;src:url(${sansFont}) format("woff2")}`,
    `@font-face{font-family:"IBM Plex Mono";font-weight:400;src:url(${monoFont}) format("woff2")}`,
    tokensCss, canvasCss, artCss, SNAPSHOT_CSS, LIGHT_CSS,
  ].join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(`${wf.name} ${wf.version}`)}">`
    + `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>${defs}`
    + `<rect x="${left}" y="${top}" width="${width}" height="${height}" fill="${LIGHT_GROUND}"/>${art}</svg>`;
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

/** The dashboard's ground: white, as the Kibana panel behind the image. */
export const LIGHT_GROUND = '#FFFFFF';

/** The step's title cap on white: the canvas's white-to-silver gloss would vanish, so a pale silver, opaque. */
const LIGHT_CAP = ['#F4F7FB', '#D3DDEA'] as const;

/**
 * The wire colours on white: each family's own hue, deepened until a thin trace reads on white (the canvas's are tuned for
 * its dark ground). Only strokes and --nc change, so a step's letter badge and the legend's pill keep the bright colour
 * under their dark letter, as on the canvas.
 */
export const LIGHT_WIRE: Readonly<Record<string, string>> = {
  '#2DD4BF': '#0D9488', '#FF7A66': '#E04F39', '#F5B841': '#B7791F', '#B392F0': '#7C5CD6', '#F472B6': '#DB2777',
  '#8A97A8': '#6B7889', '#5A6B86': '#4A5A73',
};
const lightWires = (markup: string) =>
  markup.replace(/(stroke="|--nc:)(#[0-9A-Fa-f]{6})/g, (_, at: string, hex: string) => at + (LIGHT_WIRE[hex.toUpperCase()] ?? hex));

/**
 * The canvas's dark theme turned light for the snapshot: its tokens, then the art's own dark fills (bodies, sockets, wire
 * ends), and no glows, which on white read as smudges.
 */
const LIGHT_CSS = `
:root{--ground:#FFFFFF;--ground-2:#F5F7FA;--panel:#F3F6FA;--panel-2:#E9EEF5;--line:#D5DEEA;--line-2:#B8C5D6;
--ink:#152033;--muted:#55667F;--faint:#8394AB;--accent:#0369A1;--structure:#2B3D5A;--block:#F7F9FC;
--healthy:#15803D;--unhealthy:#DC2626;--undetermined:#64748B;--warn:#B7791F}
.nx{--nh:color-mix(in srgb,var(--nc) 78%,black)}
.nx-bd{fill:#EEF2F8}
.nx-nd{fill:#FFFFFF}
.nx-g,.nx-gs,.wire path.w,.wire .nx-head,.wire .nx-joint,.wire .nx-joint.short,.wire .nx-overlap,.cmark .lg-w{filter:none}
.cachetag .nx-cn{fill:var(--ink)}
.wire .nx-src,.cmark .lg-src{fill:#FFFFFF}
.wire .nx-joint,.legend .lg-short{stroke:#FFFFFF}
.legend .lg-line{stroke:#8394AB}
.dg-title{fill:var(--ink)}
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The canvas legend (canvas/Legend.tsx) drawn in SVG: each family's pill and wire, then the short circuit. */
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


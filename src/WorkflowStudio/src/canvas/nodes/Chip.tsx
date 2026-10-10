import type { Health } from '../../api/liveness';
import type { FittedText } from '../fitText';
import { Label, Tip } from './Label';
import { closingDash } from './nxShapes';

export interface ProcessorView {
  /** The processor's id ('' when the step's processor is not in the graph): its health is looked up by it. */
  processorId: string;
  title: FittedText;
  /** null when the title had no room for it (the version drops first). */
  version: string | null;
  rows: { label: string; value: FittedText | null }[];
  inputLit: boolean;
  outputLit: boolean;
  tooltip: string;
}

const W = 176, H = 80;
/** The processor image's centre, panel-local: on the step's processor middle (step y 96). */
const CX = 36, CY = 40;
/** The gallery's HUD ring (FRAMES.hud.ring: r 38 / 44 / 49) at the panel's scale, 0.58. */
const SPINNER = closingDash(28.5, [30, 12, 6, 12], 0.58);
const HEALTH_CLASS: Record<Health, string> = { healthy: '', unhealthy: ' nx-halted', undetermined: ' nx-halted nx-wait' };

/** The gear chip (mockup v50 nxGearChip): a chip outline with three pins a side and a gear in its core. */
function GearChip() {
  const h = 12.5, pin = 5, r = 4.6, offs = [-h * 0.55, 0, h * 0.55];
  const pins = offs.map((o) => `M${CX + o} ${CY - h}v${-pin}M${CX + o} ${CY + h}v${pin}M${CX - h} ${CY + o}h${-pin}M${CX + h} ${CY + o}h${pin}`).join('');
  return (
    <>
      <g className="nx-g">
        <path className="nx-hl nx-pins" d={pins} />
        <rect className="nx-hl nx-bd nx-chipbody" x={CX - h} y={CY - h} width={2 * h} height={2 * h} rx={h * 0.22} />
      </g>
      <rect className="nx-ln nx-core" x={CX - h * 0.62} y={CY - h * 0.62} width={h * 1.24} height={h * 1.24} rx={h * 0.12} />
      <g className="nx-g">
        {Array.from({ length: 8 }, (_, i) => (
          <rect key={i} className="nx-fh" x={CX - 1.45} y={CY - r - 2.1} width={2.9} height={3.3} rx={0.6} transform={`rotate(${i * 45} ${CX} ${CY})`} />
        ))}
        <circle className="nx-fh" cx={CX} cy={CY} r={r} />
      </g>
      <circle className="nx-bd" cx={CX} cy={CY} r={r * 0.42} />
    </>
  );
}

/**
 * The processor panel inside a step (spec §5.1; mockup v50 drawChip, gallery HUD ring). On the left
 * the processor image in its health colour: healthy green with the ring turning, unhealthy red and
 * still, undetermined grey, still and blinking slowly. On the right its name and the in / out / cfg
 * slots. A contact sits on the panel edge at every height a wire lands or leaves, lit when that side
 * declares a schema. `ins` and `outs` are panel-local heights.
 */
export function ChipView({ p, ins, outs, health }: { p: ProcessorView; ins: number[]; outs: number[]; health: Health }) {
  return (
    <g className="chipg nx" transform="translate(24,56)" data-processor={p.processorId}>
      <title>{p.tooltip}</title>
      <rect className="nx-bd" width={W} height={H} rx={5} />
      <g className="nx-g"><rect className="nx-ln nx-panel" width={W} height={H} rx={5} /></g>
      <rect className="nx-fc nx-d1" x={146} y={5} width={8} height={3} rx={1} />
      <rect className="nx-fc nx-d1" x={158} y={5} width={8} height={3} rx={1} />
      {ins.map((y, i) => <rect key={`in${i}`} className={p.inputLit ? 'nx-fh nx-g' : 'nx-nd'} x={-2} y={y - 4} width={6} height={8} rx={1.2} />)}
      {outs.map((y, i) => <rect key={`out${i}`} className={p.outputLit ? 'nx-fh nx-g' : 'nx-nd'} x={W - 4} y={y - 4} width={6} height={8} rx={1.2} />)}
      <g className={`nx nx-health${HEALTH_CLASS[health]}`} data-health={health}>
        <g className="nx-g"><circle className="nx-ln nx-dots" cx={CX} cy={CY} r={22} /></g>
        <circle className="nx-ln nx-d2" cx={CX} cy={CY} r={25.5} />
        <circle className="nx-hl nx-spin nx-spinner" cx={CX} cy={CY} r={28.5} style={{ strokeDasharray: SPINNER }} />
        <GearChip />
      </g>
      <path className="nx-ln nx-d2" d="M74 30H170" />
      <text className="nx-tp" x={74} y={13}>PROCESSOR</text>
      <Tip full={p.title.full} cut={p.title.cut}>
        <text className="nx-pn" x={74} y={26}>
          <tspan>{p.title.text}</tspan>
          {p.version && <tspan className="nx-pv">{` ${p.version}`}</tspan>}
        </text>
      </Tip>
      {p.rows.map((row, i) => {
        const y = 43 + i * 14;
        return (
          <g key={row.label}>
            <text className="nx-tl" x={74} y={y}>{row.label}</text>
            {row.value
              ? <Label className="nx-tv" x={94} y={y} fitted={{ ...row.value, full: `${row.label}  ${row.value.full}` }} />
              : <text className="nx-tn" x={94} y={y}>∅</text>}
            <rect className={row.value ? 'nx-fc nx-gs' : 'nx-fc nx-d3'} x={74} y={y + 3.75} width={96} height={0.5} rx={0.25} />
          </g>
        );
      })}
    </g>
  );
}

/** The tooltip of a step's empty processor slot (2026-10-10). */
export const EMPTY_SLOT_TIP = 'No processor: drag one from the toolbox. Save will fail until this step has one.';

/**
 * Where a step's processor was, once the design removed it (2026-10-10): the panel's outline dashed in amber (warn) with
 * a ⚠ in its centre, with a transparent background (no plate behind the glyph). Not a `.chipg`: a click on it picks the step, there is no processor to pick.
 */
export function EmptySlot() {
  return (
    <g className="chip-empty" transform="translate(24,56)" data-processor="">
      <title>{EMPTY_SLOT_TIP}</title>
      {/* transparent inside (the user's addition): only the dashed outline and the glyph are drawn, nothing behind the ⚠ */}
      <rect className="chip-empty-line" width={W} height={H} rx={5} fill="none" />
      <text className="chip-empty-mark" x={W / 2} y={H / 2 + 7} textAnchor="middle">⚠</text>
    </g>
  );
}

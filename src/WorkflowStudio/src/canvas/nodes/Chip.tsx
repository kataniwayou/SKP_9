import type { FittedText } from '../fitText';
import { Tip } from './Label';

export interface ProcessorView {
  title: FittedText;
  /** null when the title had no room for it (the version drops first). */
  version: string | null;
  rows: { label: string; value: FittedText | null }[];
  inputLit: boolean;
  outputLit: boolean;
  tooltip: string;
}

const W = 176, H = 80, DX = 12, DY = 6, DW = W - 24, DH = H - 14;

/**
 * The processor drawn as a glossy die on a substrate (spec §5.1, mockup drawChip): SMD parts on
 * the border and an edge contact with a bond trace at every height a wire lands or leaves. A contact
 * is lit when the processor declares that side's schema. `ins` and `outs` are chip-local heights.
 */
export function ChipView({ p, ins, outs }: { p: ProcessorView; ins: number[]; outs: number[] }) {
  const contact = (key: string, edgeX: number, y: number, lit: boolean, dir: 1 | -1) => (
    <g key={key}>
      <path className={lit ? 'bond-on' : 'bond-off'} d={`M${edgeX + dir * 2} ${y} H${dir > 0 ? DX : DX + DW}`} />
      <rect className={lit ? 'pad-io' : 'pad-null'} x={dir > 0 ? 0 : W - 4} y={y - 3} width={4} height={6} rx={1} />
    </g>
  );

  return (
    <g className="chipg" transform="translate(24,56)">
      <title>{p.tooltip}</title>
      <rect className="cbody" width={W} height={H} rx={5} />
      <rect className="crim" x={0.6} y={0.6} width={W - 1.2} height={H - 1.2} rx={4.5} />
      {[30, 46, W - 46, W - 30].map((px) => (
        <g key={px}>
          <rect className="smd" x={px - 3} y={H - 7} width={6} height={3} rx={0.5} />
          <rect className="smdc" x={px - 3} y={H - 7} width={1.4} height={3} />
          <rect className="smdc" x={px + 1.6} y={H - 7} width={1.4} height={3} />
        </g>
      ))}
      {ins.map((y, i) => contact(`in${i}`, 0, y, p.inputLit, 1))}
      {outs.map((y, i) => contact(`out${i}`, W, y, p.outputLit, -1))}
      <rect className="diebody" x={DX} y={DY} width={DW} height={DH} rx={3} />
      <ellipse cx={DX + 38} cy={DY + 5} rx={42} ry={6} fill="url(#glint)" opacity={0.4} />
      <rect className="dierim" x={DX + 0.5} y={DY + 0.5} width={DW - 1} height={DH - 1} rx={2.5} />
      <Tip full={p.title.full} cut={p.title.cut}>
        <text className="ptitle" x={DX + 8} y={DY + 14}>
          <tspan>{p.title.text}</tspan>
          {p.version && <tspan className="pv">{` ${p.version}`}</tspan>}
        </text>
      </Tip>
      {p.rows.map((row, i) => (
        <Tip key={row.label} full={`${row.label.trim()}  ${row.value?.full ?? ''}`} cut={row.value?.cut ?? false}>
          <text className="io" x={DX + 8} y={DY + 35 + i * 13}>
            <tspan className="lab">{row.label}</tspan>
            {row.value ? <tspan>{row.value.text}</tspan> : <tspan className="nul">∅</tspan>}
          </text>
        </Tip>
      ))}
    </g>
  );
}

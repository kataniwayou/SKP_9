import { entityName } from '../model/entityNames';
import type { Schema } from '../model/graph';
import { FIELDS } from '../store/entityForms';
import type { ToolboxPick } from '../store/studioState';
import { DictEditor } from './DictEditor';
import { ProcessorLivenessSection } from './Inspector';
import { overlayCache, overlayProcessor, useActiveDesignGraph } from './toolboxView';

const ITEMS = FIELDS.cache.find((f) => f.key === 'items')!;
const noop = () => {};

/** Read-only text: one line, cut with an ellipsis, its full text a tooltip only when cut (as the Inspector's). */
const row = (label: string, value: string) => (
  <div key={label} className="field"><label>{label}</label><span className="ro" data-tipcut={value}>{value}</span></div>
);

/**
 * A processor or cache picked in the Toolbox (2026-10-11), shown read-only: the Toolbox only drags, so nothing here edits.
 * Its values are BaseApi's, or the active document's design's when that design changed it (marked unsaved). Dropped on a
 * canvas it becomes part of that design, where the Inspector edits it.
 */
export function ToolboxEntityPane({ pick }: { pick: ToolboxPick }) {
  const design = useActiveDesignGraph();
  const shown = pick.kind === 'processor' ? overlayProcessor(pick.processor, design) : overlayCache(pick.cache, design);
  const v = shown.value;
  const name = entityName(v.name, v.version, v.id);
  return (
    <div className="paneBody" data-pane="inspector" data-source="toolbox">
      <div className="ph2">
        <span className="kindpill">{pick.kind.toUpperCase()}</span>
        {shown.unsaved && <span className="unsaved">● unsaved changes</span>}
      </div>
      <div className="pbody">
        <div className="sec">
          <p className="note">From the Toolbox: read-only. Drop it on a canvas to use it; the Inspector edits it there.</p>
        </div>
        <div className="sec" aria-readonly="true">
          <div className="uname" aria-label="Unique name"><span className="ro" data-tipcut={name}>{name}</span></div>
          <div className="sec-title">{pick.kind === 'processor' ? 'Processor' : 'Cache'}</div>
          {row('Name', v.name)}
          {row('Version', v.version)}
          {row('Description', v.description ?? '')}
          {pick.kind === 'cache' && 'root' in v && row('Root', v.root)}
          {pick.kind === 'cache' && 'items' in v && (
            <DictEditor key={`${v.id}:${v.items}`} spec={ITEMS} value={v.items} errors={[]} onChange={noop} readOnly />
          )}
        </div>
        {pick.kind === 'processor' && <ProcessorLivenessSection processorId={pick.processor.id} />}
        {pick.kind === 'processor' && (
          <div className="sec">
            <div className="sec-title">Schemas</div>
            {([['In', pick.processor.inputSchemaId], ['Out', pick.processor.outputSchemaId], ['Config', pick.processor.configSchemaId]] as const).map(([label, id]) => {
              const s: Schema | undefined = id ? pick.schemas.find((x) => x.id === id) : undefined;
              const text = id ? (s ? entityName(s.name, s.version, s.id) : id) : '∅';
              return (
                <div key={label} className="slot">
                  <span className="k">{label}</span>
                  <span className={id ? 'v' : 'v null'} data-tipcut={text}>{text}</span>
                  <span />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

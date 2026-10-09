import { Fragment, useEffect, useMemo } from 'react';
import type { EntityReadDto } from '../api/entities';
import type { StepReadDto } from '../api/types';
import type { StudioDocument } from '../app/document';
import { useStudioActions } from '../app/studioActions';
import { applyEdits } from '../design/apply';
import { fieldsOf, hasEdit, slotKey, valueText } from '../design/design';
import { assignmentByStep, payloadKeyCount } from '../model/assignments';
import { entityName } from '../model/entityNames';
import { FIELDS, savedText, type FieldSpec } from '../store/entityForms';
import { crumbLabel, editTargetOf, rootTarget, targetKey, type InspectorTarget, type SchemaSlot } from '../store/inspectorTarget';
import { activeDocument, shownTargetOf, type OpenDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { FieldEditor } from './FieldEditor';
import { detailRows, kindLabel, uniqueNameOf, type Row } from './inspectorView';
import { PaneNote } from './PaneNote';
import { GraphReadoutSection, WireReadoutPane } from './Readouts';

/** Read-only text: one line, cut with an ellipsis, its full text a tooltip only when cut (spec §7). */
const readOnly = (row: Row) => (
  <div key={row.label} className="field"><label>{row.label}</label><span className="ro" data-tipcut={row.value}>{row.value}</span></div>
);

/**
 * The shared Inspector (spec §7, §7.1). It follows the active document's selection wherever the pane
 * is, reads the shown entity, and edits its own metadata: Revert, drill-downs with a breadcrumb, the
 * last Save's errors under their fields. Edits go to the design (plan 8 §3.3); nothing here writes to BaseApi.
 */
export function Inspector() {
  const active = useStudio(activeDocument);
  const { service } = useStudioActions();
  const target = active === null ? null : shownTargetOf(active);
  const key = targetKey(target);
  const workflowId = active?.workflowId ?? null;
  const ready = active?.status.kind === 'ready';
  useEffect(() => {
    if (workflowId !== null && ready && key !== 'none') service.read(workflowId);
  }, [service, workflowId, ready, key]);

  if (active === null) return <PaneNote pane="inspector">Open a workflow to inspect it.</PaneNote>;
  if (active.status.kind === 'loading') return <PaneNote pane="inspector">Loading…</PaneNote>;
  if (active.status.kind === 'failed') return <PaneNote pane="inspector">{active.status.message}</PaneNote>;
  // several picks, or one wire, have no entity to edit (spec §3.3)
  if (active.picks.length > 1) return <PaneNote pane="inspector">{`${active.picks.length} items selected`}</PaneNote>;
  const onlyWire = active.picks.length === 1 && active.picks[0]!.kind === 'wire' ? active.picks[0]!.id : null;
  // a picked wire is read as the canvas draws it: the design over the base (the user's request, 2026-10-09)
  if (onlyWire !== null) return <WireReadoutPane open={active} id={onlyWire} />;
  if (target === null) return <PaneNote pane="inspector">Nothing selected. Click a step, a processor, a cache or the workflow.</PaneNote>;
  return <EntityPane open={active} target={target} />;
}

function EntityPane({ open, target }: { open: OpenDocument; target: InspectorTarget }) {
  const store = useStudioStore();
  const showDetails = useStudio((s) => s.showDetails);
  const { service } = useStudioActions();
  const { workflowId, inspector } = open;
  const base = open.status.kind === 'ready' ? open.status.doc : null;
  // the Inspector shows the design: names, assignments and schema copies as edited (spec §3.1)
  const doc = useMemo(() => (base ? applyEdits(base, open.edits) : null), [base, open.edits]);
  if (doc === null || base === null) return null;
  const drill = (next: InspectorTarget) => store.dispatch({ type: 'drill', workflowId, target: next });
  const back = (depth: number) => store.dispatch({ type: 'back', workflowId, depth });
  const crumbs = [rootTarget(open.selection, workflowId)!, ...inspector.trail];
  const saved = inspector.saved?.key === targetKey(target) ? inspector.saved.dto : null;
  const fields = fieldsOf(open.edits, editTargetOf(target));
  // a stamp-only entry counts: it is sent on Save, and Revert is how a stale one is cleared (spec §6.2)
  const dirty = hasEdit(open.edits, editTargetOf(target));

  return (
    <div className="paneBody" data-pane="inspector">
      <div className="ph2">
        <span className="kindpill">{kindLabel(target)}</span>
        {dirty && <span className="unsaved">● unsaved changes</span>}
      </div>
      {crumbs.length > 1 && (
        <nav className="crumbs" aria-label="Drill-down">
          <button type="button" className="link" aria-label="Back" onClick={() => back(inspector.trail.length - 1)}>‹</button>
          {crumbs.map((t, i) => (i === crumbs.length - 1
            ? <span key={i} aria-current="page">{crumbLabel(t)}</span>
            : <Fragment key={i}><button type="button" className="link" onClick={() => back(i)}>{crumbLabel(t)}</button><span className="sep">›</span></Fragment>))}
        </nav>
      )}
      {saved === null ? (
        <div className="pbody">
          <div className="sec">
            <p className={inspector.readError ? 'note warn' : 'note'}>{inspector.readError ?? 'Loading…'}</p>
            {inspector.readError && <button type="button" className="btn" onClick={() => service.read(workflowId, true)}>Retry</button>}
          </div>
        </div>
      ) : (
        <>
          <div className="pbody">
            {inspector.readError && <div className="sec"><p className="note warn">{inspector.readError}</p></div>}
            {/* read-only while a Save is in flight (spec §4.1) */}
            <fieldset className="plain" disabled={open.saving}>
              <EntityForm open={open} doc={doc} base={base} target={target} saved={saved} fields={fields} showDetails={showDetails} drill={drill} />
            </fieldset>
            {/* the drawing's graph read as text, read-only (the user's request, 2026-10-09) */}
            {target.kind === 'workflow' && <GraphReadoutSection open={open} />}
          </div>
          <div className="savebar">
            {target.kind === 'assignment' && (
              <button type="button" className="link danger" disabled={open.saving}
                onClick={() => service.removeAssignment(workflowId, target.stepId)}>Remove assignment</button>
            )}
            <button type="button" className="btn" disabled={!dirty || open.saving} onClick={() => service.revert(workflowId)}>Revert</button>
          </div>
        </>
      )}
    </div>
  );
}

const SLOTS: ReadonlyArray<{ slot: SchemaSlot; label: string; key: 'inputSchemaId' | 'outputSchemaId' | 'configSchemaId' }> = [
  { slot: 'input', label: 'In', key: 'inputSchemaId' },
  { slot: 'output', label: 'Out', key: 'outputSchemaId' },
  { slot: 'config', label: 'Config', key: 'configSchemaId' },
];

function EntityForm({ open, doc, base, target, saved, fields, showDetails, drill }: {
  open: OpenDocument; doc: StudioDocument; base: StudioDocument; target: InspectorTarget; saved: EntityReadDto;
  fields: Readonly<Record<string, string | number | null>>; showDetails: boolean; drill: (t: InspectorTarget) => void;
}) {
  const store = useStudioStore();
  const { service } = useStudioActions();
  const { workflowId } = open;
  const shown = (key: string) => (Object.hasOwn(fields, key) ? valueText(fields[key]) : savedText(saved, key));
  // the last Save's errors on this entity, under their fields (Problems lists them all)
  const entityId = target.kind === 'workflow' ? workflowId : target.kind === 'schema' ? open.edits.schemas[slotKey(target.processorId, target.slot)]?.id ?? target.id : target.id;
  const errorsOf = (key: string) => (open.errors ?? []).filter((e) => e.id === entityId && e.field === key).map((e) => e.message);
  const editor = (spec: FieldSpec) => (
    <FieldEditor key={spec.key} spec={spec} value={shown(spec.key)} saved={savedText(saved, spec.key)} errors={errorsOf(spec.key)}
      onChange={(text) => service.edit(workflowId, spec, text)} />
  );
  const { graph } = doc;
  // a schema copy and a created assignment are not in the database: they are named by what the design holds
  const copy = target.kind === 'schema' ? open.edits.schemas[slotKey(target.processorId, target.slot)] : undefined;
  const created = target.kind === 'assignment' && open.edits.assignments[target.stepId]?.op === 'create';
  const name = copy ? entityName(shown('name'), shown('version'), copy.id)
    : created ? entityName(shown('name'), shown('version'), target.id)
      : uniqueNameOf(saved);

  return (
    <>
      <div className="sec">
        <div className="uname" aria-label="Unique name"><span className="ro" data-tipcut={name}>{name}</span></div>
        <div className="sec-title">{crumbLabel(target)}</div>
        {FIELDS[target.kind].slice(0, 2).map(editor)}
        <div className="metatog">
          <button type="button" className="link" onClick={() => store.dispatch({ type: 'toggleDetails' })}>
            {showDetails ? '▾ hide details' : '▸ show all'}
          </button>
        </div>
        {showDetails && <div className="meta">{detailRows(saved).map(readOnly)}</div>}
        {FIELDS[target.kind].slice(2).map(editor)}
        {target.kind === 'step' && (() => {
          const step = saved as StepReadDto;
          const p = graph.processors.get(step.processorId ?? '');
          const label = p ? entityName(p.name, p.version, p.id) : step.processorId ?? '';
          return (
            <div className="field">
              <label>Processor</label>
              <button type="button" className="drill" data-tipcut={label} onClick={() => drill({ kind: 'processor', id: step.processorId ?? '' })}>{label}</button>
            </div>
          );
        })()}
        {target.kind === 'step' && (() => {
          const assignment = assignmentByStep(graph.assignments).get(target.id);
          if (!assignment) {
            return (
              <div className="field">
                <label>Assignment</label>
                <button type="button" className="link" onClick={() => service.createAssignment(workflowId, target.id, shown('name'))}>＋ Create</button>
              </div>
            );
          }
          const keys = payloadKeyCount(assignment.payload);
          const label = keys === null ? '◆ payload' : `◆ ${keys} key${keys === 1 ? '' : 's'}`;
          return (
            <div className="field">
              <label>Assignment</label>
              <div className="fval arow">
                <button type="button" className="drill" onClick={() => drill({ kind: 'assignment', id: assignment.id, stepId: target.id })}>{label}</button>
                <button type="button" className="link danger" onClick={() => service.removeAssignment(workflowId, target.id)}>✕ Remove</button>
              </div>
            </div>
          );
        })()}
        {target.kind === 'assignment' && (() => {
          const s = graph.steps.get(target.stepId);
          return readOnly({ label: 'Step', value: s ? entityName(s.name, s.version, s.id) : target.stepId });
        })()}
      </div>
      {target.kind === 'processor' && (
        <div className="sec">
          <div className="sec-title">Schemas</div>
          {SLOTS.map(({ slot, label, key }) => {
            // the slot as designed (a copy re-points it); the drill reads the base's schema and edits it through the copy
            const designed = graph.processors.get(target.id)?.[key] ?? null;
            const original = base.graph.processors.get(target.id)?.[key] ?? null;
            const schema = designed ? graph.schemas.get(designed) : undefined;
            const text = designed ? (schema ? entityName(schema.name, schema.version, schema.id) : designed) : '∅';
            const go = () => drill({ kind: 'schema', id: original ?? '', slot, processorId: target.id });
            return (
              <div key={slot} className="slot">
                <span className="k">{label}</span>
                {designed
                  ? <button type="button" className="v drill" data-tipcut={text} onClick={go}>{text}</button>
                  : <span className="v null" data-tipcut={text}>{text}</span>}
                {designed ? <span /> : <button type="button" className="link" onClick={go}>＋ Define</button>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

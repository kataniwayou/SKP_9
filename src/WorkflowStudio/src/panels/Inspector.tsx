import { Fragment, useEffect, useRef } from 'react';
import type { EntityReadDto } from '../api/entities';
import type { AssignmentReadDto, ProcessorReadDto, StepReadDto } from '../api/types';
import type { StudioDocument } from '../app/document';
import { useStudioActions } from '../app/studioActions';
import { assignmentByStep, payloadKeyCount } from '../model/assignments';
import { entityName } from '../model/entityNames';
import { FIELDS, missingRequired, savedText, shownText, type FieldSpec } from '../store/entityForms';
import { hasEdits } from '../store/inspector';
import { crumbLabel, entityKindOf, rootTarget, targetKey, type InspectorTarget, type SchemaSlot } from '../store/inspectorTarget';
import { activeDocument, shownTargetOf, type OpenDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { FieldEditor } from './FieldEditor';
import { detailRows, kindLabel, uniqueNameOf, type Row } from './inspectorView';
import { PaneNote } from './PaneNote';

/** Read-only text: one line, cut with an ellipsis, its full text a tooltip only when cut (spec §7). */
const readOnly = (row: Row) => (
  <div key={row.label} className="field"><label>{row.label}</label><span className="ro" data-tipcut={row.value}>{row.value}</span></div>
);

/**
 * The shared Inspector (spec §7, §7.1). It follows the active document's selection wherever the pane
 * is, reads the shown entity, and edits its own metadata: Save and Revert, drill-downs with a
 * breadcrumb, server errors under their fields or in a banner. Unsaved edits live in the store.
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
  if (target === null) return <PaneNote pane="inspector">Nothing selected. Click a step, a processor, a cache or the workflow.</PaneNote>;
  return <EntityPane open={active} doc={active.status.doc} target={target} />;
}

function EntityPane({ open, doc, target }: { open: OpenDocument; doc: StudioDocument; target: InspectorTarget }) {
  const store = useStudioStore();
  const showDetails = useStudio((s) => s.showDetails);
  const { service, guard, confirmRemove } = useStudioActions();
  const askRemove = (assignmentId: string) => confirmRemove(workflowId, assignmentId, owner.current?.ownerDocument ?? document);
  const owner = useRef<HTMLDivElement>(null);
  const { workflowId, inspector } = open;
  const go = (proceed: () => void) => guard(workflowId, proceed, owner.current?.ownerDocument ?? document);
  const drill = (next: InspectorTarget) => go(() => store.dispatch({ type: 'drill', workflowId, target: next }));
  const back = (depth: number) => go(() => store.dispatch({ type: 'back', workflowId, depth }));
  const crumbs = [rootTarget(open.selection, workflowId)!, ...inspector.trail];
  const saved = inspector.saved?.key === targetKey(target) ? inspector.saved.dto : null;
  const dirty = hasEdits(inspector);

  return (
    <div className="paneBody" data-pane="inspector" ref={owner}>
      <div className="ph2">
        <span className="kindpill">{kindLabel(target, doc)}</span>
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
            {inspector.readError && (
              <button type="button" className="btn" onClick={() => service.read(workflowId, true)}>Retry</button>
            )}
            {inspector.readError && dirty && (
              <button type="button" className="btn" disabled={inspector.busy}
                onClick={() => store.dispatch({ type: 'discard', workflowId })}>Discard unsaved changes</button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="pbody">
            {/* a failed re-read keeps the form (spec §8): it only says so */}
            {inspector.readError && <div className="sec"><p className="note warn">{inspector.readError}</p></div>}
            <EntityForm open={open} doc={doc} target={target} saved={saved} showDetails={showDetails} drill={drill} askRemove={askRemove} />
          </div>
          <div className="savebar">
            {inspector.failure?.banner && <div className="banner" role="alert">{inspector.failure.banner}</div>}
            {target.kind === 'newAssignment' ? (
              <>
                <button type="button" className="btn" onClick={() => back(inspector.trail.length - 1)}>Cancel</button>
                <button type="button" className="btn primary" disabled={inspector.busy || missingRequired('assignment', saved, inspector.edits)}
                  onClick={() => void service.create(workflowId)}>{inspector.busy ? 'Creating…' : 'Create'}</button>
              </>
            ) : (
              <>
                {target.kind === 'assignment' && (
                  <button type="button" className="link danger" disabled={inspector.busy}
                    onClick={() => askRemove(target.id)}>Remove assignment</button>
                )}
                <button type="button" className="btn" disabled={!dirty || inspector.busy} onClick={() => store.dispatch({ type: 'discard', workflowId })}>Revert</button>
                <button type="button" className="btn primary" disabled={!dirty || inspector.busy || missingRequired(entityKindOf(target), saved, inspector.edits)}
                  onClick={() => void service.save(workflowId)}>{inspector.busy ? 'Saving…' : 'Save'}</button>
              </>
            )}
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

function EntityForm({ open, doc, target, saved, showDetails, drill, askRemove }: {
  open: OpenDocument; doc: StudioDocument; target: InspectorTarget; saved: EntityReadDto; showDetails: boolean; drill: (t: InspectorTarget) => void;
  askRemove: (assignmentId: string) => void;
}) {
  const store = useStudioStore();
  const { workflowId, inspector } = open;
  const kind = entityKindOf(target);
  const editor = (spec: FieldSpec) => (
    <FieldEditor key={spec.key} spec={spec} value={shownText(saved, inspector.edits, spec.key)} saved={savedText(saved, spec.key)}
      errors={inspector.failure?.fields[spec.key] ?? []}
      onChange={(text) => store.dispatch({ type: 'edit', workflowId, key: spec.key, text, saved: savedText(saved, spec.key) })} />
  );
  const { graph } = doc;
  const name = target.kind === 'newAssignment'
    ? `New assignment for ${(() => { const s = graph.steps.get(target.stepId); return s ? entityName(s.name, s.version, s.id) : target.stepName; })()}`
    : uniqueNameOf(saved);

  return (
    <>
      <div className="sec">
        <div className="uname" aria-label="Unique name"><span className="ro" data-tipcut={name}>{name}</span></div>
        <div className="sec-title">{crumbLabel(target)}</div>
        {FIELDS[kind].slice(0, 2).map(editor)}
        {target.kind !== 'newAssignment' && (
          <div className="metatog">
            <button type="button" className="link" onClick={() => store.dispatch({ type: 'toggleDetails' })}>
              {showDetails ? '▾ hide details' : '▸ show all'}
            </button>
          </div>
        )}
        {showDetails && target.kind !== 'newAssignment' && <div className="meta">{detailRows(saved).map(readOnly)}</div>}
        {FIELDS[kind].slice(2).map(editor)}
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
            const stepName = (saved as StepReadDto).name ?? '';
            return (
              <div className="field">
                <label>Assignment</label>
                <button type="button" className="link" disabled={inspector.busy} onClick={() => drill({ kind: 'newAssignment', stepId: target.id, stepName })}>＋ Create</button>
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
                <button type="button" className="link danger" disabled={inspector.busy} onClick={() => askRemove(assignment.id)}>✕ Remove</button>
              </div>
            </div>
          );
        })()}
        {(target.kind === 'assignment' || target.kind === 'newAssignment') && (() => {
          const stepId = (saved as AssignmentReadDto).stepId ?? target.stepId;
          const s = graph.steps.get(stepId);
          return readOnly({ label: 'Step', value: s ? entityName(s.name, s.version, s.id) : stepId });
        })()}
        {target.kind === 'step' && doc.parkedIds.includes(target.id) && <div className="note warn">⚠ Parked: not connected, so not part of this workflow.</div>}
      </div>
      {target.kind === 'processor' && (
        <div className="sec">
          <div className="sec-title">Schemas</div>
          {SLOTS.map(({ slot, label, key }) => {
            const id = (saved as ProcessorReadDto)[key];
            const schema = id ? graph.schemas.get(id) : undefined;
            const text = id ? (schema ? entityName(schema.name, schema.version, schema.id) : id) : '∅';
            return (
              <div key={slot} className="slot">
                <span className="k">{label}</span>
                {id
                  ? <button type="button" className="v drill" data-tipcut={text} onClick={() => drill({ kind: 'schema', id, slot })}>{text}</button>
                  : <span className="v null" data-tipcut={text}>{text}</span>}
                <span />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

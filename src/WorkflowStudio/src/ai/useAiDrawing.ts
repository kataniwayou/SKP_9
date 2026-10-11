import { useCallback, useEffect, useRef, useState } from 'react';
import { applyDesign, applyEdits } from '../design/apply';
import { hasGraphChanges } from '../design/design';
import { shortCircuitErrors } from '../design/shortCircuits';
import type { Id } from '../model/graph';
import type { OutputLevel } from '../store/output';
import { designDirty, type OpenDocument } from '../store/studioState';
import { useStudioStore } from '../store/studioStore';
import { AI_MODEL, AI_TIMEOUT_MS, correctionMessages, DrawingError, firstMessages, judgeDrawing, promptOf, relationsOf, requestDrawing, type ChatMessage } from './drawing';

/**
 * Why the AI drawing is off for a document, or null when it may draw (the user's rule, 2026-10-11): only a valid saved
 * workflow, whatever its run state. Saved: not a new workflow, no design change since its Save, no stored design waiting;
 * valid: BaseApi's dry run passed at that Save, and no problem is pinned in Output since (a short circuit, a Save's errors).
 */
export function aiBlocked(d: OpenDocument): string | null {
  if (d.status.kind !== 'ready') return 'The workflow is not loaded';
  if (d.saving) return 'Saving…';
  if (d.virtual === true) return 'Save the workflow first';
  if (designDirty(d) || (d.stored !== null && hasGraphChanges(d.stored))) return 'Save your changes first';
  if ((d.errors?.length ?? 0) > 0 || shortCircuitErrors(applyDesign(d.status.doc, d.design.draft, d.edits), d.design.draft).length > 0) {
    return 'Fix the problems in Output first';
  }
  if (d.status.doc.graph.steps.size === 0) return 'Nothing to draw';
  return null;
}

/**
 * The toolbar's AI drawing for one document (2026-10-11): snapshot the relations, ask the model (streamed), judge its
 * drawing on a candidate draft, and apply it as one history step only when the relations are unchanged. A refused answer
 * gets one correction round: the model hears exactly why and answers again; refused twice, nothing is applied. One at a
 * time; Cancel aborts; `seconds` counts while it runs.
 */
export function useAiDrawing(workflowId: Id, fetchFn?: typeof fetch) {
  const store = useStudioStore();
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  useEffect(() => {
    if (!running) return undefined;
    const started = Date.now();
    setSeconds(0);
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [running]);

  const log = useCallback((text: string, level: OutputLevel = 'info') => {
    store.dispatch({ type: 'log', workflowId, lines: [{ at: new Date().toISOString(), text, level }] });
  }, [store, workflowId]);

  const draw = useCallback(async () => {
    const d = store.getState().docs.find((x) => x.workflowId === workflowId);
    if (!d || d.status.kind !== 'ready' || ctl.current) return;
    const blocked = aiBlocked(d);
    if (blocked !== null) { log(`AI drawing is not available: ${blocked}`, 'error'); return; }
    const draft = d.design.draft, edits = d.edits;
    const edited = applyEdits(d.status.doc, edits, draft.blocks);
    const snapshot = relationsOf(edited, draft);
    const first = firstMessages(promptOf(edited, draft));
    const c = new AbortController();
    ctl.current = c;
    setRunning(true);
    // the document is locked while the model draws (the user's rule, 2026-10-11): its canvas, Inspector, Toolbox drops,
    // Undo, Save, Start, Stop, Close and Delete wait; selecting and viewing still work
    store.dispatch({ type: 'drawing', workflowId, on: true });
    let timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
    /** One answer, under its own time limit. */
    const ask = async (messages: ChatMessage[]) => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; c.abort(); }, AI_TIMEOUT_MS);
      return requestDrawing(messages, c.signal, fetchFn);
    };
    log(`AI drawing: asking ${AI_MODEL} to redraw the design; it is applied only if every relation between the steps stays the same`);
    try {
      let text = await ask(first);
      let out = judgeDrawing(edited, draft, snapshot, text);
      if (!out.ok) {
        log(`AI drawing: the answer was refused (${out.reason}); asking ${AI_MODEL} once to correct it`);
        text = await ask(correctionMessages(first, text, out.reason));
        out = judgeDrawing(edited, draft, snapshot, text);
      }
      const now = store.getState().docs.find((x) => x.workflowId === workflowId);
      if (!now || now.design.draft !== draft || now.edits !== edits) {
        log('AI drawing not applied: the design changed while the model was drawing', 'error');
        return;
      }
      if (!out.ok) {
        log(`AI drawing not applied: ${out.reason}`, 'error');
        return;
      }
      store.dispatch({ type: 'drawing', workflowId, on: false });
      store.dispatch({ type: 'design', workflowId, draft: out.draft });
      log(`AI drawing applied: ${out.moved} block${out.moved === 1 ? '' : 's'} moved, ${out.rerouted} wire${out.rerouted === 1 ? '' : 's'} routed; crossings ${out.crossings}, short circuits ${out.shorted}`);
    } catch (e) {
      const why = e instanceof DrawingError ? e.message : 'unexpected error';
      if (why === 'cancelled') log(timedOut ? `AI drawing failed: no answer in ${AI_TIMEOUT_MS / 1000} s` : 'AI drawing cancelled', timedOut ? 'error' : 'info');
      else log(why.startsWith('AI drawing') ? why : `AI drawing failed: ${why}`, 'error');
    } finally {
      clearTimeout(timer);
      ctl.current = null;
      store.dispatch({ type: 'drawing', workflowId, on: false });
      setRunning(false);
    }
  }, [store, workflowId, log, fetchFn]);

  const cancel = useCallback(() => ctl.current?.abort(), []);
  return { running, seconds, draw, cancel };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { applyEdits } from '../design/apply';
import type { Id } from '../model/graph';
import type { OutputLevel } from '../store/output';
import { useStudioStore } from '../store/studioStore';
import { AI_MODEL, AI_TIMEOUT_MS, DrawingError, judgeDrawing, promptOf, relationsOf, requestDrawing } from './drawing';

/**
 * The toolbar's AI drawing for one document (2026-10-11): snapshot the relations, ask the model, judge its drawing on a
 * candidate draft, and apply it as one history step only when the relations are unchanged. One at a time; Cancel aborts.
 */
export function useAiDrawing(workflowId: Id, fetchFn?: typeof fetch) {
  const store = useStudioStore();
  const [running, setRunning] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);

  const log = useCallback((text: string, level: OutputLevel = 'info') => {
    store.dispatch({ type: 'log', workflowId, lines: [{ at: new Date().toISOString(), text, level }] });
  }, [store, workflowId]);

  const draw = useCallback(async () => {
    const d = store.getState().docs.find((x) => x.workflowId === workflowId);
    if (!d || d.status.kind !== 'ready' || d.saving || ctl.current) return;
    const draft = d.design.draft, edits = d.edits;
    const edited = applyEdits(d.status.doc, edits, draft.blocks);
    const snapshot = relationsOf(edited, draft);
    const prompt = promptOf(edited, draft);
    const c = new AbortController();
    ctl.current = c;
    setRunning(true);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; c.abort(); }, AI_TIMEOUT_MS);
    log(`AI drawing: asking ${AI_MODEL} to redraw the design; it is applied only if every relation between the steps stays the same`);
    try {
      const text = await requestDrawing(prompt, c.signal, fetchFn);
      const now = store.getState().docs.find((x) => x.workflowId === workflowId);
      if (!now || now.design.draft !== draft || now.edits !== edits) {
        log('AI drawing not applied: the design changed while the model was drawing', 'error');
        return;
      }
      const out = judgeDrawing(edited, draft, snapshot, text);
      if (!out.ok) {
        log(`AI drawing not applied: ${out.reason}`, 'error');
        return;
      }
      store.dispatch({ type: 'design', workflowId, draft: out.draft });
      log(`AI drawing applied: ${out.moved} block${out.moved === 1 ? '' : 's'} moved, ${out.reshaped} wire${out.reshaped === 1 ? '' : 's'} reshaped; crossings ${out.crossings}, short circuits ${out.shorted}`);
    } catch (e) {
      const why = e instanceof DrawingError ? e.message : 'unexpected error';
      if (why === 'cancelled') log(timedOut ? `AI drawing failed: no answer in ${AI_TIMEOUT_MS / 1000} s` : 'AI drawing cancelled', timedOut ? 'error' : 'info');
      else log(why.startsWith('AI drawing') ? why : `AI drawing failed: ${why}`, 'error');
    } finally {
      clearTimeout(timer);
      ctl.current = null;
      setRunning(false);
    }
  }, [store, workflowId, log, fetchFn]);

  const cancel = useCallback(() => ctl.current?.abort(), []);
  return { running, draw, cancel };
}

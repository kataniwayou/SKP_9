import { useCallback, useEffect, useRef, useState } from 'react';
import { applyDesign, applyEdits } from '../design/apply';
import { hasGraphChanges } from '../design/design';
import { shortCircuitErrors } from '../design/shortCircuits';
import type { Id } from '../model/graph';
import type { OutputLevel } from '../store/output';
import { designDirty, type OpenDocument } from '../store/studioState';
import { useStudioStore } from '../store/studioStore';
import {
  AI_SILENCE_MS, AI_TOTAL_MS, correctionMessages, DrawingError, firstMessages, graphOf, judgeDrawing, modelOf, movedBlocksOf, promptOf,
  refinementMessages, relationsOf, remainingProblemsOf, requestDrawing, type ChatMessage, type StreamProgress,
} from './drawing';

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

/** The Cancel button's word on the answer arriving (2026-10-12): "thinking 12k", "writing 2k", or the round's name. */
export function activityOf(round: Round, p: StreamProgress | null): string {
  const k = (n: number) => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`);
  const what = !p || (p.thinking === 0 && p.writing === 0) ? 'waiting' : p.writing > 0 ? `writing ${k(p.writing)}` : `thinking ${k(p.thinking)}`;
  return round === 'drawing' ? what : `${round} · ${what}`;
}

/** The rounds of one press: the drawing, its one correction when refused, its one refinement when problems remain. */
export type Round = 'drawing' | 'correcting' | 'refining';

/**
 * The toolbar's AI drawing for one document (2026-10-11): snapshot the relations, ask the model (streamed), judge its
 * drawing on a candidate draft, and apply it as one history step only when the relations are unchanged. A refused answer
 * gets one correction round: the model hears exactly why and answers again; refused twice, nothing is applied. An
 * accepted drawing with problems left gets one refinement round (the user, 2026-10-12): the model sees its drawing as
 * routed and the problems, and its answer is kept when it leaves no more problems; a refused, failed or silent refinement
 * keeps the first drawing. A round is given up after 60 s of silence, a press after 15 min (2026-10-12). One at a time;
 * Cancel aborts all; `seconds` counts while it runs, `activity` says what is arriving.
 */
export function useAiDrawing(workflowId: Id, fetchFn?: typeof fetch) {
  const store = useStudioStore();
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [activity, setActivity] = useState('');
  const ctl = useRef<AbortController | null>(null);
  // the stream's progress lands here on every line; the 1 s tick shows it, so a fast stream never re-renders per line
  const progress = useRef<{ round: Round; p: StreamProgress | null }>({ round: 'drawing', p: null });
  useEffect(() => () => ctl.current?.abort(), []);
  useEffect(() => {
    if (!running) return undefined;
    const started = Date.now();
    setSeconds(0);
    setActivity(activityOf(progress.current.round, progress.current.p));
    const tick = setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000));
      setActivity(activityOf(progress.current.round, progress.current.p));
    }, 1000);
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
    // a round is given up after a silence, a press after its total (2026-10-12); Cancel (c) aborts the round in flight
    let timedOut: 'silence' | 'total' | null = null, silence: ReturnType<typeof setTimeout> | undefined;
    let round: AbortController | null = null;
    const total = setTimeout(() => { timedOut = 'total'; round?.abort(); }, AI_TOTAL_MS);
    c.signal.addEventListener('abort', () => round?.abort());
    const quiet = () => {
      clearTimeout(silence);
      silence = setTimeout(() => { timedOut = 'silence'; round?.abort(); }, AI_SILENCE_MS);
    };
    const timeoutText = () => (timedOut === 'total' ? `no drawing in ${AI_TOTAL_MS / 60_000} min` : `no word from the model for ${AI_SILENCE_MS / 1000} s`);
    /** One answer, given up when the model falls silent. */
    let model = '';
    const ask = async (messages: ChatMessage[], name: Round) => {
      if (timedOut === 'total') throw new DrawingError('cancelled');
      round = new AbortController();
      progress.current = { round: name, p: null };
      quiet();
      try {
        return await requestDrawing(model, messages, round.signal, fetchFn, (p) => { progress.current = { round: name, p }; quiet(); });
      } finally {
        clearTimeout(silence);
      }
    };
    try {
      model = await modelOf(c.signal, fetchFn);
      log(`AI drawing: asking ${model} to redraw the design; it is applied only if every relation between the steps stays the same`);
      let messages = first;
      let text = await ask(messages, 'drawing');
      let out = judgeDrawing(edited, draft, snapshot, text);
      if (!out.ok) {
        log(`AI drawing: the answer was refused (${out.reason}); asking ${model} once to correct it`);
        messages = correctionMessages(first, text, out.reason);
        text = await ask(messages, 'correcting');
        out = judgeDrawing(edited, draft, snapshot, text);
      }
      // the refinement round (2026-10-12): what a second press of the wand did by hand
      let left = out.ok ? remainingProblemsOf(edited, out.draft) : [];
      if (out.ok && left.length > 0) {
        log(`AI drawing: ${left.length} problem${left.length === 1 ? '' : 's'} left (${left.slice(0, 3).join('; ')}${left.length > 3 ? '; …' : ''}); asking ${model} once to refine it`);
        try {
          const again = await ask(refinementMessages(messages, text, graphOf(edited, out.draft), left), 'refining');
          const refined = judgeDrawing(edited, out.draft, snapshot, again);
          if (!refined.ok) log(`AI drawing: the refinement was refused (${refined.reason}); keeping the first drawing`);
          else {
            const after = remainingProblemsOf(edited, refined.draft);
            if (after.length <= left.length) {
              log(`AI drawing: refined, problems ${left.length} → ${after.length}`);
              out = refined;
              left = after;
            } else log(`AI drawing: the refinement left more problems (${left.length} → ${after.length}); keeping the first drawing`);
          }
        } catch (e) {
          if (c.signal.aborted || !(e instanceof DrawingError)) throw e;
          log(`AI drawing: the refinement failed (${e.message === 'cancelled' ? timeoutText() : e.message}); keeping the first drawing`);
        }
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
      const moved = movedBlocksOf(edited, draft, out.draft);
      store.dispatch({ type: 'drawing', workflowId, on: false });
      store.dispatch({ type: 'design', workflowId, draft: out.draft });
      log(`AI drawing applied: ${moved} block${moved === 1 ? '' : 's'} moved, ${out.rerouted} wire${out.rerouted === 1 ? '' : 's'} routed; crossings ${out.crossings}, short circuits ${out.shorted}, problems left ${left.length}`);
    } catch (e) {
      const why = e instanceof DrawingError ? e.message : 'unexpected error';
      if (why === 'cancelled') log(timedOut && !c.signal.aborted ? `AI drawing failed: ${timeoutText()}` : 'AI drawing cancelled', timedOut && !c.signal.aborted ? 'error' : 'info');
      else log(why.startsWith('AI drawing') ? why : `AI drawing failed: ${why}`, 'error');
    } finally {
      clearTimeout(silence);
      clearTimeout(total);
      ctl.current = null;
      store.dispatch({ type: 'drawing', workflowId, on: false });
      setRunning(false);
    }
  }, [store, workflowId, log, fetchFn]);

  const cancel = useCallback(() => ctl.current?.abort(), []);
  return { running, seconds, activity, draw, cancel };
}

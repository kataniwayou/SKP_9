import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AI_SILENCE_MS, AI_TOTAL_MS, correctionMessages, DrawingError, firstMessages, judgeDrawing, modelOf, placed, problemsOf,
  refinementMessages, requestDrawing, scopeOf, type ChatMessage, type Judged, type StreamProgress,
} from '../ai/drawing';
import type { Vec } from '../molecule/layout';
import { canvasBridge } from '../molecule/bridge';
import { useHighlights, type Highlights } from './highlights';
import { Spinner } from './Spinner';
import { useWorkspace, type Workspace } from './workspace';

type Round = 'drawing' | 'correcting' | 'refining';

/** The Cancel button's word on the answer arriving: "thinking 12k", "writing 2k", or the round's name (as SKP Studio's). */
export function activityOf(round: Round, p: StreamProgress | null): string {
  const k = (n: number) => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`);
  const what = !p || (p.thinking === 0 && p.writing === 0) ? 'waiting' : p.writing > 0 ? `writing ${k(p.writing)}` : `thinking ${k(p.thinking)}`;
  return round === 'drawing' ? what : `${round} · ${what}`;
}

/**
 * The AI drawing's wand on the main menu strip, beside the Workflows filter (the user, 2026-10-17: "based on SKP Studio …
 * only for the selected workflows"): the model lays out the picked workflows by the spine rules. As SKP Studio's: the
 * answer is streamed; a refused answer gets one correction round, a drawing with problems left one refinement round,
 * kept when it leaves no more; a round is given up after 60 s of silence, a press after 15 min; Cancel stops it. The
 * drawing glides in and is kept in this browser like a move by hand; the arrow beside the wand puts the last one back.
 */
export function Wand({ workspace, highlights, fetchFn }: { workspace: Workspace; highlights: Highlights; fetchFn?: typeof fetch }) {
  const picked = useHighlights(highlights);
  const molecule = useWorkspace(workspace, (s) => s.molecule);
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [activity, setActivity] = useState('');
  const [undo, setUndo] = useState<{ places: Map<string, Vec>; label: string } | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const progress = useRef<{ round: Round; p: StreamProgress | null }>({ round: 'drawing', p: null });
  useEffect(() => () => ctl.current?.abort(), []);
  useEffect(() => {
    if (!running) return undefined;
    const started = Date.now();
    setSeconds(0);
    setActivity(activityOf(progress.current.round, progress.current.p));
    const tick = setInterval(() => { setSeconds(Math.floor((Date.now() - started) / 1000)); setActivity(activityOf(progress.current.round, progress.current.p)); }, 1000);
    return () => clearInterval(tick);
  }, [running]);

  const workflows = molecule ? picked.filter((k) => molecule.atoms.get(k)?.type === 'wf') : [];
  const blocked = !molecule ? 'Reading the project…' : workflows.length === 0 ? 'Pick the workflows to draw in the Workflows filter first' : null;
  const names = molecule ? workflows.map((k) => molecule.atoms.get(k)!.name) : [];
  const label = names.length === 1 ? names[0]! : `${names.length} workflows`;

  const draw = useCallback(async () => {
    const m = workspace.get().molecule;
    const canvas = canvasBridge.get();
    if (!m || ctl.current) return;
    if (!canvas) { workspace.note('AI drawing is not available: the canvas is not shown', 'refused'); return; }
    const scope = scopeOf(m, highlights.get());
    if (scope.workflows.length === 0) { workspace.note('AI drawing: pick the workflows to draw in the Workflows filter first', 'refused'); return; }
    const what = scope.workflows.map((k) => m.atoms.get(k)!.name).join(', ');
    const c = new AbortController();
    ctl.current = c;
    setRunning(true);
    let timedOut: 'silence' | 'total' | null = null, silence: ReturnType<typeof setTimeout> | undefined, round: AbortController | null = null;
    const total = setTimeout(() => { timedOut = 'total'; round?.abort(); }, AI_TOTAL_MS);
    c.signal.addEventListener('abort', () => round?.abort());
    const quiet = () => { clearTimeout(silence); silence = setTimeout(() => { timedOut = 'silence'; round?.abort(); }, AI_SILENCE_MS); };
    const timeoutText = () => (timedOut === 'total' ? `no drawing in ${AI_TOTAL_MS / 60_000} min` : `no word from the model for ${AI_SILENCE_MS / 1000} s`);
    let model = '';
    const ask = async (messages: ChatMessage[], name: Round) => {
      if (timedOut === 'total') throw new DrawingError('cancelled');
      round = new AbortController();
      progress.current = { round: name, p: null };
      quiet();
      try { return await requestDrawing(model, messages, round.signal, fetchFn, (p) => { progress.current = { round: name, p }; quiet(); }); }
      finally { clearTimeout(silence); }
    };
    try {
      model = await modelOf(c.signal, fetchFn);
      workspace.note(`AI drawing: asking ${model} to lay out ${what} by the spine rules (${scope.keys.length} atoms); only their places change`);
      const first = firstMessages(m, scope);
      let messages = first;
      let text = await ask(messages, 'drawing');
      let out: Judged = judgeDrawing(scope, text);
      if (!out.ok) {
        workspace.note(`AI drawing: the answer was refused (${out.reason}); asking ${model} once to correct it`);
        messages = correctionMessages(first, text, out.reason);
        text = await ask(messages, 'correcting');
        out = judgeDrawing(scope, text);
      }
      let left = out.ok ? problemsOf(scope, out.places) : [];
      if (out.ok && left.length > 0) {
        workspace.note(`AI drawing: ${left.length} problem${left.length === 1 ? '' : 's'} left (${left.join('; ').slice(0, 220)}); asking ${model} once to refine it`);
        try {
          const refined = judgeDrawing(scope, await ask(refinementMessages(messages, text, left), 'refining'));
          if (!refined.ok) workspace.note(`AI drawing: the refinement was refused (${refined.reason}); keeping the first drawing`);
          else {
            const after = problemsOf(scope, refined.places);
            const count = (ps: string[]) => ps.reduce((n, p) => n + (Number(/^(\d+)/.exec(p)?.[1]) || 1), 0);
            if (count(after) <= count(left)) { workspace.note(`AI drawing: refined, problems ${count(left)} → ${count(after)}`); out = refined; left = after; }
            else workspace.note(`AI drawing: the refinement left more problems (${count(left)} → ${count(after)}); keeping the first drawing`);
          }
        } catch (e) {
          if (c.signal.aborted || !(e instanceof DrawingError)) throw e;
          workspace.note(`AI drawing: the refinement failed (${e.message === 'cancelled' ? timeoutText() : e.message}); keeping the first drawing`);
        }
      }
      if (!out.ok) { workspace.note(`AI drawing not applied: ${out.reason}`, 'refused'); return; }
      if (workspace.get().molecule !== m) { workspace.note('AI drawing not applied: the project changed while the model was drawing', 'refused'); return; }
      const now = canvasBridge.get();
      if (!now) { workspace.note('AI drawing not applied: the canvas is not shown', 'refused'); return; }
      const before = now.positions();
      const places = placed(scope, out.places, before);
      setUndo({ places: new Map(scope.keys.flatMap((k) => (before.has(k) ? [[k, before.get(k)!] as const] : []))), label: what });
      now.place(places);
      workspace.note(`AI drawing applied: ${what} laid out by the spine rules, ${places.size} atoms placed${left.length ? `; left: ${left.join('; ').slice(0, 200)}` : ''}. The arrow beside the wand puts the places back.`);
    } catch (e) {
      const why = e instanceof DrawingError ? e.message : 'unexpected error';
      if (why === 'cancelled') workspace.note(timedOut && !c.signal.aborted ? `AI drawing failed: ${timeoutText()}` : 'AI drawing cancelled', timedOut && !c.signal.aborted ? 'refused' : 'info');
      else workspace.note(why.startsWith('AI drawing') ? why : `AI drawing failed: ${why}`, 'refused');
    } finally {
      clearTimeout(silence); clearTimeout(total);
      ctl.current = null;
      setRunning(false);
    }
  }, [workspace, highlights, fetchFn]);

  const putBack = () => {
    const canvas = canvasBridge.get();
    if (!undo || !canvas) return;
    canvas.place(undo.places);
    workspace.note(`AI drawing taken back: ${undo.label} back where it stood`);
    setUndo(null);
  };

  if (running) {
    return (
      <button type="button" className="wd-b busy" aria-busy aria-label="AI drawing: cancel" onClick={() => ctl.current?.abort()} data-tip="The model is drawing; click to cancel">
        <Spinner /> Cancel · {seconds} s{activity ? ` · ${activity}` : ''}
      </button>
    );
  }
  return (
    <span className="wd">
      <button type="button" className={blocked ? 'wd-b off' : 'wd-b'} aria-disabled={blocked !== null} aria-label={blocked ? `AI drawing: ${blocked}` : `AI drawing: lay out ${label}`}
        data-tip={blocked ?? `AI drawing: lay out ${label} by the spine rules (only the atoms' places change; nothing is written to BaseApi)`}
        onClick={() => { if (!blocked) void draw(); }}>
        <WandIcon />
      </button>
      {undo && (
        <button type="button" className="wd-b" aria-label="Take back the AI drawing" data-tip={`Take back the AI drawing of ${undo.label}`} onClick={putBack}>↶</button>
      )}
    </span>
  );
}

/** SKP Studio's magic wand (2026-10-11): a small stroke icon in the strip's own colour. */
function WandIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ verticalAlign: '-2px' }}>
      <path d="M2.5 13.5 10 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M10 6l1.6-1.6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="M12.5 1.2v2.2M11.4 2.3h2.2M14.3 6.1v1.6M13.5 6.9h1.6M7.2 1.6v1.4M6.5 2.3h1.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none" />
    </svg>
  );
}

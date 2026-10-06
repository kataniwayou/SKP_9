# SKP Studio 3c: Node Art and Live States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plan-2 block drawings with the locked node art (step, processor, workflow hub, cache, lines, legend) and drive its live states from BaseApi: processor health from `/processors/liveness`, the started hub and flowing pulses from `/orchestration/live`.

**Architecture:** The geometry stays the grid of spec §5.1 (step 224 × 160, hub r 96), except the cache, which becomes 160 × 160. Each node and edge component is rewritten as flat inline SVG in the locked style. Colours, glows and motion live in a new `canvas/art.css`, keyed on classes and CSS variables (`--nc`, `--nh`). The live state is not part of the document. `DocumentPanel` polls it beside the existing live status and hands it to the canvas through a React context (`LiveArtContext`). So a 5 s poll re-renders only the components that read it: it never rebuilds the nodes, and never moves or refits anything.

**Tech Stack:** React 19.3, @xyflow/react 12.12, TypeScript, Vitest 5 + Testing Library (jsdom), Playwright e2e against the live BaseApi.

**Spec:** `docs/superpowers/specs/2026-10-05-skp-studio-design.md`. This plan implements §5.1 (node art, the locked block), §5.3 (colours, legend) and §10 slice 3c.

**Art references** (git-ignored, under `.superpowers/brainstorm/385-1791189446/content/`):
- `skp-studio-node-art-final.html`: the locked gallery ("G"). It is the authority on the look.
- `skp-studio-dock-v50.html`: mockup v50 ("B"). It is the gallery redrawn at this grid's sizes.
- `v49-v50-diff.md`: a line-referenced report of every v50 value.

The plan copies every number it needs, so an executor never has to open these files. The final visual check (Task 9) compares the result with them.

## Decisions this plan makes (please confirm at review)

1. **Geometry comes from v50 and the details from the gallery** (spec: "where they differ, the gallery wins"). v50 is the gallery redrawn to the sizes the spec mandates, so sizes, positions and stroke widths come from v50. Where the two differ in a way that is not just scale, the gallery wins:
   - the **processor ring** is the gallery's HUD ring (dotted ring, faint ring, segmented spinner), scaled × 0.58 to the 176 × 80 panel;
   - a **socket** sits on the frame edge where each wire meets the step;
   - **broken** wires are dashed `6 4`;
   - **pulses** are staggered by −0.41 s per wire;
   - the hub's core is a **radial glow** in its state colour;
   - the hub's **pill** carries the cron *and* the state (`⏱ 0 * * * * *  ● started`). It is 240 wide (the gallery's 200 × the hub scale 1.2), centred under the hub.
2. **Opening size of long graphs: no change in 3c.** You raised it earlier, and after the resize fix (`8978bd0`) you said "working well". The document keeps opening at Fit. If you still want a readable opening zoom or a more compact layout, say so at review and it becomes its own task.
3. **No junction entry in the legend yet.** The legend's icons must match the canvas (§5.1), and junctions are drawn only from plan 7. The square-via icon arrives with them.
4. **Cache name size:** drawn and measured at 12.5 px. v50 measured at 12.5 but drew at 13, which could make a fitted name overflow.
5. **Base stroke widths live in CSS classes, not inline styles.** v50 wrote widths inline, which silently beat its own hover and selection rules. Here a selected step really does draw the 2 px cyan frame.
6. **The cache drops its item count.** The locked art shows the root on a plate and no "N items".
7. **The hub's back glow takes no clicks** (`pointer-events: none`). It reaches 124 px from the centre, past the hub's 96 px box, and would otherwise grab clicks meant for wires and the cache.
8. **Liveness is polled per open document**, every 5 s, beside the live status and with the same rules: only while that tab is visible, never while loading or failed. A hidden or loading document shows every processor *undetermined* and the hub *not started*.

## Global Constraints

- **Location.** The app lives in `src/WorkflowStudio`. Every command runs **from `src/WorkflowStudio`** unless it says otherwise; **commit steps run from the repository root**.
- **Shells.** Run `npm run …` and `npm test` **in PowerShell**: in Git Bash `npm run` prints nothing and exits 1. `npx …` works in either shell.
- **Pinned versions.** No dependency changes in this plan. `.npmrc` keeps `legacy-peer-deps=true`.
- **Same origin only**, relative `/api/v1/` URLs. In dev, Vite proxies `/api` to `http://localhost:18080`.
- **Read-only slice.** Only `GET`s plus the existing validate `POST` dry run. Save, Start and Stop stay disabled. Nothing on the canvas is draggable or connectable.
- **`model/` and `layout/` hold no React and no I/O.** `dock/` imports nothing from `canvas/`, `panels/`, `app/` or `store/`.
- **Rendering rules (spec §6.3).**
  - Documents keep `renderer: 'always'`.
  - Code inside a panel uses its own document, never the global one.
  - Every SVG id a node or edge defines (masks, filters, gradients) is made unique with `useId`, so two documents (or a pop-out) never share one.
  - The shared defs (`SvgDefs`) are rendered once per window.
  - Overlay z-index values come only from the `--z-*` tokens.
- **Colours (spec §5.3, locked art).**
  - Structure (frames, panel, cache, hub outer rings): `#E8F1FF`.
  - Healthy and started: `#22C55E`. Unhealthy: `#EF4444`. Undetermined and not started: `#94A3B8`.
  - Warning glyph: `#F5B841`.
  - Entry conditions, unchanged: C `#2DD4BF`, F `#FF7A66`, X `#F5B841`, A `#B392F0`, N `#F472B6`.
  - Selection: `--accent` `#7DD3FC`.
  - The mockup's colour-scheme switch does **not** ship.
- **Health and run state (spec §5.1).**
  - Health: `live: true` is healthy, `live: false` is unhealthy. Anything else is undetermined: a failed or missing poll, a malformed body, or a processor the list does not name.
  - Started means the workflow's id is in `GET /orchestration/live`. A failed live poll looks *not started*, and the capsule says *status unknown*.
  - Pulses run only while started, and never on a broken wire.
- **Reduced motion:** no pulses, no spinning, no blinking, full opacity.
- **Plan 2 and 3a keep working.**
  - The per-document canvas key, the font preload (every measured face loaded before a fitter is made) and the selection classes `studio-sel` / `studio-die-sel` on React Flow's node wrapper stay.
  - The class `w` on a wire's path stays (e2e reads it).
  - The `.docpanel.bg` rule must keep hiding a background document (its e2e must stay green).
- **No backend code changes.**
- **Do not touch the Toolbox** (user instruction, 2026-10-06: it has modifications coming). That means no change to `src/panels/` (`PaneNote.tsx`, `panes.test.tsx`), to the Toolbox's dock wiring (`src/dock/ids.ts`, `src/dock/windowActions.ts` and their tests) or to `src/App.tsx`. The new art is not drawn in the Toolbox either; that is plan 6.
- **Machine notes.**
  - Windows; the Bash tool is Git Bash. Bash heredocs containing apostrophes or backticks fail: write files with the Write tool (or Edit).
  - Stage only the files a task names, by name (never `git add -A`).
  - Never touch `.wf-restore.json`, `tools/simulate-approved-feed.py`, `tools/simulate-unapproved-feed.py`, `.playwright-mcp/` or `docs/HANDOVER-*.md`.
  - The kind cluster is named `desktop`.
- **Commits** end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (give it as a second `-m`).
- **Test commands.**
  - Unit tests `npm test` (`vitest run`); a focused run `npx vitest run <path>`.
  - Types `npm run typecheck`; build `npm run build`.
  - End-to-end `npm run e2e` (needs BaseApi on `localhost:18080`; check with `..\..\k8s\port-forward-realstack.ps1 -Status`).
  - A run that collects 0 tests is a failure.
- **Clean output.** A React warning in test output (`act(...)`, a missing `key`, an unknown DOM property) is a defect to fix, not noise.

## Review Focus

These failure modes are the most likely to bite someone using the art. Each one is pinned by a test in the task that owns the code:

1. **No answer is never a verdict.** A liveness poll that fails, returns a non-array, or names entries without a string `processorId` and a boolean `live`, and a processor missing from the list: each must show *undetermined*, never healthy or unhealthy, and never throw. Task 2, `api/liveness.test.ts`.
2. **GUID case.** The graph's processor ids and the liveness list's ids may differ in letter case; they must still match. Task 2, `api/liveness.test.ts`.
3. **A failed live poll stops the motion.** When `/orchestration/live` fails, the hub looks not started and no wire pulses, while the capsule says *status unknown*. Task 4 (`WorkflowCanvas.test.tsx`) and Task 6 (`CableEdge.test.tsx`).
4. **Several broken wires in one window.** Each wire's gap mask has its own id, so one wire's gap never cuts another, including across two documents. Task 6, `CableEdge.test.tsx`.
5. **Long text never leaves its shape.** A cron, cache name, root or schema name that is too long is wrapped or cut with an ellipsis and keeps its full text in a tooltip, and the root plate is never wider than 128. Tasks 3, 4 and 5, `toFlow.test.ts`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/layout/geometry.ts` | Cache size 160 × 160 and the cache stack pitch | 1 |
| `src/layout/placement.ts` | Caches centred under the hub (x − 80), 192 apart | 1 |
| `src/api/client.ts` | `listLiveness()` | 2 |
| `src/api/liveness.ts` (new) | `Health`, `healthOf(result)`: a defensive read of `/processors/liveness` | 2 |
| `src/app/panelHooks.ts` | One `usePoll`; `useLiveStatus` and the new `useLiveness` on top of it | 2 |
| `src/canvas/liveArt.tsx` (new) | `LiveArt`, `LiveArtContext`, `useLiveArt()` | 2 |
| `src/app/DocumentPanel.tsx` | Polls liveness, builds the `LiveArt`, passes it to the canvas | 2 |
| `src/canvas/WorkflowCanvas.tsx` | `live` prop provides `LiveArtContext` | 2 |
| `src/canvas/tokens.css` | Structure, health and warning colour tokens | 3 |
| `src/canvas/art.css` (new) | Every node-art style: base classes, step, processor, hub, cache, wires, legend | 3–7 |
| `src/main.tsx` | Imports `art.css` | 3 |
| `src/canvas/SvgDefs.tsx` | `nxCap` gradient (Task 3); dead defs removed (Task 7) | 3, 7 |
| `src/canvas/nodes/nxShapes.ts` (new) | Frame paths, `closingDash`, `hexPoints` | 3 |
| `src/canvas/nodes/Chip.tsx` | The processor panel with the health ring and gear chip | 3 |
| `src/canvas/nodes/StepNode.tsx` | The notched HUD step | 3 |
| `src/canvas/fitText.ts` | Fonts the art measures with | 3, 4, 5 |
| `src/canvas/toFlow.ts` | Data each node and edge needs | 3–6 |
| `src/canvas/nodes/WorkflowNode.tsx` | The hub dial with its pill | 4 |
| `src/canvas/nodes/CacheNode.tsx` | The K5a square cache | 5 |
| `src/canvas/edges/CableEdge.tsx` | Trace, chevron, source ring, broken gap, pulse | 6 |
| `src/canvas/Legend.tsx` | Icons that match the canvas | 7 |
| `src/canvas/selection.ts` | `withSelection` merges an existing `className` | 7 |
| `src/canvas/canvas.css` | Loses the plan-2 block and wire rules as each task replaces them | 3–7 |
| `e2e/studio.ts`, `e2e/art.spec.ts` (new), `e2e/dock.spec.ts` | Live-state e2e; pop-out defs check | 7, 8 |

---

### Task 1: The 160 × 160 cache in the layout

The locked cache is a square the height of a step. Placement centres it under the hub (x = hub cx − 80) and stacks caches 192 apart (160 + one 32 px cell). Routing boxes and the tether already read `CACHE_W` / `CACHE_H`. The old cache drawing stays until Task 5 (it is drawn 192 × 64 inside the new 160 × 160 box meanwhile).

**Files:**
- Modify: `src/layout/geometry.ts`
- Modify: `src/layout/placement.ts:3` and `:80`
- Test: `src/layout/placement.test.ts:70-80`, `src/layout/wires.test.ts:102-110`, `src/canvas/toFlow.test.ts` (first test)

**Interfaces:**
- Produces: `CACHE_W = 160`, `CACHE_H = 160`, `CACHE_PITCH = 192` from `layout/geometry.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/layout/placement.test.ts`, replace the two expectations for `c1` and `c2` in `it('stacks caches under the sphere unless they have a stored position', …)`:

```ts
    expect(p.caches.get('c1')).toEqual({ x: cx - 80, y: cy + 96 + 64 });
    expect(p.caches.get('c2')).toEqual({ x: cx - 80, y: cy + 96 + 64 + 192 });
```

In `src/layout/wires.test.ts`, replace the `describe('tetherPoints', …)` block:

```ts
describe('tetherPoints', () => {
  it('drops straight from the sphere bottom to a cache centred under it', () => {
    expect(tetherPoints({ cx: 128, cy: 128 }, { x: 48, y: 288 })).toEqual([[128, 224], [128, 288]]);
  });

  it('bends at right angles to a cache that was moved aside', () => {
    expect(tetherPoints({ cx: 128, cy: 128 }, { x: 320, y: 400 })).toEqual([[128, 224], [128, 312], [400, 312], [400, 400]]);
  });
});
```

In `src/canvas/toFlow.test.ts`, first test, replace its last line with:

```ts
    const cache = nodes.find((n) => n.id === cacheNodeId('c1'))!;
    expect(cache.position).toEqual({ x: 32, y: 288 });
    expect([cache.width, cache.height]).toEqual([160, 160]);
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/layout/placement.test.ts src/layout/wires.test.ts src/canvas/toFlow.test.ts`
Expected: FAIL. Placement gives `x: cx - 96`, the tether reaches x 128 + … for the old width, and the cache node is 192 × 64.

- [ ] **Step 3: Change the geometry**

In `src/layout/geometry.ts`, replace the two cache lines:

```ts
/** A cache is a 5 × 5-cell square, a step's height (locked art, spec §5.1). */
export const CACHE_W = 160;
export const CACHE_H = 160;
/** Caches stack under the hub one cache plus one cell apart. */
export const CACHE_PITCH = CACHE_H + CELL;
```

In `src/layout/placement.ts`, change the import on line 3 to:

```ts
import { CACHE_PITCH, CACHE_W, CELL, COLUMN_PITCH, PMID, SPHERE_R, STEP_H, STEP_W, snap, type Point } from './geometry';
```

and the placement of a cache without a stored position (line 80) to:

```ts
    else caches.set(id, { x: sphere.cx - CACHE_W / 2, y: sphere.cy + SPHERE_R + GAP + k++ * CACHE_PITCH });
```

If `CACHE_H` is no longer used in `placement.ts`, it is already gone from the import above.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run src/layout src/canvas/toFlow.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run (PowerShell): `npm test; npm run typecheck; npm run build`
Expected: all pass, no React warnings.

```bash
git add src/WorkflowStudio/src/layout/geometry.ts src/WorkflowStudio/src/layout/placement.ts src/WorkflowStudio/src/layout/placement.test.ts src/WorkflowStudio/src/layout/wires.test.ts src/WorkflowStudio/src/canvas/toFlow.test.ts
git commit -m "feat(studio): caches are 160 x 160, centred under the hub and stacked 192 apart" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Liveness and the live state the art reads

**Files:**
- Modify: `src/api/client.ts`
- Create: `src/api/liveness.ts`, `src/api/liveness.test.ts`
- Modify: `src/app/panelHooks.ts`
- Create: `src/canvas/liveArt.tsx`
- Modify: `src/canvas/WorkflowCanvas.tsx`
- Modify: `src/app/DocumentPanel.tsx`
- Test: `src/app/DocumentPanel.test.tsx`

**Interfaces:**
- Produces:
  - `StudioApi.listLiveness(): Promise<ApiResult<unknown>>`
  - `type Health = 'healthy' | 'unhealthy' | 'undetermined'`, `type HealthOf = (processorId: string) => Health`, `NO_VERDICT: HealthOf`, `healthOf(result: ApiResult<unknown> | null): HealthOf` (all from `api/liveness.ts`)
  - `useLiveness(api: StudioApi, visible: boolean): ApiResult<unknown> | null` (from `app/panelHooks.ts`)
  - `interface LiveArt { started: boolean; health: HealthOf }`, `NO_LIVE_ART`, `LiveArtContext`, `useLiveArt(): LiveArt` (from `canvas/liveArt.tsx`)
  - `WorkflowCanvas` prop `live?: LiveArt` (default `NO_LIVE_ART`)

- [ ] **Step 1: Write the failing liveness tests**

Create `src/api/liveness.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ApiResult } from './client';
import { healthOf } from './liveness';

const ok = (value: unknown): ApiResult<unknown> => ({ ok: true, value });

describe('healthOf', () => {
  it('reads live as healthy and not live as unhealthy', () => {
    const health = healthOf(ok([{ processorId: 'p1', live: true }, { processorId: 'p2', live: false }]));
    expect([health('p1'), health('p2')]).toEqual(['healthy', 'unhealthy']);
  });

  it('matches ids without case (review focus 2)', () => {
    const health = healthOf(ok([{ processorId: 'F361E170-C899-43D1-9A0E-4D30FF2CAD87', live: true }]));
    expect(health('f361e170-c899-43d1-9a0e-4d30ff2cad87')).toBe('healthy');
  });

  // Review focus 1: no answer is never a verdict.
  it.each([
    ['no poll yet', null],
    ['a failed poll', { ok: false, error: { kind: 'http', status: 500, detail: 'Redis down' } }],
    ['a body that is not an array', ok({ p1: true })],
  ] as const)('is undetermined for every processor after %s', (_label, result) => {
    expect(healthOf(result as ApiResult<unknown> | null)('p1')).toBe('undetermined');
  });

  it('skips malformed entries and leaves unnamed processors undetermined', () => {
    const health = healthOf(ok([null, 'p1', { processorId: 7, live: true }, { processorId: 'p1', live: 'yes' }, { processorId: 'p2', live: true }]));
    expect([health('p1'), health('p2'), health('p3'), health('')]).toEqual(['undetermined', 'healthy', 'undetermined', 'undetermined']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/api/liveness.test.ts`
Expected: FAIL ("Failed to resolve import ./liveness").

- [ ] **Step 3: Write `api/liveness.ts` and the client call**

Create `src/api/liveness.ts`:

```ts
import type { ApiResult } from './client';

/** What a processor's image shows (spec §5.1): green and spinning, red and still, grey and blinking. */
export type Health = 'healthy' | 'unhealthy' | 'undetermined';

/** A processor's health by id; ids compare without case. */
export type HealthOf = (processorId: string) => Health;

/** No data: every processor is undetermined. */
export const NO_VERDICT: HealthOf = () => 'undetermined';

/**
 * Reads `GET /processors/liveness` defensively (spec §5.1): `live: true` is healthy, `live: false`
 * unhealthy. No poll yet, a failed poll, a body that is not an array, an entry without a string
 * `processorId` and a boolean `live`, and a processor the list does not name are all undetermined:
 * no answer is never a verdict.
 */
export function healthOf(result: ApiResult<unknown> | null): HealthOf {
  if (result === null || !result.ok || !Array.isArray(result.value)) return NO_VERDICT;
  const verdicts = new Map<string, Health>();
  for (const entry of result.value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { processorId, live } = entry as { processorId?: unknown; live?: unknown };
    if (typeof processorId !== 'string' || typeof live !== 'boolean') continue;
    verdicts.set(processorId.toLowerCase(), live ? 'healthy' : 'unhealthy');
  }
  return (processorId) => verdicts.get(processorId.toLowerCase()) ?? 'undetermined';
}
```

In `src/api/client.ts`, add to `interface StudioApi`, after `listLive()`:

```ts
  /**
   * Every processor's liveness (`GET /processors/liveness`), judged as the start gate judges.
   * Typed `unknown` like listLive: api/liveness.ts reads it defensively.
   */
  listLiveness(): Promise<ApiResult<unknown>>;
```

and to the object `createApi` returns, after `listLive`:

```ts
    listLiveness: () => get<unknown>('/processors/liveness'),
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/api/liveness.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing polling and panel tests**

In `src/app/DocumentPanel.test.tsx`:

Change the import from `./panelHooks` to:

```ts
import { LIVE_POLL_MS, useLiveness, useLiveStatus, useOwnerDocument, usePanelVisible, type PanelLike } from './panelHooks';
```

Add this `describe` after the `useLiveStatus` describe:

```ts
describe('useLiveness', () => {
  it('polls every 5 s while visible, returns the last answer, and null while hidden', async () => {
    vi.useFakeTimers();
    const answer = { ok: true, value: [{ processorId: 'p1', live: true }] };
    const listLiveness = vi.fn().mockResolvedValue(answer);
    const api = { listLiveness } as unknown as StudioApi;
    const { result, rerender } = renderHook(({ visible }) => useLiveness(api, visible), { initialProps: { visible: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toEqual(answer);
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * LIVE_POLL_MS); });
    expect(listLiveness).toHaveBeenCalledTimes(3);

    rerender({ visible: false });
    expect(result.current).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLiveness).toHaveBeenCalledTimes(3);
  });

  it('turns a thrown call into a network failure', async () => {
    const api = { listLiveness: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as StudioApi;
    const { result } = renderHook(() => useLiveness(api, true));
    await waitFor(() => expect(result.current).toEqual({ ok: false, error: { kind: 'network', message: 'Error: boom' } }));
  });
});
```

In `describe('DocumentPanel', …)`, replace `setup` with a version whose api also answers `listLiveness`:

```ts
  async function setup(listLive = vi.fn().mockResolvedValue({ ok: true, value: [] }), listLiveness = vi.fn().mockResolvedValue({ ok: true, value: [] })) {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    const fake = fakePanel();
    const api = { listLive, listLiveness } as unknown as StudioApi;
    render(<StudioStoreProvider value={store}><div style={{ width: 1200, height: 800 }}><DocumentPanel api={api} workflowId="wf1" panel={fake.panel} /></div></StudioStoreProvider>);
    return { store, fake, listLive, listLiveness };
  }
```

and add these tests to that describe:

```ts
  it('polls processor liveness beside the live status, and neither while loading or failed', async () => {
    vi.useFakeTimers();
    const { store, listLive, listLiveness } = await setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLiveness).not.toHaveBeenCalled();

    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listLiveness).toHaveBeenCalledTimes(1);
    expect(listLive).toHaveBeenCalledTimes(1);
  });

  it('stops polling liveness when its tab is hidden', async () => {
    vi.useFakeTimers();
    const { store, fake, listLiveness } = await setup();
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => fake.show(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLiveness).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 6: Run them to see them fail**

Run: `npx vitest run src/app/DocumentPanel.test.tsx`
Expected: FAIL (`useLiveness` is not exported; `listLiveness` is never called).

- [ ] **Step 7: One poll, two readers**

In `src/app/panelHooks.ts`, replace everything from `export const LIVE_POLL_MS = 5000;` to the end of the file with:

```ts
export const LIVE_POLL_MS = 5000;

type Call = (api: StudioApi) => Promise<ApiResult<unknown>>;
// module-level, so the polling effect sees the same function every render
const LIVE: Call = (api) => api.listLive();
const LIVENESS: Call = (api) => api.listLiveness();

/**
 * Calls `call(api)` now and every 5 s while `visible`, and returns its last answer: null while
 * hidden and before the first answer. A thrown call is a network failure. An answer that lands
 * after the poll stopped (hidden, unmounted, restarted) is dropped.
 */
function usePoll(api: StudioApi, call: Call, visible: boolean): ApiResult<unknown> | null {
  const [result, setResult] = useState<ApiResult<unknown> | null>(null);
  useEffect(() => {
    if (!visible) { setResult(null); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const answer = await Promise.resolve()
        .then(() => call(api))
        .catch((e: unknown): ApiResult<unknown> => ({ ok: false, error: { kind: 'network', message: String(e) } }));
      if (!live) return;
      setResult(answer);
      timer = setTimeout(() => void poll(), LIVE_POLL_MS);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [api, call, visible]);
  return result;
}

/** Polls `GET /orchestration/live` every 5 s, only while `visible` (spec §6.1). Starts as "checking". */
export function useLiveStatus(api: StudioApi, workflowId: string, visible: boolean): LiveStatus {
  const result = usePoll(api, LIVE, visible);
  return result === null ? 'checking' : liveStatusOf(result, workflowId);
}

/** Polls `GET /processors/liveness` with the live status (spec §5.1): the same 5 s, the same visibility. */
export function useLiveness(api: StudioApi, visible: boolean): ApiResult<unknown> | null {
  return usePoll(api, LIVENESS, visible);
}
```

and change the imports at the top of `panelHooks.ts` to:

```ts
import { useEffect, useState } from 'react';
import type { DockviewPanelApi } from 'dockview-react';
import type { ApiResult, StudioApi } from '../api/client';
import { liveStatusOf, type LiveStatus } from '../api/liveStatus';
```

- [ ] **Step 8: The context and its wiring**

Create `src/canvas/liveArt.tsx`:

```tsx
import { createContext, useContext } from 'react';
import { NO_VERDICT, type HealthOf } from '../api/liveness';

/** What the drawing shows of the running system (spec §5.1): the hub's run state and each processor's health. */
export interface LiveArt {
  /** The workflow's id is in `GET /orchestration/live`: the hub turns green and intact wires pulse. */
  started: boolean;
  health: HealthOf;
}

/** No live data (a test, a document still loading, a hidden tab): not started, every processor undetermined. */
export const NO_LIVE_ART: LiveArt = { started: false, health: NO_VERDICT };

export const LiveArtContext = createContext<LiveArt>(NO_LIVE_ART);

/** The live state of the canvas a node or edge is drawn in. */
export const useLiveArt = (): LiveArt => useContext(LiveArtContext);
```

In `src/canvas/WorkflowCanvas.tsx`:
- Import it: `import { LiveArtContext, NO_LIVE_ART, type LiveArt } from './liveArt';`
- Add a prop to `interface Props`, after `onSelect`:

```ts
  /** What the art shows of the running system; omitted, nothing is started and every processor is undetermined. */
  live?: LiveArt;
```

- Destructure it: `export function WorkflowCanvas({ doc, fitter, width, height, selection = null, onSelect, live = NO_LIVE_ART, children }: Props)`.
- Wrap the canvas `<div className="studio-canvas" …>…</div>` in `<LiveArtContext.Provider value={live}>…</LiveArtContext.Provider>`, inside `FollowFitContext.Provider`.

In `src/app/DocumentPanel.tsx`, replace the line `const status = useLiveStatus(…);` with:

```tsx
  const visible = usePanelVisible(panel, ownerDocument) && open?.status.kind === 'ready';
  const status = useLiveStatus(api, workflowId, visible);
  const liveness = useLiveness(api, visible);
  // a failed live poll is "status unknown" in the capsule and "not started" on the canvas (spec §5.1)
  const live = useMemo<LiveArt>(() => ({ started: status === 'running', health: healthOf(liveness) }), [status, liveness]);
```

pass `live={live}` to `<WorkflowCanvas …>`, and change the imports to:

```tsx
import { useMemo } from 'react';
import type { StudioApi } from '../api/client';
import { healthOf } from '../api/liveness';
import type { LiveArt } from '../canvas/liveArt';
import { useFitter } from '../canvas/useFitter';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import { useStudio, useStudioStore } from '../store/studioStore';
import { CapsuleToolbar } from './CapsuleToolbar';
import { useLiveness, useLiveStatus, useOwnerDocument, usePanelShown, usePanelVisible, type PanelLike } from './panelHooks';
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `npx vitest run src/app src/api src/canvas`
Expected: PASS. Every existing `useLiveStatus` test keeps passing unchanged; it now goes through `usePoll`.

- [ ] **Step 10: Full check and commit**

Run (PowerShell): `npm test; npm run typecheck; npm run build`
Expected: all pass, no React warnings.

```bash
git add src/WorkflowStudio/src/api/client.ts src/WorkflowStudio/src/api/liveness.ts src/WorkflowStudio/src/api/liveness.test.ts src/WorkflowStudio/src/app/panelHooks.ts src/WorkflowStudio/src/app/DocumentPanel.tsx src/WorkflowStudio/src/app/DocumentPanel.test.tsx src/WorkflowStudio/src/canvas/liveArt.tsx src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx
git commit -m "feat(studio): poll processor liveness with the live status and hand both to the canvas" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The step and its processor

The notched HUD step (v50 `drawStep`, B:880-909) and its processor panel (v50 `drawChip`, B:838-877). The ring around the gear chip is the gallery's HUD ring (G `FRAMES.hud.ring`, line 431), scaled × 0.58. A socket sits on the frame edge at every landing and departure (G `socket`, line 453). This task also lays the art foundation: tokens, `art.css` base classes, the `nxCap` gradient and the shape helpers.

**Files:**
- Modify: `src/canvas/tokens.css`
- Create: `src/canvas/art.css`
- Modify: `src/main.tsx`
- Modify: `src/canvas/SvgDefs.tsx`
- Create: `src/canvas/nodes/nxShapes.ts`, `src/canvas/nodes/nxShapes.test.ts`
- Modify (rewrite): `src/canvas/nodes/Chip.tsx`, `src/canvas/nodes/StepNode.tsx`
- Modify: `src/canvas/fitText.ts`, `src/canvas/toFlow.ts`, `src/canvas/canvas.css`
- Test: `src/canvas/nodes/StepNode.test.tsx` (rewrite), `src/canvas/toFlow.test.ts`, `src/canvas/WorkflowCanvas.test.tsx`

**Interfaces:**
- Consumes: `Health` (`api/liveness.ts`), `useLiveArt()` (`canvas/liveArt.tsx`).
- Produces:
  - `STEP_FRAME`, `STEP_FRAME_IN`, `STEP_CAP`, `STEP_GLOSS`, `CACHE_FRAME`, `CACHE_FRAME_IN`, `closingDash(r: number, pattern: number[], scale?: number): string` and `hexPoints(cx: number, cy: number, r: number): string` (`canvas/nodes/nxShapes.ts`)
  - `ProcessorView.processorId: string`
  - `StepView` props `StepNodeData & { health: Health }`; `ChipView` props `{ p, ins, outs, health }`
  - the base classes in `art.css`: `.nx`, `.nx-ln`, `.nx-hl`, `.nx-fc`, `.nx-fh`, `.nx-bd`, `.nx-nd`, `.nx-g`, `.nx-gs`, `.nx-d1/2/3`, `.nx-spin`, `.nx-wait`, `.nx-halted`
  - the CSS tokens `--structure`, `--healthy`, `--unhealthy`, `--undetermined`, `--warn`

- [ ] **Step 1: Write the failing shape tests**

Create `src/canvas/nodes/nxShapes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { closingDash, hexPoints } from './nxShapes';

const total = (dash: string) => dash.split(' ').map(Number).reduce((a, b) => a + b, 0);

describe('closingDash', () => {
  it('rescales a pattern so a whole number of repeats closes the circle (the hub spinner)', () => {
    const dash = closingDash(87, [44, 14, 8, 14]);
    expect(dash.split(' ')).toHaveLength(4);
    expect(total(dash) * 7).toBeCloseTo(2 * Math.PI * 87, 0);
  });

  it('applies a scale before closing (the processor spinner at 0.58)', () => {
    expect(total(closingDash(28.5, [30, 12, 6, 12], 0.58)) * 5).toBeCloseTo(2 * Math.PI * 28.5, 0);
  });
});

describe('hexPoints', () => {
  it('gives a hexagon with flat left and right vertices, to one decimal', () => {
    expect(hexPoints(0, 0, 10)).toBe('10.0,0.0 5.0,8.7 -5.0,8.7 -10.0,0.0 -5.0,-8.7 5.0,-8.7');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/canvas/nodes/nxShapes.test.ts`
Expected: FAIL ("Failed to resolve import ./nxShapes").

- [ ] **Step 3: Write the shapes**

Create `src/canvas/nodes/nxShapes.ts`:

```ts
/**
 * The locked art's outlines (spec §5.1), at this grid's sizes (mockup v50 NX_FRAME, NX_CFRAME): notched
 * HUD frames with 14 px chamfers and a 6 px notch top and bottom.
 */
export const STEP_FRAME = 'M14 0H80L86 6H138L144 0H210L224 14V146L210 160H144L138 154H86L80 160H14L0 146V14Z';
export const STEP_FRAME_IN = 'M20 8H76L82 14H142L148 8H204L216 20V140L204 152H148L142 146H82L76 152H20L8 140V20Z';
/** The glossy title cap: it follows the top notch and ends on y = 40 (CAP_H). */
export const STEP_CAP = 'M16 4H78L84 10H140L146 4H208L220 16V40H4V16Z';
export const STEP_GLOSS = 'M18 6H118L112 12H10Z';
export const CACHE_FRAME = 'M14 0H52L58 6H102L108 0H146L160 14V146L146 160H108L102 154H58L52 160H14L0 146V14Z';
export const CACHE_FRAME_IN = 'M20 8H48L54 14H106L112 8H140L152 20V140L140 152H112L106 146H54L48 152H20L8 140V20Z';

/**
 * A dash pattern for a circle of radius `r`, scaled by `scale` and then stretched so a whole number of
 * repeats closes it: the turning ring has no seam.
 */
export function closingDash(r: number, pattern: number[], scale = 1): string {
  const circumference = 2 * Math.PI * r;
  const sum = pattern.reduce((a, b) => a + b, 0);
  const repeats = Math.max(1, Math.round(circumference / (sum * scale)));
  const k = circumference / (repeats * sum);
  return pattern.map((v) => (v * k).toFixed(2)).join(' ');
}

/** The six corners of a hexagon with flat left and right vertices (the cache's mark). */
export function hexPoints(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, i) =>
    `${(cx + r * Math.cos((i * Math.PI) / 3)).toFixed(1)},${(cy + r * Math.sin((i * Math.PI) / 3)).toFixed(1)}`).join(' ');
}
```

Run: `npx vitest run src/canvas/nodes/nxShapes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Write the failing step tests**

Replace `src/canvas/nodes/StepNode.test.tsx` with:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Health } from '../../api/liveness';
import { STEP_FRAME } from './nxShapes';
import { StepView, type StepNodeData } from './StepNode';

const data: StepNodeData = {
  name: { text: 'fetch…', full: 'fetch-orders-from-the-api', cut: true },
  version: { text: 'v1.0.0', full: 'v1.0.0', cut: false },
  parked: false,
  letter: 'C',
  colour: '#2DD4BF',
  assignment: '◆ 2 keys',
  fanIn: 2,
  ins: [96, 112],
  outs: [96],
  processor: {
    processorId: 'p1',
    title: { text: 'fetcher', full: 'fetcher', cut: false },
    version: '2.1.0',
    rows: [
      { label: 'in', value: { text: 'orders-in', full: 'orders-in', cut: false } },
      { label: 'out', value: null },
      { label: 'cfg', value: null },
    ],
    inputLit: true,
    outputLit: false,
    tooltip: 'fetcher 2.1.0',
  },
};

const view = (over: Partial<StepNodeData> = {}, health: Health = 'healthy') =>
  render(<svg><StepView {...data} {...over} health={health} /></svg>);

describe('StepView', () => {
  it('draws the cap text, the condition pill, the assignment badge and the fan-in badge', () => {
    const { getByText } = view();
    expect(getByText('fetch…')).toBeInTheDocument();
    expect(getByText('STEP')).toBeInTheDocument();
    expect(getByText('v1.0.0')).toBeInTheDocument();
    expect(getByText('C')).toBeInTheDocument();
    expect(getByText('◆ 2 keys')).toBeInTheDocument();
    expect(getByText('fan-in ×2')).toBeInTheDocument();
  });

  it('draws the notched frame and the glossy cap of the locked art', () => {
    const { container } = view();
    expect(container.querySelector('path.nx-frame')!.getAttribute('d')).toBe(STEP_FRAME);
    expect(container.querySelector('path[fill="url(#nxCap)"]')).not.toBeNull();
  });

  it('puts the full name in a tooltip when it was cut', () => {
    const { container } = view();
    expect(container.querySelector('text.nx-sn')!.parentElement!.querySelector(':scope > title')!.textContent)
      .toBe('fetch-orders-from-the-api');
  });

  it('puts a socket on the frame edge and a contact on the panel for every landing and departure, lit only where the side has a schema', () => {
    const { container } = view();
    expect(container.querySelectorAll('.nx-socket')).toHaveLength(3);
    expect(container.querySelectorAll('.nx-socket circle.nx-fh:not(.nx-d2)')).toHaveLength(2);   // two landings, In schema set
    expect(container.querySelectorAll('.chipg rect.nx-fh.nx-g')).toHaveLength(2);
    expect(container.querySelectorAll('.chipg rect.nx-nd')).toHaveLength(1);                     // one departure, no Out schema
  });

  it.each([
    ['healthy', false, false],
    ['unhealthy', true, false],
    ['undetermined', true, true],
  ] as const)('draws a %s processor: halted %s, blinking %s', (health, halted, waiting) => {
    const { container } = view({}, health);
    const ring = container.querySelector('.nx-health')!;
    expect(ring.getAttribute('data-health')).toBe(health);
    expect(ring.classList.contains('nx-halted')).toBe(halted);
    expect(ring.classList.contains('nx-wait')).toBe(waiting);
    expect(ring.querySelector('.nx-spin')).not.toBeNull();
  });

  it('names its processor on the panel, for the live check', () => {
    expect(view().container.querySelector('.chipg')!.getAttribute('data-processor')).toBe('p1');
  });

  it('shows the processor title with its version, a set slot by value and an empty one as ∅', () => {
    const { container, getByText, getAllByText } = view();
    expect(getByText('PROCESSOR')).toBeInTheDocument();
    expect(getByText('fetcher')).toBeInTheDocument();
    expect(container.querySelector('.nx-pv')!.textContent).toBe(' 2.1.0');
    expect(getByText('orders-in')).toBeInTheDocument();
    expect(getAllByText('∅')).toHaveLength(2);
  });

  it('marks a parked step with the PARKED label and the parked class', () => {
    const { container, getByText } = view({ parked: true });
    expect(getByText('PARKED')).toBeInTheDocument();
    expect(container.querySelector('.blk')!.classList.contains('parked')).toBe(true);
  });
});
```

In `src/canvas/WorkflowCanvas.test.tsx`, in the test `'reports a click on a step, on its die, on the sphere and on empty canvas'`, change the die click to:

```ts
      fireEvent.click(node(container, 's2').querySelector('.chipg .nx-panel')!);
```

and add to `describe('selection (slice 3a)', …)`:

```tsx
    it('draws each processor in the health the canvas live state gives it', async () => {
      const live = { started: false, health: (id: string) => (id === 'p1' ? 'unhealthy' as const : 'healthy' as const) };
      const { container } = render(<WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800} live={live} />);
      const rings = [...container.querySelectorAll('.nx-health')];
      expect(rings.length).toBe(2);
      for (const ring of rings) expect(ring.getAttribute('data-health')).toBe('unhealthy');
    });
```

In `src/canvas/toFlow.test.ts`, replace the test `'shows the processor die: …'` with:

```ts
  it('shows the processor panel: id, name and version, In schema by name, empty slots as null', () => {
    const a = toFlow(doc(), fitter).nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;

    expect(a.processor.processorId).toBe('p1');
    expect(a.processor.title.text).toBe('fetcher');
    expect(a.processor.version).toBe('2.1.0');
    expect(a.processor.rows.map((r) => [r.label, r.value?.text ?? null])).toEqual([['in', 'orders-in'], ['out', null], ['cfg', null]]);
    expect([a.processor.inputLit, a.processor.outputLit]).toEqual([true, false]);
  });

  it('cuts a schema name to the panel (76 px) and drops the version when name and version pass 92 px (review focus 5)', () => {
    const graph = doc();
    graph.graph.schemas.set('sIn', { ...graph.graph.schemas.get('sIn')!, name: 'a-schema-name-that-is-far-too-long' });
    graph.graph.processors.set('p1', { ...graph.graph.processors.get('p1')!, name: 'a-processor-name' });
    const a = toFlow(graph, fitter).nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;

    const value = a.processor.rows[0]!.value!;
    expect(value.cut).toBe(true);
    expect(value.full).toBe('a-schema-name-that-is-far-too-long');
    expect(value.text.length * 7).toBeLessThanOrEqual(76);
    expect(a.processor.version).toBeNull();
    expect(a.processor.title.text.length * 7).toBeLessThanOrEqual(92);
  });
```

- [ ] **Step 5: Run them to see them fail**

Run: `npx vitest run src/canvas`
Expected: FAIL (no `health` prop, no `.nx-frame`, no `processorId`, no `.nx-panel`).

- [ ] **Step 6: Tokens, defs and the art stylesheet**

In `src/canvas/tokens.css`, add one line inside `:root`, after `--accent: #7DD3FC;`:

```css
  --structure: #E8F1FF; --healthy: #22C55E; --unhealthy: #EF4444; --undetermined: #94A3B8; --warn: #F5B841;
```

In `src/canvas/SvgDefs.tsx`, add inside `<defs>`, before the `glow` filter's comment:

```tsx
        {/* the step's glossy title cap (locked art): white to silver */}
        <linearGradient id="nxCap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FFFFFF" stopOpacity=".95" /><stop offset="1" stopColor="#B9C9E2" stopOpacity=".72" /></linearGradient>
```

Create `src/canvas/art.css`:

```css
/* The node art (spec §5.1, locked 2026-10-06): the gallery skp-studio-node-art-final.html at the grid sizes
   of mockup v50. --nc is an element's colour and --nh its hot (lighter) tint. Base stroke widths live in
   classes, never inline, so the hover and selection rules can override them. */
.nx { --nh: color-mix(in srgb, var(--nc) 45%, white); }
.blk.nx, .chipg.nx, .cachetag.nx { --nc: var(--structure); }
.nx-ln { fill: none; stroke: var(--nc); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.nx-hl { fill: none; stroke: var(--nh); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
/* after .nx-hl on purpose: an element that is both a dark body and a hot outline keeps the dark fill */
.nx-fc { fill: var(--nc); }
.nx-fh { fill: var(--nh); }
.nx-bd { fill: #07122a; }
.nx-nd { fill: #060c17; stroke: var(--nh); stroke-width: 1.6; }
.nx-g { filter: drop-shadow(0 0 2px var(--nc)) drop-shadow(0 0 6px var(--nc)); }
.nx-gs { filter: drop-shadow(0 0 1.5px var(--nc)); }
.nx-d1 { opacity: .55; }
.nx-d2 { opacity: .3; }
.nx-d3 { opacity: .15; }
.nx-spin { transform-box: fill-box; transform-origin: center; animation: nxspin 18s linear infinite; }
@keyframes nxspin { to { transform: rotate(360deg); } }
.nx-wait { animation: nxwait 2.6s ease-in-out infinite; }
@keyframes nxwait { 50% { opacity: .35; } }
.nx-halted .nx-spin { animation: none; }

/* step: dark text on the glossy cap */
.blk .nx-frame { stroke-width: 1.1; }
.blk .nx-sn { font: 400 13px var(--sans); fill: #04111F; }
.blk .nx-sk { font: 400 9px var(--mono); fill: rgba(4, 17, 31, .75); letter-spacing: .12em; }
.blk .nx-skv { font: 400 9.5px var(--mono); fill: rgba(4, 17, 31, .75); }
.blk .nx-asg { fill: #04111F; }
.blk .nx-socket .nx-nd { stroke-width: 1; }
.blk.parked { opacity: .6; }
.blk.parked .nx-frame { stroke-dasharray: 6 4; }
.blk.nx:hover .nx-frame { stroke-width: 1.6; }
.studio-sel .blk.nx .nx-frame { stroke: var(--accent); stroke-width: 2; }

/* processor: light text on the dark panel; health colours only the ring and the gear chip */
.chipg .nx-panel { stroke-width: 1; }
.chipg .nx-tp { font: 400 7px var(--mono); fill: var(--nh); letter-spacing: .16em; opacity: .85; }
.chipg .nx-pn { font: 400 11px var(--sans); fill: var(--ink); }
.chipg .nx-pv { font: 400 9px var(--mono); fill: var(--muted); }
.chipg .nx-tl { font: 400 8.5px var(--mono); fill: var(--muted); }
.chipg .nx-tv { font: 400 9px var(--mono); fill: var(--ink); }
.chipg .nx-tn { font: 400 9px var(--mono); fill: var(--faint); }
.nx-health[data-health="healthy"] { --nc: var(--healthy); }
.nx-health[data-health="unhealthy"] { --nc: var(--unhealthy); }
.nx-health[data-health="undetermined"] { --nc: var(--undetermined); }
.chipg.nx:hover .nx-panel { stroke-width: 1.5; }
.studio-die-sel .chipg.nx .nx-panel { stroke: var(--accent); stroke-width: 1.8; }

@media (prefers-reduced-motion: reduce) {
  .nx-spin, .nx-wait { animation: none; }
}
```

In `src/main.tsx`, add `import './canvas/art.css';` on the line after `import './canvas/canvas.css';`.

- [ ] **Step 7: The processor panel**

Replace `src/canvas/nodes/Chip.tsx` with:

```tsx
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
```

Append to `src/canvas/art.css`, before the `@media` block, the ring and chip widths:

```css
.chipg .nx-dots { stroke-dasharray: .6 1.75; stroke-width: 2.9; opacity: .6; }
.chipg .nx-spinner { stroke-width: .95; opacity: .8; }
.chipg .nx-pins { stroke-width: 1.1; stroke-linecap: butt; }
.chipg .nx-chipbody { stroke-width: 1.1; }
.chipg .nx-core { stroke-width: .85; }
```

- [ ] **Step 8: The step**

Replace `src/canvas/nodes/StepNode.tsx` with:

```tsx
import { Fragment } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Health } from '../../api/liveness';
import { CHIP, PMID, STEP_H, STEP_W } from '../../layout/geometry';
import type { FittedText } from '../fitText';
import { useLiveArt } from '../liveArt';
import { ChipView, type ProcessorView } from './Chip';
import { Label } from './Label';
import { STEP_CAP, STEP_FRAME, STEP_FRAME_IN, STEP_GLOSS } from './nxShapes';

export type { ProcessorView } from './Chip';

export type StepNodeData = {
  name: FittedText;
  version: FittedText;
  parked: boolean;
  letter: string;
  colour: string;
  /** `◆ 3 keys`, `◇ {}`, or null when the step has no assignment in this workflow. */
  assignment: string | null;
  fanIn: number;
  /** Step-local heights where wires land (left edge) and leave (right edge). */
  ins: number[];
  outs: number[];
  processor: ProcessorView;
};
export type StepNodeType = Node<StepNodeData, 'step'>;

const W = STEP_W, H = STEP_H;

/** Where a wire meets the frame (gallery socket): a dark ring with a dot, lit when that side has a schema. */
function Socket({ x, y, lit }: { x: number; y: number; lit: boolean }) {
  return (
    <g className="nx-socket">
      <circle className="nx-nd" cx={x} cy={y} r={3.2} />
      <circle className={lit ? 'nx-fh' : 'nx-fh nx-d2'} cx={x} cy={y} r={1.4} />
    </g>
  );
}

/**
 * A step in the notched HUD frame (spec §5.1; mockup v50 drawStep). The glossy cap carries what is the
 * step's: name, `STEP vX`, the entry-condition pill and the assignment keys. Its processor panel sits
 * inside, and traces run from the frame edge to the panel at every landing and departure.
 */
export function StepView({ health, ...d }: StepNodeData & { health: Health }) {
  const ins = d.ins.length > 0 ? d.ins : [PMID];
  const outs = d.outs.length > 0 ? d.outs : [PMID];
  const versionX = d.parked ? 56 : 42;
  const p = d.processor;

  return (
    <g className={d.parked ? 'blk nx parked' : 'blk nx'}>
      <path className="nx-bd" d={STEP_FRAME} />
      <g className="nx-g"><path className="nx-hl nx-frame" d={STEP_FRAME} /></g>
      <path className="nx-ln nx-d2" d={STEP_FRAME_IN} />
      {[0, 1, 2, 3, 4].map((i) => <path key={`t${i}`} className="nx-fc nx-g" d={`M${92 + i * 9} 0.5h6l-2 3h-6z`} />)}
      {[0, 1, 2, 3].map((i) => (
        <Fragment key={`s${i}`}>
          <path className="nx-fc nx-d1" d={`M2 ${26 + i * 7}l3-2v4l-3 2z`} />
          <rect className="nx-fc nx-d1" x={219} y={24 + i * 7} width={3} height={3} />
        </Fragment>
      ))}
      {[0, 1, 2, 3, 4].map((i) => <rect key={`b${i}`} className="nx-fc" x={96 + i * 7} y={155.5} width={3} height={3} />)}
      <path d={STEP_CAP} fill="url(#nxCap)" />
      <path d={STEP_GLOSS} fill="#fff" opacity={0.22} />
      <path className="nx-hl nx-d1" d="M4 40H220" />
      <Label className="nx-sn" x={12} y={24} fitted={d.name} />
      <text className="nx-sk" x={12} y={36}>{d.parked ? 'PARKED' : 'STEP'}</text>
      <Label className="nx-skv" x={versionX} y={36} fitted={d.version} />
      <rect x={W - 26} y={10} width={14} height={13} rx={2} fill={d.colour} stroke="rgba(3,12,28,.4)" />
      <text className="badge" x={W - 19} y={20} textAnchor="middle" fill="#04111F" fontWeight={600}>{d.letter}</text>
      {d.assignment && <text className="badge nx-asg" x={W - 12} y={36} textAnchor="end">{d.assignment}</text>}
      {d.fanIn > 1 && (
        <>
          <rect x={W - 70} y={-9} width={58} height={16} rx={8} fill="var(--panel)" stroke="var(--line-2)" />
          <text className="badge" x={W - 41} y={2.5} textAnchor="middle" fill="var(--muted)">{`fan-in ×${d.fanIn}`}</text>
        </>
      )}
      {ins.map((y, i) => <path key={`ti${i}`} className={p.inputLit ? 'nx-ln' : 'nx-ln nx-d3'} d={`M0 ${y}H${CHIP.x}`} />)}
      {outs.map((y, i) => <path key={`to${i}`} className={p.outputLit ? 'nx-ln' : 'nx-ln nx-d3'} d={`M${CHIP.x + CHIP.w} ${y}H${W}`} />)}
      {ins.map((y, i) => <Socket key={`si${i}`} x={0} y={y} lit={p.inputLit} />)}
      {outs.map((y, i) => <Socket key={`so${i}`} x={W} y={y} lit={p.outputLit} />)}
      <ChipView p={p} health={health} ins={ins.map((y) => y - CHIP.y)} outs={outs.map((y) => y - CHIP.y)} />
    </g>
  );
}

export function StepNode({ data }: NodeProps<StepNodeType>) {
  const { health } = useLiveArt();
  return (
    <>
      <Handle id="in" type="target" position={Position.Left} isConnectable={false} style={{ top: PMID }} />
      <svg width={W} height={H} overflow="visible" style={{ display: 'block' }}>
        <StepView {...data} health={health(data.processor.processorId)} />
      </svg>
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} style={{ top: PMID }} />
    </>
  );
}
```

- [ ] **Step 9: Measure with the art's fonts**

In `src/canvas/fitText.ts`, change four entries of `FONT` (leave `cacheName`, `cacheSub` and `sphere` for Tasks 4 and 5):

```ts
  stepName: `13px ${SANS}`,
  stepVersion: `9.5px ${MONO}`,
  processorTitle: `11px ${SANS}`,
  processorRow: `9px ${MONO}`,
```

In `src/canvas/toFlow.ts`, replace `stepLabels`, the `ROOM` constant and `processorView` with:

```ts
function stepLabels(step: Step, parked: boolean, fitter: TextFitter): { name: FittedText; version: FittedText; parked: boolean } {
  const versionX = parked ? 56 : 42;
  return {
    name: fitter.fit(step.name, STEP_W - 12 - 34, FONT.stepName),
    version: fitter.fit(`v${step.version}`, STEP_W - versionX - 74, FONT.stepVersion),
    parked,
  };
}

/** Room on the processor panel (mockup v50 drawChip): the title line, and a slot's value after its label. */
const TITLE_ROOM = 92;
const VALUE_ROOM = 76;

function processorView(p: Processor | undefined, graph: Graph, fitter: TextFitter): ProcessorView {
  const name = p?.name ?? '(missing processor)';
  const version = p?.version ?? '';
  const fitsWithVersion = version !== '' && fitter.width(`${name} ${version}`, FONT.processorTitle) <= TITLE_ROOM;
  const schemaLabel = (id: Id | null | undefined) => {
    if (!id) return null;
    const s = graph.schemas.get(id);
    return s ? s.name : id;
  };
  const row = (label: string, id: Id | null | undefined) => {
    const value = schemaLabel(id);
    return { label, value: value === null ? null : fitter.fit(value, VALUE_ROOM, FONT.processorRow) };
  };
  const tip = (label: string, id: Id | null | undefined) => {
    const s = id ? graph.schemas.get(id) : undefined;
    return `${label} ${id ? (s ? `${s.name} ${s.version}` : id) : '∅'}`;
  };

  return {
    processorId: p?.id ?? '',
    title: fitsWithVersion ? { text: name, full: name, cut: false } : fitter.fit(name, TITLE_ROOM, FONT.processorTitle),
    version: fitsWithVersion ? version : null,
    rows: [row('in', p?.inputSchemaId), row('out', p?.outputSchemaId), row('cfg', p?.configSchemaId)],
    inputLit: !!p?.inputSchemaId,
    outputLit: !!p?.outputSchemaId,
    tooltip: [`${name} ${version}`.trim(), tip('in ', p?.inputSchemaId), tip('out', p?.outputSchemaId), tip('cfg', p?.configSchemaId)].join('\n'),
  };
}
```

- [ ] **Step 10: Drop the plan-2 step and die rules**

In `src/canvas/canvas.css`, replace everything from the line `/* step and cache shells */` through the line `.chipg .io .nul { fill: var(--faint); }` with:

```css
/* cache shell (plan 2; the locked cache replaces it in plan 3c Task 5) */
.cachetag .contact { fill: #000; opacity: .5; filter: url(#soft); }
.cachetag .shell { fill: url(#darkbody); }
.cachetag .cap { fill: url(#capfill); }
.cachetag .rimr { fill: none; stroke: url(#rimline); stroke-width: 1.2; }
.cachetag .cname { font-size: 13px; font-weight: 600; fill: #F4F9FF; paint-order: stroke; stroke: rgba(3, 12, 28, .35); stroke-width: 2.5px; }
.cachetag .csub { font-family: var(--mono); font-size: 10px; fill: var(--muted); }
.badge { font-family: var(--mono); font-size: 9.5px; }
```

and replace the eight rules under `/* hover and selection (mockup v49, the .sel rules); … */` with:

```css
.cachetag:hover .cap { filter: brightness(1.1); }
.wf:hover .sphere { filter: brightness(1.08); }
.studio-sel .cachetag .rimr { stroke: var(--accent); stroke-width: 1.8; stroke-dasharray: none; }
.studio-sel .cachetag .shell { filter: url(#glow); }
.studio-sel .wf .sphere { filter: url(#glow); }
```

- [ ] **Step 11: Run the tests to see them pass**

Run: `npx vitest run src/canvas`
Expected: PASS, including the font test (`toFlow` still measures with every `FONT` entry).

- [ ] **Step 12: Full check and commit**

Run (PowerShell): `npm test; npm run typecheck; npm run build`
Expected: all pass, no React warnings.

```bash
git add src/WorkflowStudio/src/canvas/tokens.css src/WorkflowStudio/src/canvas/art.css src/WorkflowStudio/src/main.tsx src/WorkflowStudio/src/canvas/SvgDefs.tsx src/WorkflowStudio/src/canvas/nodes/nxShapes.ts src/WorkflowStudio/src/canvas/nodes/nxShapes.test.ts src/WorkflowStudio/src/canvas/nodes/Chip.tsx src/WorkflowStudio/src/canvas/nodes/StepNode.tsx src/WorkflowStudio/src/canvas/nodes/StepNode.test.tsx src/WorkflowStudio/src/canvas/fitText.ts src/WorkflowStudio/src/canvas/toFlow.ts src/WorkflowStudio/src/canvas/toFlow.test.ts src/WorkflowStudio/src/canvas/WorkflowCanvas.test.tsx src/WorkflowStudio/src/canvas/canvas.css
git commit -m "feat(studio): the locked step and processor art, with processor health from liveness" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The workflow hub

The hub dial (v50 `drawWorkflow`, B:947-974; gallery `hubDial`, G:604-621).
- The two outer rings are static, in the structure white.
- Inside them: a segment ring that turns, and a core with a radial glow, both in the state colour. Started is green and turning. Not started is grey, still and blinking slowly.
- Only "WORKFLOW" is written on the dial; the unique name is its tooltip.
- A pill under the hub carries the cron and the state (gallery `wfPill`).

**Files:**
- Modify (rewrite): `src/canvas/nodes/WorkflowNode.tsx`
- Create: `src/canvas/nodes/WorkflowNode.test.tsx`
- Modify: `src/canvas/toFlow.ts`, `src/canvas/fitText.ts`, `src/canvas/art.css`, `src/canvas/canvas.css`
- Test: `src/canvas/toFlow.test.ts`, `src/canvas/WorkflowCanvas.test.tsx`

**Interfaces:**
- Consumes: `useLiveArt()`, `closingDash`, `entityName` (`model/entityNames.ts`).
- Produces: `WorkflowNodeData = { tip: string; cron: FittedText }`; `WorkflowView` props `WorkflowNodeData & { started: boolean }`; `FONT.hubPill`.

- [ ] **Step 1: Write the failing tests**

Create `src/canvas/nodes/WorkflowNode.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkflowView, type WorkflowNodeData } from './WorkflowNode';

const data: WorkflowNodeData = { tip: 'orders_1.0.0-wf1', cron: { text: '⏱ 0 * * * * *', full: '⏱ 0 * * * * *', cut: false } };

describe('WorkflowView', () => {
  it('writes only WORKFLOW on the dial, with the unique name as its tooltip', () => {
    const { container, getByText } = render(<svg><WorkflowView {...data} started={false} /></svg>);
    expect(getByText('WORKFLOW')).toBeInTheDocument();
    expect(container.querySelector('.wf > title')!.textContent).toBe('orders_1.0.0-wf1');
    expect([...container.querySelectorAll('text')].some((t) => t.textContent!.includes('orders'))).toBe(false);
  });

  it('is grey, still and blinking when not started, with the cron and state on its pill', () => {
    const { container } = render(<svg><WorkflowView {...data} started={false} /></svg>);
    const wf = container.querySelector('.wf')!;
    expect(wf.classList.contains('nx-idlewf')).toBe(true);
    expect(wf.getAttribute('data-started')).toBe('false');
    expect(container.querySelector('.nx-state')!.textContent).toBe('⏱ 0 * * * * *  ○ not started');
  });

  it('is green and turning when started', () => {
    const { container } = render(<svg><WorkflowView {...data} started /></svg>);
    const wf = container.querySelector('.wf')!;
    expect(wf.classList.contains('started')).toBe(true);
    expect(wf.classList.contains('nx-idlewf')).toBe(false);
    expect(container.querySelector('.hub-inner .nx-spin')).not.toBeNull();
    expect(container.querySelector('.nx-state')!.textContent).toBe('⏱ 0 * * * * *  ● started');
  });

  it('gives each hub its own core gradient, so two documents never share one', () => {
    const { container } = render(<svg><WorkflowView {...data} started /><WorkflowView {...data} started={false} /></svg>);
    const ids = [...container.querySelectorAll('radialGradient')].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const fills = [...container.querySelectorAll('.nx-core-glow')].map((c) => c.getAttribute('fill'));
    expect(fills).toEqual(ids.map((id) => `url(#${id})`));
  });

  it('keeps the full cron in a tooltip when it was cut', () => {
    const cut = { text: '⏱ 0 0/5 …', full: '⏱ 0 0/5 * * * MON-FRI 2026', cut: true };
    const { container } = render(<svg><WorkflowView {...data} cron={cut} started={false} /></svg>);
    expect(container.querySelector('.nx-state')!.parentElement!.querySelector(':scope > title')!.textContent).toBe('⏱ 0 0/5 * * * MON-FRI 2026');
  });
});
```

In `src/canvas/toFlow.test.ts`, replace the test `'splits a long workflow name over at most three sphere lines'` with:

```ts
  it('gives the hub its unique name as a tooltip and the cron for its pill', () => {
    const hub = toFlow(doc(), fitter).nodes.find((n) => n.id === SPHERE_NODE_ID)!.data as import('./nodes/WorkflowNode').WorkflowNodeData;
    expect(hub.tip).toBe('orders_1.0.0-wf1');
    expect(hub.cron).toEqual({ text: '⏱ not scheduled', full: '⏱ not scheduled', cut: false });
  });

  it('cuts a long cron to the pill and keeps it whole for the tooltip (review focus 5)', () => {
    const long = '0 0/5 8-18 ? * MON,TUE,WED,THU,FRI 2026-2030';
    const graph = doc({ workflow: { ...doc().graph.workflow, cronExpression: long } });
    const hub = toFlow(graph, fitter).nodes.find((n) => n.id === SPHERE_NODE_ID)!.data as import('./nodes/WorkflowNode').WorkflowNodeData;
    expect(hub.cron.cut).toBe(true);
    expect(hub.cron.full).toBe(`⏱ ${long}`);
    // the pill is 240 wide, its text starts 12 in and the state needs 15 characters
    expect(hub.cron.text.length * 7).toBeLessThanOrEqual(240 - 24 - 15 * 7);
  });
```

In `src/canvas/WorkflowCanvas.test.tsx`, add to `describe('selection (slice 3a)', …)`:

```tsx
    it('shows the hub started only when the live state says so (review focus 3)', async () => {
      const doc = await twoSteps();
      const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} />);
      expect(container.querySelector('.wf')!.getAttribute('data-started')).toBe('false');

      rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} live={{ started: true, health: () => 'healthy' }} />);
      expect(container.querySelector('.wf')!.getAttribute('data-started')).toBe('true');
    });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/canvas`
Expected: FAIL (no `tip`/`cron`, no `.nx-state`).

- [ ] **Step 3: Write the hub**

Replace `src/canvas/nodes/WorkflowNode.tsx` with:

```tsx
import { useId } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { SPHERE_R } from '../../layout/geometry';
import type { FittedText } from '../fitText';
import { useLiveArt } from '../liveArt';
import { Tip } from './Label';
import { closingDash } from './nxShapes';

export type WorkflowNodeData = {
  /** The workflow's unique name (spec §7): the dial's tooltip. */
  tip: string;
  /** `⏱ <cron>` fitted to the pill beside the state. */
  cron: FittedText;
};
export type WorkflowNodeType = Node<WorkflowNodeData, 'workflow'>;

const R = SPHERE_R, C = SPHERE_R; // the node box is 2r × 2r, so the centre is (r, r)
const SPINNER = closingDash(R - 9, [44, 14, 8, 14]);
const TICKS = `1.5 ${(2 * Math.PI * R / 48 - 1.5).toFixed(2)}`;
/** The pill (gallery wfPill, 200 wide at its r 80 hub, × 1.2): centred under the dial. */
export const PILL_W = 240;
const STARTED = '  ● started', NOT_STARTED = '  ○ not started';

/**
 * The workflow as the hub dial (spec §5.1; mockup v50 drawWorkflow, gallery hubDial). The two outer
 * rings are static and white. Inside them the state: started is green with the segment ring turning;
 * not started is grey, still and blinking slowly. The dial says only WORKFLOW; the pill under it
 * carries the cron and the state and never blinks.
 */
export function WorkflowView({ tip, cron, started }: WorkflowNodeData & { started: boolean }) {
  const core = `nxcore${useId().replace(/[^\w-]/g, '')}`;
  const pillX = C - PILL_W / 2, pillY = C + R + 14;
  return (
    <g className={started ? 'wf nx started' : 'wf nx nx-idlewf'} data-started={String(started)}>
      <title>{tip}</title>
      <g className="sphere">
        <circle className="nx-fc nx-glow" cx={C} cy={C} r={R + 28} />
        <g className="nx hub-outer">
          <g className="nx-g"><circle className="nx-hl nx-ticks" cx={C} cy={C} r={R} style={{ strokeDasharray: TICKS }} /></g>
          <g className="nx-g"><circle className="nx-hl nx-rim" cx={C} cy={C} r={R + 6} /></g>
        </g>
        <g className="hub-inner">
          <circle className="nx-hl nx-spin nx-hub-spinner" cx={C} cy={C} r={R - 9} style={{ strokeDasharray: SPINNER }} />
          <radialGradient id={core}>
            <stop offset="0" style={{ stopColor: 'var(--nc)', stopOpacity: 0.3 }} />
            <stop offset="1" style={{ stopColor: 'var(--nc)', stopOpacity: 0.05 }} />
          </radialGradient>
          <circle className="nx-bd" cx={C} cy={C} r={R - 22} />
          <circle className="nx-core-glow" cx={C} cy={C} r={R - 22} fill={`url(#${core})`} />
          <g className="nx-g"><circle className="nx-ln nx-core-dots" cx={C} cy={C} r={R - 22} /></g>
        </g>
      </g>
      <text className="nx-wl" x={C} y={C + 4} textAnchor="middle">WORKFLOW</text>
      <g className="nx-pill">
        <rect className="nx-bd" x={pillX} y={pillY} width={PILL_W} height={18} rx={9} />
        <rect className="nx-ln" x={pillX} y={pillY} width={PILL_W} height={18} rx={9} />
        <Tip full={cron.full} cut={cron.cut}>
          <text className="nx-state" x={pillX + 12} y={pillY + 12.5}>{cron.text}<tspan>{started ? STARTED : NOT_STARTED}</tspan></text>
        </Tip>
      </g>
    </g>
  );
}

/** The longest state text, for the room left to the cron on the pill. */
export const PILL_STATE = NOT_STARTED;

export function WorkflowNode({ data }: NodeProps<WorkflowNodeType>) {
  const { started } = useLiveArt();
  return (
    <>
      <svg width={2 * R} height={2 * R} overflow="visible" style={{ display: 'block' }}>
        <WorkflowView {...data} started={started} />
      </svg>
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} style={{ top: R }} />
      <Handle id="down" type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
```

- [ ] **Step 4: Its data and font**

In `src/canvas/fitText.ts`, replace the `sphere` entry of `FONT` with:

```ts
  hubPill: `10px ${MONO}`,
```

In `src/canvas/toFlow.ts`:
- Add imports `import { entityName } from '../model/entityNames';` and `import { PILL_STATE, PILL_W } from './nodes/WorkflowNode';` (keep the type import of `WorkflowNodeType`).
- In the sphere node, replace `data: sphereLabel(graph.workflow.name, fitter),` with `data: hubData(graph.workflow, fitter),`.
- Delete the function `sphereLabel`.
- Add:

```ts
/** The hub's tooltip and its pill's cron, cut to the room the state text leaves (gallery wfPill). */
function hubData(workflow: Graph['workflow'], fitter: TextFitter): { tip: string; cron: FittedText } {
  const room = PILL_W - 24 - fitter.width(PILL_STATE, FONT.hubPill);
  return {
    tip: entityName(workflow.name, workflow.version, workflow.id),
    cron: fitter.fit(`⏱ ${workflow.cronExpression || 'not scheduled'}`, room, FONT.hubPill),
  };
}
```

- [ ] **Step 5: Its styles**

Append to `src/canvas/art.css`, before the `@media` block:

```css
/* workflow hub: the outer rings are structure white; the inside carries the run state */
.wf.nx { --nc: var(--undetermined); }
.wf.nx.started { --nc: var(--healthy); }
.wf .hub-outer { --nc: var(--structure); }
.wf .nx-glow { opacity: .05; pointer-events: none; }
.wf .nx-ticks { stroke-width: 7; }
.wf .nx-rim { stroke-width: 1.2; }
.wf .nx-hub-spinner { stroke-width: 2; }
.wf .nx-core-dots { stroke-dasharray: 1 3; stroke-width: 4; opacity: .55; }
.wf .nx-wl { font: 400 11px var(--sans); fill: var(--nh); letter-spacing: 3px; }
.wf .nx-pill .nx-ln { stroke-width: 1; opacity: .7; }
.wf .nx-state { font: 400 10px var(--mono); fill: var(--nh); }
.wf.nx-idlewf .hub-inner { animation: nxwait 2.6s ease-in-out infinite; }
.wf.nx-idlewf .nx-spin { animation: none; }
.wf.nx:hover .sphere { filter: brightness(1.08); }
.studio-sel .wf .sphere { filter: url(#glow); }
```

and add `.wf.nx-idlewf .hub-inner` to the reduced-motion rule, which becomes:

```css
@media (prefers-reduced-motion: reduce) {
  .nx-spin, .nx-wait, .wf.nx-idlewf .hub-inner { animation: none; }
}
```

In `src/canvas/canvas.css`, delete the `/* sphere */` comment and the `.wf .wft { … }` rule under it. Also delete the two lines `.wf:hover .sphere { … }` and `.studio-sel .wf .sphere { … }` from the hover and selection rules (art.css now has them).

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run src/canvas`
Expected: PASS. If `getByText('WORKFLOW')` in the existing `WorkflowCanvas` test still passes, the hub is drawn.

- [ ] **Step 7: Full check and commit**

Run (PowerShell): `npm test; npm run typecheck; npm run build`
Expected: all pass, no React warnings.

```bash
git add src/WorkflowStudio/src/canvas/nodes/WorkflowNode.tsx src/WorkflowStudio/src/canvas/nodes/WorkflowNode.test.tsx src/WorkflowStudio/src/canvas/toFlow.ts src/WorkflowStudio/src/canvas/toFlow.test.ts src/WorkflowStudio/src/canvas/fitText.ts src/WorkflowStudio/src/canvas/art.css src/WorkflowStudio/src/canvas/canvas.css src/WorkflowStudio/src/canvas/WorkflowCanvas.test.tsx
git commit -m "feat(studio): the workflow hub dial, started from the live status, with its cron and state pill" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The cache

The K5a square (v50 `drawCacheTag`, B:911-945; gallery `tabSq`). It has the step's border language: chamfers, a notched top with bars, a notched bottom with lit squares, side ticks and a faint inner outline. Inside, stacked and centred:
- a hex mark;
- the name, wrapped at `-`, `_` and `.` onto at most two lines;
- `CACHE · vX`;
- the root on a plate.

It is static and drawn in the structure white.

**Files:**
- Modify (rewrite): `src/canvas/nodes/CacheNode.tsx`
- Create: `src/canvas/nodes/CacheNode.test.tsx`
- Modify: `src/canvas/toFlow.ts`, `src/canvas/fitText.ts`, `src/canvas/art.css`, `src/canvas/canvas.css`
- Test: `src/canvas/toFlow.test.ts`

**Interfaces:**
- Consumes: `CACHE_FRAME`, `CACHE_FRAME_IN`, `hexPoints`.
- Produces: `CacheNodeData = { lines: string[]; version: string; root: FittedText; plateWidth: number; tooltip: string }`; `FONT.cacheName` (12.5 px), `FONT.cacheRoot`.

- [ ] **Step 1: Write the failing tests**

Create `src/canvas/nodes/CacheNode.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CacheView, type CacheNodeData } from './CacheNode';
import { CACHE_FRAME } from './nxShapes';

const data: CacheNodeData = {
  lines: ['chain-artist-', 'whitelist'],
  version: '1.0.0',
  root: { text: 'chain-artists', full: 'chain-artists', cut: false },
  plateWidth: 100,
  tooltip: 'chain-artist-whitelist 1.0.0\nroot chain-artists',
};

describe('CacheView', () => {
  it('draws the square frame, the hex mark, the name on two lines, CACHE and version, and the root on its plate', () => {
    const { container, getByText } = render(<svg><CacheView {...data} /></svg>);
    expect(container.querySelector('path.nx-brk')!.getAttribute('d')).toBe(CACHE_FRAME);
    expect(container.querySelectorAll('polygon')).toHaveLength(2);
    expect(getByText('chain-artist-').getAttribute('y')).toBe('88');
    expect(getByText('whitelist').getAttribute('y')).toBe('102');
    expect(getByText('CACHE · v1.0.0')).toBeInTheDocument();
    expect(getByText('chain-artists')).toBeInTheDocument();
    const plate = container.querySelector('rect.nx-plate')!;
    expect([plate.getAttribute('x'), plate.getAttribute('width')]).toEqual(['30', '100']);
    expect(container.querySelector('.cachetag > title')!.textContent).toBe('chain-artist-whitelist 1.0.0\nroot chain-artists');
  });

  it('puts a one-line name on the middle line', () => {
    const { getByText } = render(<svg><CacheView {...data} lines={['lookups']} /></svg>);
    expect(getByText('lookups').getAttribute('y')).toBe('95');
  });
});
```

In `src/canvas/toFlow.test.ts`, add:

```ts
  it('wraps a cache name at its separators onto at most two lines, and plates the root (review focus 5)', () => {
    const cacheOf = (name: string, root: string) => {
      const graph = doc({ caches: new Map([['c1', { id: 'c1', name, version: '1.0.0', description: null, root, items: '{}', audit: AUDIT }]]) });
      return toFlow(graph, fitter).nodes.find((n) => n.id === cacheNodeId('c1'))!.data as import('./nodes/CacheNode').CacheNodeData;
    };

    const short = cacheOf('lookups', 'lk');
    expect(short.lines).toEqual(['lookups']);
    expect(short.plateWidth).toBe(2 * 7 + 22);
    expect(short.tooltip).toBe('lookups 1.0.0\nroot lk');

    expect(cacheOf('chain-artist-whitelist', 'chain-artists').lines).toEqual(['chain-artist-', 'whitelist']);

    const long = cacheOf('one-two-three-four-five-six-seven-eight-nine', 'r'.repeat(40));
    expect(long.lines).toHaveLength(2);
    for (const line of long.lines) expect(line.length * 7).toBeLessThanOrEqual(132);
    expect(long.root.cut).toBe(true);
    expect(long.plateWidth).toBe(128);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/canvas`
Expected: FAIL (no `lines`, no `.nx-brk`).

- [ ] **Step 3: Write the cache**

Replace `src/canvas/nodes/CacheNode.tsx` with:

```tsx
import { Fragment } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CACHE_H, CACHE_W } from '../../layout/geometry';
import type { FittedText } from '../fitText';
import { CACHE_FRAME, CACHE_FRAME_IN, hexPoints } from './nxShapes';

export type CacheNodeData = {
  /** The name, wrapped at `-`, `_` and `.` onto one or two lines, each fitted to the frame. */
  lines: string[];
  version: string;
  root: FittedText;
  /** The root plate's width: the root's text plus its margin, never past 128. */
  plateWidth: number;
  tooltip: string;
};
export type CacheNodeType = Node<CacheNodeData, 'cache'>;

const W = CACHE_W, H = CACHE_H, MID = CACHE_W / 2;

/**
 * A cache: a square in the step's border style (spec §5.1; mockup v50 drawCacheTag, gallery K5a).
 * Inside, stacked and centred: a hex mark, the name, CACHE and version, and the root on a plate.
 * Static: a cache is shared data, not a process, so nothing on it moves.
 */
export function CacheView({ lines, version, root, plateWidth, tooltip }: CacheNodeData) {
  const one = lines.length === 1;
  return (
    <g className="cachetag nx">
      <title>{tooltip}</title>
      <path className="nx-bd" d={CACHE_FRAME} />
      <g className="nx-g"><path className="nx-hl nx-brk" d={CACHE_FRAME} /></g>
      <path className="nx-ln nx-d2 nx-thin" d={CACHE_FRAME_IN} />
      {[0, 1, 2, 3].map((i) => <path key={`t${i}`} className="nx-fc nx-g" d={`M${64 + i * 9} 0.5h6l-2 3h-6z`} />)}
      {[0, 1, 2, 3, 4].map((i) => <rect key={`b${i}`} className="nx-fc" x={66 + i * 7} y={155.5} width={3} height={3} />)}
      {[0, 1, 2, 3].map((i) => (
        <Fragment key={`s${i}`}>
          <path className="nx-fc nx-d1" d={`M2 ${66 + i * 7}l3-2v4l-3 2z`} />
          <rect className="nx-fc nx-d1" x={155} y={64 + i * 7} width={3} height={3} />
        </Fragment>
      ))}
      <g className="nx-g"><polygon className="nx-hl nx-bd nx-hex" points={hexPoints(MID, 46, 20)} /></g>
      <g className="nx-g"><polygon className="nx-fh" points={hexPoints(MID, 46, 10)} /></g>
      {lines.map((line, k) => <text key={k} className="nx-cn" x={MID} y={one ? 95 : 88 + k * 14} textAnchor="middle">{line}</text>)}
      <text className="nx-cl" x={MID} y={116} textAnchor="middle">{`CACHE · v${version}`}</text>
      <rect className="nx-bd" x={MID - plateWidth / 2} y={126} width={plateWidth} height={18} rx={3} />
      <rect className="nx-hl nx-g nx-plate" x={MID - plateWidth / 2} y={126} width={plateWidth} height={18} rx={3} />
      <text className="nx-root" x={MID} y={138.5} textAnchor="middle">{root.text}</text>
    </g>
  );
}

export function CacheNode({ data }: NodeProps<CacheNodeType>) {
  return (
    <>
      <Handle id="in" type="target" position={Position.Top} isConnectable={false} />
      <svg width={W} height={H} overflow="visible" style={{ display: 'block' }}>
        <CacheView {...data} />
      </svg>
    </>
  );
}
```

- [ ] **Step 4: Its data and fonts**

In `src/canvas/fitText.ts`, replace `cacheName` and `cacheSub` in `FONT` with:

```ts
  cacheName: `12.5px ${SANS}`,
  cacheRoot: `10px ${MONO}`,
```

In `src/canvas/toFlow.ts`:
- In the cache loop, delete `const count = payloadKeyCount(cache.items);` and replace the `data: { name: …, sub: … }` object with `data: cacheData(cache, fitter),`.
- Add `Cache` to the type import from `../model/graph`.
- Add:

```ts
/** Room inside the cache frame (mockup v50 drawCacheTag): a name line, the root, and the plate. */
const CACHE_NAME_ROOM = 132, CACHE_ROOT_ROOM = 112, PLATE_MAX = 128;

/** The cache's name split after `-`, `_` and `.` onto at most two lines, each fitted; the root fitted to its plate. */
function cacheData(cache: Cache, fitter: TextFitter): CacheNodeData {
  const font = FONT.cacheName;
  const parts: string[] = [];
  let current = '';
  for (const segment of cache.name.split(/(?<=[-_.])/)) {
    if (current && fitter.width(current + segment, font) > CACHE_NAME_ROOM) { parts.push(current); current = segment; }
    else current += segment;
  }
  parts.push(current);
  if (parts.length > 2) parts.splice(1, parts.length - 1, parts.slice(1).join(''));
  const root = fitter.fit(cache.root, CACHE_ROOT_ROOM, FONT.cacheRoot);
  return {
    lines: parts.map((line) => fitter.fit(line, CACHE_NAME_ROOM, font).text),
    version: cache.version,
    root,
    plateWidth: Math.min(PLATE_MAX, fitter.width(root.text, FONT.cacheRoot) + 22),
    tooltip: `${cache.name} ${cache.version}\nroot ${cache.root}`,
  };
}
```

- Change the type import of the cache node to `import type { CacheNodeData, CacheNodeType } from './nodes/CacheNode';`.
- `payloadKeyCount` is still used by `badge`; keep its import.

- [ ] **Step 5: Its styles, and the plan-2 cache rules go**

Append to `src/canvas/art.css`, before the `@media` block:

```css
/* cache: static, structure white */
.cachetag .nx-brk { stroke-width: 1.1; }
.cachetag .nx-thin { stroke-width: 1; }
.cachetag .nx-hex { stroke-width: 1.2; }
.cachetag .nx-plate { stroke-width: .9; }
.cachetag .nx-cn { font: 400 12.5px var(--sans); fill: #F4F9FF; }
.cachetag .nx-cl { font: 400 8px var(--mono); fill: var(--nh); letter-spacing: .2em; }
.cachetag .nx-root { font: 400 10px var(--mono); fill: var(--nh); }
.cachetag.nx:hover .nx-brk { stroke-width: 1.6; }
.studio-sel .cachetag.nx .nx-brk { stroke: var(--accent); stroke-width: 1.8; }
```

In `src/canvas/canvas.css`:
- Delete the `/* cache shell … */` block (its six `.cachetag …` rules), but keep the `.badge` rule.
- Delete the remaining three cache lines of the hover and selection rules (`.cachetag:hover .cap`, `.studio-sel .cachetag .rimr`, `.studio-sel .cachetag .shell`) and the now-empty `/* hover and selection … */` comment.

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run src/canvas`
Expected: PASS.

- [ ] **Step 7: Full check and commit**

Run (PowerShell): `npm test; npm run typecheck; npm run build`
Expected: all pass, no React warnings.

```bash
git add src/WorkflowStudio/src/canvas/nodes/CacheNode.tsx src/WorkflowStudio/src/canvas/nodes/CacheNode.test.tsx src/WorkflowStudio/src/canvas/toFlow.ts src/WorkflowStudio/src/canvas/toFlow.test.ts src/WorkflowStudio/src/canvas/fitText.ts src/WorkflowStudio/src/canvas/art.css src/WorkflowStudio/src/canvas/canvas.css
git commit -m "feat(studio): the locked square cache with its hex mark, wrapped name and root plate" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Lines and arrows

Each wire is a circuit trace with right-angle bends (gallery `trace90`, G:924-931; v50 `cable`, B:1018-1045):
- a small dark ring at the source and an open chevron head whose tip is the landing point;
- the colour of the target's entry condition, with a glow.

A **broken** wire is dashed `6 4`, with a soft transparent gap cut by a mask at the middle of its longest segment and an amber ⚠ in the gap. **Flowing** (workflow started, wire not broken): a pulse runs toward the target, staggered by −0.41 s per wire.

**Files:**
- Modify (rewrite): `src/canvas/edges/CableEdge.tsx`
- Test (rewrite): `src/canvas/edges/CableEdge.test.tsx`
- Modify: `src/canvas/toFlow.ts`, `src/canvas/art.css`, `src/canvas/canvas.css`
- Test: `src/canvas/toFlow.test.ts`

**Interfaces:**
- Consumes: `useLiveArt()`, `pathOf`, `longestSegmentMiddle` (`canvas/svgPath.ts`).
- Produces: `CableEdgeData = { points: Pt[]; colour: string; broken: boolean; delay: number }`; `CableEdgeView` props `CableEdgeData & { flowing: boolean }`.

- [ ] **Step 1: Write the failing tests**

Replace `src/canvas/edges/CableEdge.test.tsx` with:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CableEdgeView } from './CableEdge';

describe('CableEdgeView', () => {
  it('draws the trace, a ring at the source and an open chevron whose tip is the landing', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" broken={false} delay={0} flowing={false} /></svg>);

    expect(container.querySelector('path.w')!.getAttribute('d')).toBe('M0 8 L64 8');
    expect(container.querySelector('path.w')!.getAttribute('stroke')).toBe('#2DD4BF');
    expect(container.querySelector('.nx-head')!.getAttribute('d')).toBe('M55 2L64 8L55 14');
    const src = container.querySelector('circle.nx-src')!;
    expect([src.getAttribute('cx'), src.getAttribute('cy')]).toEqual(['0', '8']);
    expect(container.querySelector('.wire')!.classList.contains('broken')).toBe(false);
  });

  it('pulses toward the target only while flowing, with its stagger', () => {
    const still = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" broken={false} delay={-0.82} flowing={false} /></svg>);
    expect(still.container.querySelector('.nx-pulse')).toBeNull();

    const flowing = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" broken={false} delay={-0.82} flowing /></svg>);
    const pulse = flowing.container.querySelector('.nx-pulse') as SVGPathElement;
    expect(pulse.getAttribute('d')).toBe('M0 8 L64 8');
    expect(pulse.style.animationDelay).toBe('-0.82s');
  });

  it('dashes a broken wire, cuts a gap at the middle of its longest segment, puts ⚠ in it, and never pulses', () => {
    const { container, getByText } = render(
      <svg><CableEdgeView points={[[0, 0], [16, 0], [16, 96], [32, 96]]} colour="#FF7A66" broken delay={0} flowing /></svg>,
    );

    expect(container.querySelector('.wire')!.classList.contains('broken')).toBe(true);
    const warn = getByText('⚠');
    expect([warn.getAttribute('x'), warn.getAttribute('y')]).toEqual(['16', '53']);
    const hole = container.querySelector('mask rect[fill="#000"]')!;
    expect([hole.getAttribute('x'), hole.getAttribute('y')]).toEqual(['6', '41']);
    const mask = container.querySelector('mask')!;
    expect(container.querySelector('path.w')!.closest('g[mask]')!.getAttribute('mask')).toBe(`url(#${mask.id})`);
    expect(container.querySelector('.nx-pulse')).toBeNull();
  });

  it('gives every broken wire its own gap mask (review focus 4)', () => {
    const { container } = render(
      <svg>
        <CableEdgeView points={[[0, 0], [64, 0]]} colour="#FF7A66" broken delay={0} flowing={false} />
        <CableEdgeView points={[[0, 40], [64, 40]]} colour="#FF7A66" broken delay={0} flowing={false} />
      </svg>,
    );
    const ids = [...container.querySelectorAll('mask')].map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
```

In `src/canvas/toFlow.test.ts`, in `'turns wires into cable edges …'`, replace the `ab.data` expectation with:

```ts
    expect(ab.data).toEqual({ points: [[512, 128], [576, 128]], colour: '#FF7A66', broken: true, delay: -0.41 });
    expect(edges.find((e) => e.id === 'wf->a')!.data).toMatchObject({ delay: 0 });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/canvas`
Expected: FAIL (no `.nx-head`, no `delay`).

- [ ] **Step 3: Write the wire**

Replace `src/canvas/edges/CableEdge.tsx` with:

```tsx
import { useId, type CSSProperties } from 'react';
import type { Edge, EdgeProps } from '@xyflow/react';
import type { Pt } from '../../layout/router';
import { useLiveArt } from '../liveArt';
import { longestSegmentMiddle, pathOf } from '../svgPath';

export type CableEdgeData = {
  points: Pt[];
  colour: string;
  broken: boolean;
  /** The pulse's animation delay in seconds (≤ 0), so the wires do not pulse in step. */
  delay: number;
};
export type CableEdgeType = Edge<CableEdgeData, 'cable'>;

/**
 * One wire as a circuit trace (spec §5.1; gallery trace90, mockup v50 cable): right-angled, a ring at
 * the source, an open chevron whose tip is the landing point, in the target's entry-condition colour.
 * Broken: dashed, with a soft transparent gap cut at the middle of the longest segment and ⚠ in it.
 * While `flowing` (the workflow is started) an intact wire carries a pulse toward its target.
 */
export function CableEdgeView({ points, colour, broken, delay, flowing }: CableEdgeData & { flowing: boolean }) {
  const gap = `nxgap${useId().replace(/[^\w-]/g, '')}`;
  const d = pathOf(points);
  const [sx, sy] = points[0]!;
  const [tx, ty] = points[points.length - 1]!;
  const mark = broken ? longestSegmentMiddle(points) : null;

  const trace = (
    <>
      <circle className="nx-src" cx={sx} cy={sy} r={2.6} />
      <path className="w" d={d} stroke={colour} />
      <path className="nx-head" d={`M${tx - 9} ${ty - 6}L${tx} ${ty}L${tx - 9} ${ty + 6}`} stroke={colour} />
    </>
  );

  return (
    <g className={broken ? 'wire broken' : 'wire'} style={{ '--nc': colour } as CSSProperties}>
      {mark ? (
        <>
          <defs>
            <filter id={`${gap}s`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={3} /></filter>
            <mask id={gap} maskUnits="userSpaceOnUse" x={-1e5} y={-1e5} width={2e5} height={2e5}>
              <rect x={-1e5} y={-1e5} width={2e5} height={2e5} fill="#fff" />
              <rect x={mark[0] - 10} y={mark[1] - 7} width={20} height={14} rx={5} fill="#000" filter={`url(#${gap}s)`} />
            </mask>
          </defs>
          <g mask={`url(#${gap})`}>{trace}</g>
          <text className="nx-warn" x={mark[0]} y={mark[1] + 5} textAnchor="middle">⚠</text>
        </>
      ) : trace}
      {flowing && !broken && <path className="nx-pulse" d={d} style={{ animationDelay: `${delay}s` }} />}
    </g>
  );
}

export function CableEdge({ data }: EdgeProps<CableEdgeType>) {
  const { started } = useLiveArt();
  return data ? <CableEdgeView {...data} flowing={started} /> : null;
}
```

In `src/canvas/toFlow.ts`, change the wire edges to carry the stagger:

```ts
  const edges: StudioEdge[] = wires.map((w, i) => ({
    id: w.id, type: 'cable', source: w.source === WORKFLOW_SOURCE ? SPHERE_NODE_ID : w.source, target: w.target,
    sourceHandle: 'out', targetHandle: 'in', selectable: false, focusable: false,
    // the gallery staggers its pulses by 0.41 s a wire; `|| 0` keeps the first one at +0, not −0
    data: { points: w.points, colour: conditionInfo(w.condition).colour, broken: w.broken, delay: -Math.round(i * 41) / 100 || 0 },
  }));
```

- [ ] **Step 4: Its styles, and the plan-2 cable rules go**

Append to `src/canvas/art.css`, before the `@media` block:

```css
/* wires: right-angle circuit traces in the target's entry-condition colour (--nc, set per wire) */
.wire path.w { fill: none; stroke-width: 1.8; stroke-linejoin: miter; stroke-linecap: square; filter: drop-shadow(0 0 2px var(--nc)) drop-shadow(0 0 5px var(--nc)); }
.wire:hover path.w { stroke-width: 2.4; }
.wire.broken path.w { stroke-dasharray: 6 4; }
.wire .nx-head { fill: none; stroke-width: 2.2; stroke-linejoin: miter; filter: drop-shadow(0 0 3px var(--nc)); pointer-events: none; }
.wire .nx-src { fill: #060c17; stroke: var(--nc); stroke-width: 1.4; pointer-events: none; }
.wire .nx-warn { font: 600 13px var(--sans); fill: var(--warn); }
.nx-pulse { fill: none; stroke: #e8f8ff; stroke-width: 2.2; stroke-linecap: round; stroke-dasharray: 5 300; animation: nxrun 2.8s linear infinite; pointer-events: none; }
@keyframes nxrun { from { stroke-dashoffset: 305; } to { stroke-dashoffset: 0; } }
```

and change the reduced-motion block to:

```css
@media (prefers-reduced-motion: reduce) {
  .nx-spin, .nx-wait, .wf.nx-idlewf .hub-inner { animation: none; }
  .nx-pulse { display: none; }
}
```

In `src/canvas/canvas.css`, replace the `/* wires */` comment and the ten rules under it (`.wire path.w` through `.tether`) with:

```css
/* the dashed tether from the hub to a cache */
.tether { fill: none; stroke: var(--line-2); stroke-width: 1.2; stroke-dasharray: 3 4; }
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/canvas`
Expected: PASS. The existing `WorkflowCanvas` test still finds two `.wire` groups.

- [ ] **Step 6: Full check and commit**

Run (PowerShell): `npm test; npm run typecheck; npm run build`
Expected: all pass, no React warnings.

```bash
git add src/WorkflowStudio/src/canvas/edges/CableEdge.tsx src/WorkflowStudio/src/canvas/edges/CableEdge.test.tsx src/WorkflowStudio/src/canvas/toFlow.ts src/WorkflowStudio/src/canvas/toFlow.test.ts src/WorkflowStudio/src/canvas/art.css src/WorkflowStudio/src/canvas/canvas.css
git commit -m "feat(studio): wires as circuit traces with a chevron head, a soft broken gap, and pulses while started" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Legend, selection merge and cleanup

The legend's icons must match the canvas (spec §5.1):
- for each condition, its letter pill and a short trace with a source ring and chevron;
- broken: grey dashes `3 2` around an amber ⚠;
- parked: a dashed notched frame.

Also in this task:
- `withSelection` keeps a node's own `className` (a deferred plan-3a minor that 3c's node redraw needs).
- The plan-2 gradients and filters nothing references any more are deleted.
- The pop-out e2e checks the new defs.

**Files:**
- Modify (rewrite): `src/canvas/Legend.tsx`
- Create: `src/canvas/Legend.test.tsx`
- Modify: `src/canvas/selection.ts`, `src/canvas/selection.test.ts`
- Modify: `src/canvas/SvgDefs.tsx`, `src/canvas/art.css`, `src/canvas/canvas.css`
- Modify: `e2e/dock.spec.ts` (the pop-out test's defs line)

**Interfaces:**
- Consumes: `CONDITIONS` (`model/entryConditions.ts`).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Create `src/canvas/Legend.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CONDITIONS } from '../model/entryConditions';
import { Legend } from './Legend';

describe('Legend', () => {
  it('shows each entry condition as its pill and a trace in its colour, ending in a chevron', () => {
    const { container, getByText } = render(<Legend />);
    for (const c of CONDITIONS) {
      expect(getByText(c.name)).toBeInTheDocument();
      const item = getByText(c.name).closest('.lg-item')!;
      expect(item.querySelector('.pill')!.textContent).toBe(c.letter);
      expect(item.querySelector('.lg-w')!.getAttribute('stroke')).toBe(c.colour);
      expect(item.querySelector('.lg-head')).not.toBeNull();
    }
    expect(container.querySelectorAll('.lg-item')).toHaveLength(CONDITIONS.length + 2);
  });

  it('shows broken as grey dashes around the amber warning, and parked as a dashed notched frame', () => {
    const { getByText } = render(<Legend />);
    const broken = getByText('broken').closest('.lg-item')!;
    expect(broken.querySelector('.lg-dash')).not.toBeNull();
    expect(broken.querySelector('.lg-warn')!.textContent).toBe('⚠');
    expect(getByText('parked').closest('.lg-item')!.querySelector('.lg-parked')).not.toBeNull();
  });
});
```

In `src/canvas/selection.test.ts`, add inside the `withSelection` describe (create one if the file has none, importing `withSelection` and `type StudioNode`):

```ts
  it('keeps a node class it already had beside the selection class', () => {
    const nodes = [{ id: 's1', type: 'step', position: { x: 0, y: 0 }, className: 'mine', data: {} }] as unknown as StudioNode[];
    expect(withSelection(nodes, { kind: 'step', stepId: 's1' })[0]!.className).toBe('mine studio-sel');
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/canvas/Legend.test.tsx src/canvas/selection.test.ts`
Expected: FAIL (no `.lg-item`; `className` is `studio-sel`).

- [ ] **Step 3: Write the legend and the merge**

Replace `src/canvas/Legend.tsx` with:

```tsx
import type { CSSProperties } from 'react';
import { CONDITIONS } from '../model/entryConditions';

/** The colour key (spec §5.1, §5.3): icons drawn like the canvas. Junctions join it with plan 7. */
export function Legend() {
  return (
    <div className="legend">
      {CONDITIONS.map((c) => (
        <span key={c.value} className="lg-item">
          <span className="pill" style={{ background: c.colour }}>{c.letter}</span>
          <svg width="26" height="12" viewBox="0 0 26 12" className="lg-icon" style={{ '--nc': c.colour } as CSSProperties} aria-hidden="true">
            <circle className="lg-src" cx="3" cy="6" r="2" />
            <path className="lg-w" d="M5 6H23" stroke={c.colour} />
            <path className="lg-head" d="M18 2.5L23 6L18 9.5" stroke={c.colour} />
          </svg>
          {c.name}
        </span>
      ))}
      <span className="lg-item" title={'Broken wire: Out schema ≠ In schema.\nAny wire can break, whatever its colour.'}>
        <svg width="30" height="14" viewBox="0 0 30 14" className="lg-icon" aria-hidden="true">
          <path className="lg-dash" d="M1 7H10 M20 7H29" />
          <text className="lg-warn" x="15" y="11" textAnchor="middle">⚠</text>
        </svg>
        broken
      </span>
      <span className="lg-item" title={'Parked step: placed but not wired in,\nso not part of the workflow.'}>
        <svg width="22" height="16" viewBox="0 0 22 16" className="lg-icon" aria-hidden="true">
          <path className="lg-parked" d="M3 1H8L9 2H13L14 1H19L21 3V13L19 15H14L13 14H9L8 15H3L1 13V3Z" />
        </svg>
        parked
      </span>
    </div>
  );
}
```

In `src/canvas/selection.ts`, replace the last line of `withSelection` with:

```ts
  return nodes.map((n) => (n.id === id ? { ...n, className: n.className ? `${n.className} ${className}` : className } : n));
```

Append to `src/canvas/art.css`, before the `@media` block:

```css
/* legend icons, drawn like the canvas */
.legend .lg-icon { vertical-align: middle; margin-right: 6px; overflow: visible; }
.legend .lg-src { fill: #060c17; stroke: var(--nc); stroke-width: 1.2; }
.legend .lg-w { fill: none; stroke-width: 1.8; filter: drop-shadow(0 0 2px var(--nc)); }
.legend .lg-head { fill: none; stroke-width: 1.8; stroke-linejoin: miter; }
.legend .lg-dash { fill: none; stroke: #9FB0C8; stroke-width: 1.8; stroke-dasharray: 3 2; }
.legend .lg-warn { font: 600 11px var(--sans); fill: var(--warn); }
.legend .lg-parked { fill: none; stroke: #6B7A90; stroke-width: 1.2; stroke-dasharray: 2.5 1.5; }
```

In `src/canvas/canvas.css`, delete the rule `.legend i { … }`.

- [ ] **Step 4: Delete the dead defs**

In `src/canvas/SvgDefs.tsx`, keep only the `nxCap` gradient and the `glow` filter (with their comments). Delete `wfBody`, `wfShade`, `wfRim`, `wfSpec`, `wfShadow`, `wfHalo`, `capfill`, `darkbody`, `rimline`, `glint`, `drum`, `drumTop`, `chipRim`, `substrate`, `dieFill`, `soft`, `pinGlow` and `wsoft`. Update the component's comment to:

```tsx
/**
 * The gradient and filter the art shares, defined once per window (the main page and each pop-out):
 * the step cap's gloss and the selection glow. The ids are document-global, so nothing else may
 * define them.
 */
```

Before deleting, confirm nothing references the dead ids (from `src/WorkflowStudio`):

Run (PowerShell): `Select-String -Path src/**/*.tsx, src/**/*.ts, src/**/*.css -Pattern 'url\(#(wf|capfill|darkbody|rimline|glint|drum|chipRim|substrate|dieFill|soft|pinGlow|wsoft)'`
Expected: no matches.

In `e2e/dock.spec.ts`, in the pop-out test, change the defs check to:

```ts
  expect(await popup.evaluate(() => !!document.getElementById('glow') && !!document.getElementById('nxCap'))).toBe(true);
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run src/canvas`
Expected: PASS.

- [ ] **Step 6: Full check, e2e and commit**

Run (PowerShell): `npm test; npm run typecheck; npm run build; npm run e2e`
Expected: all pass. e2e 19/19 (the pop-out test now checks `nxCap`; the background-document test still finds every node of the hidden document hidden).

```bash
git add src/WorkflowStudio/src/canvas/Legend.tsx src/WorkflowStudio/src/canvas/Legend.test.tsx src/WorkflowStudio/src/canvas/selection.ts src/WorkflowStudio/src/canvas/selection.test.ts src/WorkflowStudio/src/canvas/SvgDefs.tsx src/WorkflowStudio/src/canvas/art.css src/WorkflowStudio/src/canvas/canvas.css src/WorkflowStudio/e2e/dock.spec.ts
git commit -m "feat(studio): a legend drawn like the canvas; drop the plan-2 defs; keep a node's own class when selected" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end tests for the live states

These run against the live BaseApi, read-only (only GETs; the read-only guard in `e2e/studio.ts` applies). The live data decides which workflows are running, so a test that needs a running (or idle) workflow skips with a reason when there is none.

**Files:**
- Modify: `e2e/studio.ts`
- Create: `e2e/art.spec.ts`

**Interfaces:**
- Produces: `workflowsWithSteps(request): Promise<LiveWorkflow[]>` in `e2e/studio.ts` (`liveWorkflows` keeps its signature and uses it).

- [ ] **Step 1: A helper for every workflow with steps**

In `e2e/studio.ts`, replace `liveWorkflows` (and its doc comment) with:

```ts
/** Every workflow with a step, each with a distinct name that is not a tool window's. Read-only. */
export async function workflowsWithSteps(request: APIRequestContext): Promise<LiveWorkflow[]> {
  const list = await request.get('/api/v1/workflows');
  expect(list.ok()).toBe(true);
  const found: LiveWorkflow[] = [];
  const names = new Set<string>(TOOL_NAMES);
  for (const w of (await list.json()) as { id: string; name: string; version: string }[]) {
    if (names.has(w.name)) continue;
    const graph = await request.get(`/api/v1/workflows/${w.id}/graph`);
    if (graph.ok() && ((await graph.json()) as { steps?: unknown[] }).steps?.length) {
      names.add(w.name);
      found.push({ id: w.id, name: w.name, version: w.version, label: label(w.name, w.version, w.id) });
    }
  }
  return found;
}

/** `count` workflows with distinct names (and none named like a tool window) that have a step. Read-only. */
export async function liveWorkflows(request: APIRequestContext, count: number): Promise<LiveWorkflow[]> {
  const found = await workflowsWithSteps(request);
  if (found.length < count) throw new Error(`BaseApi has fewer than ${count} workflows with steps and distinct names`);
  return found.slice(0, count);
}
```

- [ ] **Step 2: Write the art tests**

Create `e2e/art.spec.ts`:

```ts
import type { APIRequestContext, Page } from '@playwright/test';
import { documentPanel, expect, openWorkflow, test, workflowsWithSteps, type LiveWorkflow } from './studio';

// Spec §5.1, slice 3c: the live states against the live BaseApi. Read-only: GETs only.
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

/** One running and one idle workflow (either may be null), by `GET /orchestration/live`. */
async function runningAndIdle(request: APIRequestContext): Promise<{ running: LiveWorkflow | null; idle: LiveWorkflow | null }> {
  const live = await request.get('/api/v1/orchestration/live');
  expect(live.ok()).toBe(true);
  const ids = new Set(((await live.json()) as string[]).map((s) => s.toLowerCase()));
  const all = await workflowsWithSteps(request);
  return {
    running: all.find((w) => ids.has(w.id.toLowerCase())) ?? null,
    idle: all.find((w) => !ids.has(w.id.toLowerCase())) ?? null,
  };
}

async function liveness(request: APIRequestContext): Promise<Map<string, string>> {
  const res = await request.get('/api/v1/processors/liveness');
  expect(res.ok()).toBe(true);
  return new Map(((await res.json()) as { processorId: string; live: boolean }[])
    .map((p) => [p.processorId.toLowerCase(), p.live ? 'healthy' : 'unhealthy']));
}

async function open(page: Page, wf: LiveWorkflow) {
  await openWorkflow(page, wf);
  return documentPanel(page, wf);
}

test('every processor shows the health BaseApi reports for it', async ({ page, request }) => {
  const [wf] = await workflowsWithSteps(request);
  const panel = await open(page, wf!);
  const verdicts = await liveness(request);

  const chips = panel.locator('.react-flow__node-step .chipg');
  expect(await chips.count()).toBeGreaterThan(0);
  for (const chip of await chips.all()) {
    const id = (await chip.getAttribute('data-processor')) ?? '';
    await expect(chip.locator('.nx-health')).toHaveAttribute('data-health', verdicts.get(id.toLowerCase()) ?? 'undetermined');
  }
});

test('a running workflow is started and its intact wires pulse; an idle one is still', async ({ page, request }) => {
  const { running, idle } = await runningAndIdle(request);
  test.skip(!running && !idle, 'BaseApi has no workflow with steps');

  if (running) {
    const panel = await open(page, running);
    await expect(panel.locator('.wf')).toHaveAttribute('data-started', 'true');
    const intact = panel.locator('.react-flow__edge .wire:not(.broken)');
    await expect.poll(() => panel.locator('.nx-pulse').count()).toBe(await intact.count());
    expect(await intact.count()).toBeGreaterThan(0);
  }
  if (idle) {
    const panel = await open(page, idle);
    await expect(panel.locator('.wf')).toHaveAttribute('data-started', 'false');
    await expect(panel.locator('.wf')).toHaveClass(/nx-idlewf/);
    await expect(panel.locator('.nx-pulse')).toHaveCount(0);
  }
});

test('with reduced motion nothing spins, blinks or pulses', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { running, idle } = await runningAndIdle(request);
  const wf = running ?? idle;
  test.skip(!wf, 'BaseApi has no workflow with steps');
  const panel = await open(page, wf!);

  const animation = (selector: string) => panel.locator(selector).first().evaluate((e) => getComputedStyle(e).animationName);
  await expect.poll(() => animation('.chipg .nx-spin')).toBe('none');
  await expect.poll(() => animation('.wf .hub-inner')).toBe('none');
  for (const pulse of await panel.locator('.nx-pulse').all()) {
    expect(await pulse.evaluate((e) => getComputedStyle(e).display)).toBe('none');
  }
  for (const wait of await panel.locator('.nx-wait').all()) {
    expect(await wait.evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
  }
});

test('a selected step, die and cache draw the cyan selection stroke', async ({ page, request }) => {
  const [wf] = await workflowsWithSteps(request);
  const panel = await open(page, wf!);
  const cyan = 'rgb(125, 211, 252)';
  const stroke = (selector: string) => panel.locator(selector).first().evaluate((e) => getComputedStyle(e).stroke);

  await panel.locator('.react-flow__node-step').first().click({ position: { x: 20, y: 12 } });
  await expect.poll(() => stroke('.studio-sel .nx-frame')).toBe(cyan);

  await panel.locator('.react-flow__node-step .chipg').first().click();
  await expect.poll(() => stroke('.studio-die-sel .nx-panel')).toBe(cyan);

  const cache = panel.locator('.react-flow__node-cache');
  test.skip((await cache.count()) === 0, 'the first live workflow has no cache');
  await cache.first().click();
  await expect.poll(() => stroke('.studio-sel .nx-brk')).toBe(cyan);
});
```

- [ ] **Step 3: Run the e2e suite**

Run (PowerShell): `npm run e2e`
Expected: 23 tests. All pass, or skip with the reason given when the live data has no running, idle or cache case. Report which tests skipped.

If a health assertion fails because a processor's liveness changed between the test's read and the page's poll, re-run once. A second failure is a real defect.

- [ ] **Step 4: Commit**

```bash
git add src/WorkflowStudio/e2e/studio.ts src/WorkflowStudio/e2e/art.spec.ts
git commit -m "test(studio): e2e for processor health, the started hub and pulses, reduced motion and the art's selection" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Deploy and visual check (ask first)

**Ask the user before deploying.** It restarts the `workflow-studio` pod on the shared `desktop` cluster; BaseApi is not touched.

- [ ] **Step 1: Deploy (after approval)**

From the repository root (PowerShell):

```powershell
docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
kind load docker-image workflow-studio:local --name desktop
kubectl -n skp rollout restart deploy/workflow-studio
kubectl -n skp rollout status deploy/workflow-studio --timeout=180s
```

The port-forward on 18081 reconnects by itself a few seconds after the restart. Confirm the served bundle matches the local build: the `assets/index-*.js` name in `http://localhost:18081`'s HTML is the one in `src/WorkflowStudio/dist/assets`.

- [ ] **Step 2: Visual check against the gallery**

Open `http://localhost:18081` (chrome-devtools MCP with an `isolatedContext`). Then:
1. Open `filefetcher-archiveexpander-chain` (running) and one idle workflow.
2. Zoom in to about 100% on a step, the hub and a cache.
3. Compare each with `skp-studio-node-art-final.html`:
   - the step frame, cap and processor ring in each health state;
   - the hub started and not started;
   - the cache at 100% and at 30%;
   - the traces, the broken gap and the pulses.
4. Turn on reduced motion (DevTools rendering emulation) and confirm nothing moves.

Note every visible difference and whether it is a deliberate decision (see "Decisions this plan makes") or a defect. Then open the studio for the user with `Start-Process http://localhost:18081`.

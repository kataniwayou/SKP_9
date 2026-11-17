# Acto Plan 4 — Chat, Themes, Deployment, Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Acto as WorkflowStudio's replacement: frames appear as their graphs load, light and dark themes, the
Chat pane with tools that follow Acto's rules, an nginx image and a `k8s` manifest, and the hand-over from
WorkflowStudio.

**Architecture:** The chat's model client, store, pane and tool loop are ported from WorkflowStudio `src/chat/` almost
unchanged; only the tool layer is rewritten, because WorkflowStudio's tools drive its `StudioStore` while Acto's drive
`BoardStore` and the `operate/*` functions. Every tool acts through the same store calls as the user's gestures, so the
chat and the user share each workflow's undo history. Deployment copies WorkflowStudio's Dockerfile/nginx template.

**Tech Stack:** as Plans 1–3 — React 19, `@xyflow/react` 12.12, Vitest + Testing Library (`fireEvent`), Playwright;
nginx 1.29 (alpine) image built offline from `Studio-offline/npm-offline`.

**Spec:** `docs/superpowers/specs/2026-11-17-acto-design.md` (§4 themes, §5 loading, §11 Chat, §3 serving, §13
transition, §14 testing) · Plans 1–3 in `docs/superpowers/plans/2026-11-17-acto-{1-board-viewer,2-designing,3-operating}.md`
· WorkflowStudio sources: `src/WorkflowStudio/src/chat/**`, `src/app/theme.ts`, `src/canvas/tokens.css`,
`vite.config.ts` (`/ai` dev proxy), `nginx.conf`, `Dockerfile`; `k8s/31-workflow-studio.yaml`.

**Already done (do not redo):** spec §13 step 1 — WorkflowStudio keeps `board` when it saves (Plan 1 Task 1, b6c6394d).

## Global Constraints

- Everything in Plans 1–3's Global Constraints still holds (paths, deps, one trigger per action, no keyboard hints,
  Undo/Redo only in the Inspector header + Ctrl+Z/Y, `fireEvent`, try/catch storage).
- No new npm dependencies. Chat talks to the model only through same-origin `/ai/config` and `/ai/chat/completions`
  (key stays in nginx; the dev server proxies `/ai` like WorkflowStudio's `vite.config.ts`).
- Chat header [user]: **New chat**, plus **Stop** only while answering. No other header buttons.
- Chat tools [spec §11]: removed `open_workflow`, `close_workflow`, `activate`, `revert_entity`, `join`, `reset_route`,
  `shape_wire`, `auto_connect`; every tool that acts on a workflow takes `workflow_id`; `add_step` must name a
  processor; `undo`/`redo` tools act on a workflow's history (fields included); `new_workflow` places a frame on free
  board; the board scrolls to what the chat changed. Destructive tools ask first: `stop`, `delete_workflow`,
  `delete_picked`, `remove_assignment`.
- Storage keys: theme `acto.theme` (localStorage); chat `acto.chat` (sessionStorage, mirrored to localStorage, as
  WorkflowStudio's `skp.studio.chat`); prompt history `acto.chat.history` (localStorage).
- Theme: **light by default** (the approved mock is light); dark from WorkflowStudio's palette. The toggle is one
  topbar button reading `Dark` / `Light` (the theme it switches to).
- Image: `acto:local`, port 8080, `/healthz` → 200 `ok`, envs `BASEAPI_URL`, `KIMI_BASE_URL`, `KIMI_MODEL_ID`,
  `KIMI_API_KEY` (same meaning as WorkflowStudio's). Manifest `k8s/47-acto.yaml`, Service/Deployment `acto`,
  namespace `skp`; local port-forward **18083**.

## Review Focus

1. **The model calls a tool while the user is editing the same workflow** — the tool acts on the store as it is now;
   a refusal (save lock, shared lock) comes back to the model as a failed result naming the reason, never a crash.
   Test in Task 4.
2. **Chat not configured** (`/ai/config` → 503) — the pane shows WorkflowStudio's "not configured" line and the board
   is unaffected. Test in Task 3.
3. **A tool names a workflow id that is gone or never existed** — failed result `no workflow <id> on the board`, no
   side effect. Test in Task 4.
4. **Theme switch with an open toolbar, selection bar and minimap** — every surface follows (no white panel left in
   dark). Test in Task 2 (token coverage check).
5. **A workflow whose graph read fails while others load** — the others still appear one by one; the failure line
   appears; drafts for the failed one are kept for later. Test in Task 1.

---

### Task 1: Frames appear as their graphs arrive

**Files:**
- Modify: `src/Acto/src/board/loadBoard.ts`, `design/boardStore.ts`, `App.tsx` (+ tests)

**Interfaces:**
- Produces:
  ```ts
  export async function loadBoard(api: StudioApi, concurrency?: number,
    onWorkflow?: (bw: BoardWorkflow) => void): Promise<BoardLoad>;     // calls onWorkflow as each graph is placed
  // BoardStore:
  begin(processors: Processor[]): void;     // clears the board, reads drafts once, keeps them pending
  arrive(bw: BoardWorkflow): void;          // adds one workflow, applying its draft / stored design exactly as load() does
  finish(load: BoardLoad): void;            // new-workflow drafts become frames; drafts for workflows not loaded are kept
  ```
  `load(board, procs)` stays as `begin` + `arrive` each + `finish` (existing tests keep passing).
- Placement: a frame without a stored `board` is placed when it arrives, in the first free slot after those already
  on the board (same flow and sizes as `placeFrames`); the final positions may differ from a one-shot `placeFrames`
  only for workflows that had no stored position.

- [ ] **Step 1: Failing tests** — loadBoard: with a fake api whose `getGraph` resolves w2 before w1, `onWorkflow` is
  called twice, w2 first, and the final `BoardLoad` equals the one-shot result for workflows with stored frames.
  Store: `begin`, `arrive(w1)` → `boards()` has 1 frame and w1's draft applied; `arrive(w2)`; `finish` → a new-workflow
  draft appears; a draft for w3 (failed to load) is still in `acto.drafts`. App: "Loading the board…" is replaced by
  the board as soon as the first workflow arrives (Review Focus 5: one graph read fails → the other frame shows and
  `Could not load <name>: …` is logged).
- [ ] **Step 2: Run** `npx vitest run src/board src/design src/App.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** The first-load view fit (no saved view) runs after `finish`.
- [ ] **Step 4: Run** → PASS; full suite + `npx tsc --noEmit` green.
- [ ] **Step 5: Commit** — `feat(acto): frames appear as their graphs arrive`.

### Task 2: Light and dark themes

**Files:**
- Create: `src/Acto/src/shell/theme.ts` (+ test), `src/Acto/src/tokens.css`
- Modify: `src/Acto/src/app.css`, `board/board.css`, every other `*.css` under `src/Acto/src` that has a literal
  colour, `shell/Shell.tsx` or `App.tsx` (topbar toggle), `main.tsx` (apply before first paint)

**Interfaces:**
- Produces (port of WorkflowStudio `src/app/theme.ts`, key and default changed):
  ```ts
  export type Theme = 'dark' | 'light';
  export function savedTheme(storage?: Pick<Storage, 'getItem'> | null): Theme;   // 'light' unless 'dark' was saved
  export function saveTheme(theme: Theme, storage?: Pick<Storage, 'setItem'> | null): void;
  export function applyTheme(theme: Theme, doc?: Document): void;   // sets html[data-theme] and color-scheme
  ```
  `tokens.css` defines every colour as a CSS variable under `:root, [data-theme="light"]` and `[data-theme="dark"]`
  (dark values from WorkflowStudio `src/canvas/tokens.css`); the entry-condition and state colours (Plan 1) stay the
  same in both themes.

- [ ] **Step 1: Failing tests** — theme: default `light`; saved `dark` → `dark`; throwing storage → `light`;
  `applyTheme('dark')` sets `data-theme="dark"`. A token-coverage test (Review Focus 4) reads every `.css` file under
  `src/Acto/src` except `tokens.css` and fails on any literal `#hex`, `rgb(`/`rgba(` or named colour outside a
  `var(--…, fallback)` — except the documented constant colours (entry conditions, state, accent `#FF0072`) listed in
  the test. App: the topbar button reads `Dark`; clicking it sets `data-theme="dark"`, saves `acto.theme`, and now reads
  `Light`.
- [ ] **Step 2: Run** `npx vitest run src/shell src/App.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** React Flow's own colours (`--xy-*` variables, minimap mask, controls) are set from tokens
  too; the board's dotted paper uses `--board-bg` / `--board-dot`.
- [ ] **Step 4: Run** → PASS; full suite + tsc green.
- [ ] **Step 5: Commit** — `feat(acto): light and dark themes`.

### Task 3: The chat pane, model client and tool loop

**Files:**
- Create (ported from `src/WorkflowStudio/src/chat/`, tests with them): `src/Acto/src/chat/{kimi,chatStore,history,
  StatusLine,ChatPane,useChat,runTool,toolTypes,tools,prompt}.ts(x)`, `chat/chat.css`
- Modify: `src/Acto/vite.config.ts` (the `/ai` dev proxy and `/ai/config` middleware, from WorkflowStudio's),
  `App.tsx` (the `chat` panel)

**Interfaces:**
- Consumes: `BoardStore`, `OutputStore`, `LiveStore`, `StudioApi`, `newId`, Plan 3 `operate/*`.
- Produces:
  ```ts
  export interface ActoCommands {
    /** Pans the board to the workflow (and, given, the steps) the chat changed; does not change the picks. */
    focus(workflowId: Id, stepIds?: Id[]): void;
    setPicks(picks: Pick[]): void;
    picks(): Pick[];
    newWorkflowAt(): Point;            // the first free board slot (placement), for new_workflow
  }
  export interface ToolContext { store: BoardStore; api: StudioApi; output: OutputStore; live: LiveStore;
    commands: ActoCommands; processors(): Processor[]; caches(): Cache[]; session: Storage | null; newId: () => Id }
  // ToolDef / ToolOutcome exactly as WorkflowStudio's toolTypes.ts
  export const TOOL_DEFS: ToolDef[];   // empty here; Tasks 4-6 append
  export const DESTRUCTIVE: ReadonlySet<string>;   // 'stop','delete_workflow','delete_picked','remove_assignment'
  export function workflowArg(ctx: ToolContext, args: Record<string, unknown>): { id: Id; name: string } | { error: string };
  ```
  `workflowArg` reads `args.workflow_id`; a missing/unknown id → error `no workflow <id> on the board`.
  `systemPrompt()` is rewritten for Acto: one board of frames; steps always have a processor; first/parked steps are
  derived from wires; one wire per link coloured by the target's entry condition; no junctions/bends/hub; every tool
  takes `workflow_id`; Save saves one workflow; Start runs the saved version; destructive tools ask the user.
- Pane: WorkflowStudio's pane and status line; header **New chat** (clears the conversation) and **Stop** (only while
  answering, aborts the request); questions from destructive tools shown with their choices, as WorkflowStudio.

- [ ] **Step 1: Port the tests** for `kimi`, `chatStore` (key `acto.chat`), `history` (key `acto.chat.history`),
  `StatusLine`, `ChatPane`, `useChat`, `runTool` from WorkflowStudio, adjusting imports; add: ChatPane header has
  exactly **New chat** while idle and **New chat** + **Stop** while busy; Stop aborts (the fake fetch sees the abort);
  `/ai/config` 503 → the pane shows `NOT_CONFIGURED` and no request is sent (Review Focus 2); `workflowArg` with an
  unknown id returns the error (Review Focus 3); `systemPrompt()` mentions none of `junction`, `bend`, `hub`,
  `open_workflow`, `activate`.
- [ ] **Step 2: Run** `npx vitest run src/chat` → FAIL (modules missing).
- [ ] **Step 3: Implement** — copy, then cut every reference to WorkflowStudio's store, circuit, dock and drawing rules
  (`drawingRules.ts`, `resolve.ts`, `echo.ts` are not ported unless a kept tool needs them).
- [ ] **Step 4: Run** → PASS; full suite + tsc green; `npm run dev` starts with the `/ai` proxy configured from env.
- [ ] **Step 5: Commit** — `feat(acto): the chat pane and its model loop`.

### Task 4: Chat tools — reading and workflows

**Files:**
- Create: `src/Acto/src/chat/tools/{read,workflows}.ts` (+ tests), modify `chat/tools.ts`

**Interfaces:**
- Consumes: Task 3 `ToolContext`, `workflowArg`; `saveWorkflow`; `runWorkflow`; `prepareDelete`/`commitDelete`/
  `confirmText`; `newWorkflowState`; `designRequest`-free reads of `store.boards()`.
- Produces tools (name — arguments — result):
  `list_workflows` — {} — each workflow's id, name, version, Running/Stopped, unsaved, step count ·
  `list_processors` — {} — id, name, version, health line · `list_caches` — {} · `list_schemas` — {} ·
  `read_design` — {workflow_id} — fields, steps (id, name, processor, entry condition, role first/parked/reached,
  next ids, position), caches, assignments, problems, unsaved · `read_entity` — {kind, id} — the stored entity ·
  `read_output` — {last?: number = 20} — newest Output lines ·
  `new_workflow` — {name?} — creates at `commands.newWorkflowAt()`, returns its id ·
  `save` — {workflow_id} · `start` — {workflow_id} · `stop` — {workflow_id} (asks) ·
  `delete_workflow` — {workflow_id} (asks with `confirmText(plan)` as the question; choices `Delete`, `Cancel`).
  Every acting tool calls `commands.focus(workflow_id)`.

- [ ] **Step 1: Failing tests** with a real `BoardStore` over fixtures and a fake api: `read_design` returns roles
  derived from wires; `save` on a workflow another save holds → failed result `<name> is already saving`; `start` on a
  never-saved workflow → failed result with the not-saved line; `delete_workflow` asks, then `Delete` deletes and
  `Cancel` sends nothing; `new_workflow` returns an id that `list_workflows` then lists as unsaved; a tool on a
  workflow locked by saving → failed result naming the lock (Review Focus 1); unknown `workflow_id` → error, no call.
- [ ] **Step 2: Run** `npx vitest run src/chat` → FAIL.
- [ ] **Step 3: Implement.** Store refusals reach the model: tools run edits through a helper that captures the
  Output line the store logs on refusal and returns it as `{ ok: false, result: <line> }`.
- [ ] **Step 4: Run** → PASS; full suite + tsc green.
- [ ] **Step 5: Commit** — `feat(acto): chat tools that read the board and run workflows`.

### Task 5: Chat tools — designing

**Files:**
- Create: `src/Acto/src/chat/tools/design.ts` (+ test), modify `chat/tools.ts`

**Interfaces:**
- Consumes: Plan 2/3 state functions (`addStep`, `swapProcessor`, `addCache`, `linkCache`, `addWire`, `removeWire`,
  `moveMany`, `deleteParts`/`removeStepHere`), `copyClip`/`pasteClip`/`writeClip`, `store.undo/redo`.
- Produces tools: `add_step` — {workflow_id, processor_id, x?, y?} (no position → right of the rightmost step, same
  row) · `set_processor` — {workflow_id, step_id, processor_id} · `add_cache` — {workflow_id, cache_id?} (none →
  creates `new-cache-N`) · `connect` — {workflow_id, from, to} · `disconnect` — {workflow_id, from, to} ·
  `move_blocks` — {workflow_id, moves: [{step_id, x, y}]} (one undo step) · `pick` — {items: Pick[]} ·
  `copy` — {} (the picked steps) · `paste` — {workflow_id} · `delete_picked` — {} (asks) ·
  `undo` — {workflow_id} · `redo` — {workflow_id}. Each acting tool is one store edit (one undo step) and focuses the
  changed steps.

- [ ] **Step 1: Failing tests** — `add_step` without a processor → failed `add_step needs processor_id`; with one →
  the step exists with that processor, one history step; `connect` refusals return the Plan 2 messages (`A step cannot
  wire to itself`, `That wire already exists`, `A wire stays inside its workflow`); `move_blocks` with three moves →
  one undo step; `undo` after the chat's `add_step` removes it, and the user's Ctrl+Z history is the same history (one
  store); `delete_picked` asks and then deletes like the selection bar (shared steps via `removeStepHere`);
  `paste` without a clip → failed `Nothing copied yet`.
- [ ] **Step 2: Run** `npx vitest run src/chat` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; full suite + tsc green.
- [ ] **Step 5: Commit** — `feat(acto): chat tools that design on the board`.

### Task 6: Chat tools — fields and assignments

**Files:**
- Create: `src/Acto/src/chat/tools/fields.ts` (+ test), modify `chat/tools.ts`

**Interfaces:**
- Consumes: `setWorkflowField`, `setStepField`, `setCacheField`, `setProcessorField`, `setSlotField`, `clearSlot`,
  `setPayload`, `removeAssignment`, `checkPayload`, `store.processor()/schema()`.
- Produces tools: `set_field` — {workflow_id, target: {kind: 'workflow'|'step'|'cache'|'processor'|'slot', id?, slot?},
  key, value} (merge key as the Inspector's, so a typed sequence and the chat's edit of the same field are one undo
  step each, not merged across sources: the chat uses `chat:<field merge key>`) · `create_assignment` —
  {workflow_id, step_id, payload} (returns the payload check's problems, still sets it) · `remove_assignment` —
  {workflow_id, step_id} (asks).

- [ ] **Step 1: Failing tests** — `set_field` on a step name → the Inspector shows it, one undo step; on a shared step
  locked by another workflow → failed result with the lock message; on a processor slot definition → a schema copy
  (Plan 3 rule) and the payload re-checked; an unknown key → failed `<kind> has no field <key>`; `create_assignment`
  with an invalid payload → result lists the problems and the payload is kept; `remove_assignment` asks first.
- [ ] **Step 2: Run** `npx vitest run src/chat` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; full suite + tsc green.
- [ ] **Step 5: Commit** — `feat(acto): chat tools for fields and assignments`.

### Task 7: Image and manifest

**Files:**
- Create: `src/Acto/Dockerfile`, `src/Acto/nginx.conf`, `src/Acto/.npmrc` (if WorkflowStudio's is needed),
  `k8s/47-acto.yaml`
- Modify: `tools/vendor-npm.mjs` (an `acto` app: `{ source: 'src/Acto', kit: 'Studio-offline' }`),
  `k8s/kustomization.yaml`, `k8s/port-forward-realstack.ps1` (acto on 18083), `k8s/README.md` (one line)

**Interfaces:** the Global Constraints' image contract. nginx: WorkflowStudio's template verbatim (`/api/`,
`/api/hubs/` WebSocket, `/ai/config`, `/ai/chat/completions`, `/healthz`) plus SPA fallback as WorkflowStudio has.
Manifest: WorkflowStudio's shape (Service + Deployment, probes on `/healthz`, 32Mi/128Mi) with names `acto`, image
`acto:local`; `KIMI_API_KEY` from `secretKeyRef { name: skp-dev-secrets, key: KIMI_API_KEY, optional: true }`, and
the key added to `k8s/01-secret.yaml` with the value WorkflowStudio's manifest uses (Ruling R3).

- [ ] **Step 1: Check the vendored packages** — `node tools/vendor-npm.mjs acto --check`; if it lists missing
  tarballs, run `node tools/vendor-npm.mjs acto` and commit the added tarballs with the task.
- [ ] **Step 2: Build** — from the repo root `docker build -f src/Acto/Dockerfile -t acto:local .` → succeeds (if
  Docker is unavailable on this machine, report it and continue). Run it with
  `docker run --rm -p 18090:8080 -e BASEAPI_URL=http://host.docker.internal:18080 acto:local` and
  `curl localhost:18090/healthz` → `ok`; `curl localhost:18090/api/v1/workflows` → 200 when the stack is up.
- [ ] **Step 3: Validate the manifest** — `kubectl kustomize k8s` (or `kubectl apply --dry-run=client -f
  k8s/47-acto.yaml`) → no errors. Do **not** apply to the cluster (the user does that).
- [ ] **Step 4: Commit** — `build(acto): nginx image and k8s manifest`.

### Task 8: Transition from WorkflowStudio

**Files:**
- Create: `src/WorkflowStudio/src/layout/actoLayout.test.ts` (a fixture written by Acto's `layoutOf`)
- Later (Step 3, only with the user's go-ahead): delete `k8s/31-workflow-studio.yaml`, its kustomization entry and its
  port-forward line; `src/WorkflowStudio/` removed from `main`'s tree after tagging.

**Interfaces:** spec §13 and §14 ("a layout saved by Acto still opens in WorkflowStudio").

- [ ] **Step 1: Failing/pinning test** — copy into WorkflowStudio's tests a layout JSON produced by Acto's `layoutOf`
  (generate it once from an Acto fixture; paste it as a literal with a comment naming the Acto commit). WorkflowStudio's
  loader reads it: every step at its position, the sphere at `layout.sphere`, wires `a->b` and `wf->first` drawn, and a
  save through `layoutOf` keeps `board` unchanged. Run `npx vitest run src/layout/actoLayout.test.ts` in
  `src/WorkflowStudio` → PASS (if it fails, that is a real incompatibility: report it, do not change Acto silently).
- [ ] **Step 2: Commit** — `test(studio): a layout saved by Acto opens in WorkflowStudio`.
- [ ] **Step 3: STOP — ask the user** before archiving. It removes WorkflowStudio from the running stack and from the
  tree, and the user has uncommitted edits in `src/WorkflowStudio/src/canvas/nodes/Chip.tsx` and
  `k8s/31-workflow-studio.yaml` that must be committed or dropped by them first. With the go-ahead: tag
  `archive/workflow-studio` at the current commit, then remove the manifest, kustomization entry, port-forward line and
  the folder in one commit `chore: retire WorkflowStudio (kept on tag archive/workflow-studio)`; update `CLAUDE.md` /
  READMEs that point at it.

---

## Rulings made while writing this plan

- **R1** Light theme by default: the approved mock is light; WorkflowStudio defaults to dark. Costs a click for dark fans.
- **R2** Chat tools are rewritten, not adapted: WorkflowStudio's tools drive its circuit/document store, which Acto does
  not have. The model client, store, pane and loop are ported as they are.
- **R3** The model key moves to `skp-dev-secrets` for Acto (secretKeyRef) instead of a second plaintext copy in a
  manifest; WorkflowStudio's manifest is left as it is until it is retired. Costs one secret entry.
- **R4** Acto reuses `Studio-offline/npm-offline` (its dependencies are a subset of WorkflowStudio's plus none new), so
  no second offline kit. Costs nothing unless versions diverge.
- **R5** Port 18083 for Acto's port-forward (18080–18082 are taken: BaseAPI, WorkflowStudio, Valence).
- **R6** Retiring WorkflowStudio is a stop-and-ask step: it is destructive to the stack and the tree.
- **R7** `set_field` from the chat uses its own merge key (`chat:` prefix), so a chat edit never merges into the
  user's typing in the same field (each stays its own undo step).

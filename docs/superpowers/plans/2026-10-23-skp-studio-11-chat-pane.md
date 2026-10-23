# SKP Studio 11 — Chat Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dockable Chat pane where the Kimi model builds and runs workflows by calling every Studio operation except the wand, with the canvas updating live and every Output line it causes repeated in the chat.

**Architecture:** A browser-side agent loop (`src/chat/`) sends the conversation plus a tool list to `/ai/chat/completions` (the wand's route), streams the answer (thinking, text, tool calls, usage), and carries out each tool call through the same store actions, InspectorService calls and App handlers the UI uses. Destructive tools pause the loop on a Yes/No (or Save/Discard/Cancel) question in the chat. The conversation lives in its own small store, persisted with the tab session.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Playwright, dockview-react; Kimi (OpenAI-compatible chat completions with `tools`).

**Spec:** `docs/superpowers/specs/2026-10-23-skp-studio-11-chat-pane-design.md`

## Global Constraints

- No wand: no tool named or doing AI drawing; `useAiDrawing` / the `drawing` action are never called from `src/chat/`.
- Route: only `/ai/config` and `/ai/chat/completions`; no new server code, no new cluster setting.
- Destructive (need the user's answer first): delete workflow; delete steps/caches/wires; discard design; remove assignment; stop; close a document with unsaved changes (choices **Save**, **Discard**, **Cancel**). All others run at once.
- The chat's question replaces Studio's pop-up for that operation (no `ConfirmDialog` / `DeleteWarning` as well); Delete's question carries the same warnings `DeleteWarning` shows.
- No lock: the user may edit while the model works; every tool reads the store at the moment it runs.
- Undo as today: drawing actions are history steps; field edits / assignments are not.
- Every Output line caused by a chat action shows in the chat, same words, same level; changed pinned problems are shown after each action. User-gesture lines stay in Output only.
- The status line, Claude Code style: animated glyph, activity word, `(12s · ↓ 3.2k tokens · thinking)`.
- The conversation (messages, action lines, an open question) survives a refresh.
- An ambiguous name is an error result; the model must ask the user, never guess.
- Every Studio change is verified with real Playwright runs before reporting (standing rule).

## Review Focus

1. **The user edits while the model works** — a tool naming a step the user just deleted must return an error result (not throw, not act on a stale id). Test in Task 5.
2. **Refresh while a question is open** — after reload the question is still there and Yes still carries out the action and resumes the loop. Test in Task 9.
3. **Kimi answers several tool calls in one message** — they run in order, each result is appended with its `tool_call_id`, one failing does not skip reporting the rest. Test in Task 8.
4. **Model not configured / 401 / silence** — the pane says why in the same words as the wand (`NOT_CONFIGURED`, `AI_SILENCE_MS`), the input stays usable after. Test in Task 8.
5. **A Save that BaseApi refuses** — the errors arrive in the chat in red and in the tool result, so the model can offer a fix. Test in Task 6.

---

## File Structure

New, under `src/WorkflowStudio/src/chat/`:
- `kimi.ts` — streamed request with tools: thinking/text/tool-call deltas, usage, errors.
- `tools.ts` — tool definitions (JSON schemas), `DESTRUCTIVE` set.
- `prompt.ts` — the system prompt (the model's Studio knowledge).
- `resolve.ts` — names → ids in a document, ambiguity errors.
- `runTool.ts` — the executor: one tool call → outcome; one function per tool group in `tools/` below.
- `tools/read.ts`, `tools/workflows.ts`, `tools/design.ts`, `tools/fields.ts` — the tool groups.
- `echo.ts` — collects Output lines and problem changes caused by an action.
- `chatStore.ts` — conversation state, reducer, persistence.
- `useChat.ts` — the agent loop.
- `ChatPane.tsx`, `StatusLine.tsx`, `chat.css` — the pane.

Modified: `dock/ids.ts` (tool id), `App.tsx` (renderTool, `StudioCommands`), `app/studioActions.ts` (commands field), new `app/studioCommands.ts`, dock default layout (wherever `inspector`/`output` homes are defined, `dock/home.ts`).

---

### Task 1: Prove Kimi tool calling through the route

**Files:**
- Create: `tools/kimi-tools-probe.mjs` (repo root `tools/`)

- [ ] **Step 1:** Write a Node script that POSTs to `${KIMI_BASE_URL}/chat/completions` with `Authorization: Bearer ${KIMI_API_KEY}`, model `${KIMI_MODEL_ID}`, `stream: true`, `stream_options: { include_usage: true }`, one tool `add_step({ name: string })`, user "add a step named fetch". Print every `data:` line's delta keys. Then send a second round with the assistant message (including `reasoning_content` and `tool_calls`) and a `role: "tool"` result, and print the final text.
- [ ] **Step 2:** Run with the cluster's values: `kubectl -n skp exec deploy/workflow-studio -- printenv KIMI_BASE_URL KIMI_MODEL_ID KIMI_API_KEY`, export them, `node tools/kimi-tools-probe.mjs`.
  Expected: round 1 streams `delta.tool_calls[0].function.name == "add_step"` with arguments in pieces; a final chunk carries `usage`; round 2 returns text. Record in the commit message: whether `reasoning_content` must be echoed back (try round 2 without it; a 400 means yes), and whether `usage` arrives.
- [ ] **Step 3:** If tools are refused, stop and report: Task 2 then switches to the JSON-in-text fallback (the model answers one JSON object `{ "say": string, "calls": [{ "name", "arguments" }] }` with `response_format: json_object`); every later task is unchanged because they consume `AssistantTurn` (Task 2).
- [ ] **Step 4:** Commit `tools/kimi-tools-probe.mjs` with the findings in the message. Never commit the key.

### Task 2: The streamed request with tools

**Files:**
- Create: `src/chat/kimi.ts`, Test: `src/chat/kimi.test.ts`

**Interfaces:**
- Consumes: `modelOf`, `AI_SILENCE_MS`, `DrawingError` from `src/ai/drawing.ts` (reuse; do not copy).
- Produces:
```ts
export interface ToolCall { id: string; name: string; arguments: string }
export interface AssistantTurn { text: string; reasoning: string; calls: ToolCall[]; tokens: number }
export type ChatWire =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; reasoning_content?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface Progress { phase: 'waiting' | 'thinking' | 'writing'; tokens: number }
export async function requestTurn(model: string, messages: readonly ChatWire[], tools: readonly object[], signal: AbortSignal,
  onProgress: (p: Progress) => void, fetchFn?: typeof fetch): Promise<AssistantTurn>;
export class ChatError extends Error {}
```

- [ ] **Step 1: Failing tests** (`kimi.test.ts`, a fake fetch returning an event stream):
  - `assembles a tool call from pieces`: deltas `{tool_calls:[{index:0,id:'c1',function:{name:'add_step',arguments:'{"na'}}]}` then `{tool_calls:[{index:0,function:{arguments:'me":"a"}'}}]}` → `calls` equals `[{ id:'c1', name:'add_step', arguments:'{"name":"a"}' }]`.
  - `two calls by index` → two calls in index order.
  - `tokens from usage`: a final chunk `{usage:{completion_tokens:3200}}` → `tokens === 3200`, and the last `onProgress` has `tokens: 3200`.
  - `tokens estimated without usage`: 400 chars of reasoning + content → `tokens === 100` (chars / 4, rounded).
  - `phase`: reasoning deltas report `thinking`, content deltas `writing`.
  - `503 → ChatError` whose message equals the wand's not-configured text; `401 → ChatError` "the model refused the key (HTTP 401)".
- [ ] **Step 2:** `npx vitest run src/chat/kimi.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement. Body: `{ model, stream: true, stream_options: { include_usage: true }, messages, tools, reasoning_effort: AI_EFFORT }`. Silence: abort the round after `AI_SILENCE_MS` without a byte (as the wand). Extend `drawing.ts` only by exporting `AI_EFFORT` / `NOT_CONFIGURED` if not yet exported.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(studio): chat request to Kimi with tools, streamed`.

### Task 3: The pane, its store and its persistence

**Files:**
- Create: `src/chat/chatStore.ts`, `src/chat/ChatPane.tsx`, `src/chat/StatusLine.tsx`, `src/chat/chat.css`
- Modify: `src/dock/ids.ts`, `src/App.tsx` (`renderTool`), dock default layout file
- Test: `src/chat/chatStore.test.ts`, `src/chat/StatusLine.test.tsx`

**Interfaces:**
- Produces:
```ts
export type ChatEntry =
  | { kind: 'user'; text: string }
  | { kind: 'model'; text: string }
  | { kind: 'action'; text: string; ok: boolean }                 // "+ step fetch with processor FileFetcher 1.2.0"
  | { kind: 'output'; text: string; level: OutputLevel; name: string } // an Output line, mirrored
  | { kind: 'problems'; lines: string[] }                          // the pinned problems after an action, when changed
  | { kind: 'note'; text: string; level: OutputLevel };            // "not configured", "cancelled", "lost at refresh"
export interface Question { callId: string; text: string; choices: readonly string[]; warnings?: string[] }
export interface ChatState { entries: ChatEntry[]; wire: ChatWire[]; question: Question | null; busy: boolean }
export const CHAT_KEY = 'skp.studio.chat';
export function createChatStore(storage: Storage | null): ChatStore; // getState, dispatch, subscribe (same shape as studioStore)
export type ChatAction =
  | { type: 'entries'; add: ChatEntry[] } | { type: 'wire'; add: ChatWire[] } | { type: 'ask'; question: Question | null }
  | { type: 'busy'; on: boolean } | { type: 'newChat' };
export function StatusLine(props: { seconds: number; tokens: number; activity: string }): JSX.Element;
```
- `ToolId` gains `'chat'`, title `Chat`.

- [ ] **Step 1: Failing tests:**
  - `chatStore`: entries and wire are written to storage under `CHAT_KEY` (debounced 300 ms like `createSaver`) and read back by a new store; `busy` is never restored (a store read from storage has `busy: false`, and if it had been busy an entry `{kind:'note', text:'The request in flight was lost at refresh', level:'error'}` is added); `question` is restored; `newChat` empties all; a malformed stored value gives an empty chat.
  - `StatusLine`: `seconds 12, tokens 3200, activity 'thinking'` renders text `(12s · ↓ 3.2k tokens · thinking)`; tokens 950 → `↓ 950 tokens`; the glyph element cycles through `· ✢ ✳ ✶ ✻ ✽` (one step per 120 ms, fake timers) and is static under `prefers-reduced-motion`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement store (use `browserTabStorage` + mirror as `session.ts` does); `ChatPane`: the entries list (auto-scroll as `Output.tsx`), the question with one button per choice, the status line + **Stop** while busy, a textarea (Enter sends, Shift+Enter newline; disabled while busy), a **New chat** button, and the not-configured note. Action lines and `output` entries of level error in red, as Output's styles. Add the pane to the default layout next to Output.
- [ ] **Step 4:** PASS; `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(studio): Chat pane, its store and status line`.

### Task 4: Page commands for the chat

**Files:**
- Create: `src/app/studioCommands.ts`; Modify: `src/app/studioActions.ts`, `src/App.tsx`; Test: `src/App.test.tsx` (add cases)

**Interfaces:**
- Produces:
```ts
export interface StudioCommands {
  listWorkflows(): Promise<ApiResult<WorkflowReadDto[]>>;
  open(workflowId: Id): Promise<'ready' | string>;          // resolves when the document is ready, or the failure message
  newWorkflow(): Promise<Id>;                                // resolves when the document exists
  activate(workflowId: Id): void;
  save(workflowId: Id): Promise<void>;                       // App's `save` (re-reads the picker list as today)
  run(workflowId: Id, op: RunOp): Promise<void>;             // runWorkflow with liveOf
  prepareDelete(workflowId: Id): Promise<DeletePlan | null>; // no prompt
  commitDelete(plan: DeletePlan): Promise<boolean>;          // App's continueDelete body, awaited
  close(workflowId: Id): void;                               // no prompt: drops the view and dispatches close
}
// StudioActions gains: commands?: StudioCommands
```
- [ ] **Step 1: Failing tests** in `App.test.tsx`: through `useStudioActions().commands` from a probe component — `open` resolves `'ready'` after the fake API's graph loads; `close` on a dirty document closes with no dialog shown; `prepareDelete` + `commitDelete` delete with no dialog and the document is gone; `newWorkflow` resolves an id whose document is active.
- [ ] **Step 2:** FAIL. **Step 3:** Implement by moving the bodies of App's existing callbacks into functions both the UI and `commands` call (the UI keeps its prompts; commands skip them). **Step 4:** PASS, whole `npm test` green. **Step 5:** Commit `feat(studio): page commands the chat can call`.

### Task 5: Resolving names, the reading tools

**Files:**
- Create: `src/chat/resolve.ts`, `src/chat/tools/read.ts`; Test: `src/chat/resolve.test.ts`, `src/chat/tools/read.test.ts`

**Interfaces:**
- Produces:
```ts
export type Found<T> = { ok: true; value: T } | { ok: false; error: string };
export function findStep(doc: OpenDocument, name: string): Found<Id>;       // by id, else by name (case-insensitive); in the design as shown
export function findWorkflow(list: readonly WorkflowReadDto[], open: readonly OpenDocument[], ref: string): Found<Id>; // id, "name", or "name version"
export function findProcessor(list: readonly ProcessorReadDto[], ref: string): Found<ProcessorReadDto>;
export function findCache(list: readonly CacheReadDto[], ref: string): Found<CacheReadDto>;
export function findWire(doc: OpenDocument, ref: string): Found<string>;    // wire id, or "from -> to"
```
- Ambiguous → `error` is `"<n> steps are named fetch: fetch (id …), fetch (id …); ask the user which one"` (lists each with id, and version where there is one). Missing → `"no step named fetch in <workflow>"`.
- Read tools (each returns compact JSON text): `list_workflows` (id, name, version, running, open), `list_processors` (id, name, version, schema names per slot), `list_caches` (id, name, version, root), `list_schemas` (id, name, version), `read_design({workflow?})` (the wand's `graphOf` plus each step's name, processor name/version, entry condition, assignment id, and the problems list), `read_entity({target})` (the Inspector's fields for the target, from InspectorService's read, edits applied), `read_output({workflow?, last?})`.

- [ ] **Step 1: Failing tests:** two steps named `fetch` → ambiguity error listing both ids; `"fetch"` when one exists → its id; a step deleted from the draft is not found (Review Focus 1); `findWorkflow(list, open, "feed 1.0.0")` picks the version; `read_design` on the fixture document includes every step name and `problems: []`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(studio): chat reading tools and name resolution`.

### Task 6: The executor, the echo, and workflow tools

**Files:**
- Create: `src/chat/echo.ts`, `src/chat/runTool.ts`, `src/chat/tools/workflows.ts`; Test: `src/chat/echo.test.ts`, `src/chat/tools/workflows.test.ts`

**Interfaces:**
- Consumes: `StudioCommands` (Task 4), `ChatEntry`, `Question` (Task 3), resolvers (Task 5).
- Produces:
```ts
export interface ToolContext { store: StudioStore; service: InspectorService; api: StudioApi; commands: StudioCommands; newId: () => string }
export type ToolOutcome =
  | { kind: 'done'; ok: boolean; result: string; action: string; entries: ChatEntry[] }   // result: what the model hears
  | { kind: 'ask'; question: Omit<Question, 'callId'> };
export async function runTool(ctx: ToolContext, call: ToolCall, answer?: string): Promise<ToolOutcome>;
// echo: wraps an action, collecting Output lines for the touched workflow(s) appended while it runs and until `until()` holds
export async function withEcho<T>(store: StudioStore, workflowIds: () => Id[], act: () => Promise<T>,
  until?: () => boolean, timeoutMs?: number): Promise<{ value: T; entries: ChatEntry[] }>;
```
- `withEcho` takes `state.output.length` before, collects lines after whose `workflowId` is touched, then compares the pinned problems (`shortCircuitErrors` + `doc.errors`, as `useProblems`) before/after and adds a `problems` entry when they differ. The tool's `result` text includes the collected lines (`[error] …`) and the problems.
- Workflow tools: `open_workflow(workflow)`, `new_workflow()`, `activate(workflow)`, `save(workflow?)`, `start(workflow?)`, `stop(workflow?)` (ask: `["Yes","No"]`), `delete_workflow(workflow)` (runs `prepareDelete` first; ask `["Yes","No"]` with `warnings` = the plan's lines `DeleteWarning` shows; Yes → `commitDelete`), `close_workflow(workflow?)` (clean: closes; dirty: ask `["Save","Discard","Cancel"]`; Save → save then close only if the save applied; Discard → close; Cancel → result "the user cancelled"). `workflow` absent = the active document. Start/Stop echo waits until `doc.run === null` (the liveness line arrived or the timeout line), at most `RUN_TIMEOUT_MS`.
- An unknown tool name or bad JSON arguments → `done`, `ok: false`, result names the problem.

- [ ] **Step 1: Failing tests:** `save` against a fake API answering errors → outcome `ok: false`, `entries` contains the Output's "Save …" lines with level `error` and a `problems` entry, `result` contains the error texts (Review Focus 5); `stop` without answer → `kind: 'ask'`, with answer `"No"` → result `"the user declined"` and `api.stopWorkflow` not called; `delete_workflow` → ask with warnings, `"Yes"` → workflow gone; `close_workflow` on a dirty doc with `"Cancel"` → still open; there is no tool whose name contains `draw` or `wand` (`TOOLS.map(t => t.function.name)`).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(studio): chat executor, Output echo, workflow tools`.

### Task 7: Design and field tools

**Files:**
- Create: `src/chat/tools/design.ts`, `src/chat/tools/fields.ts`, `src/chat/tools.ts` (the full `TOOLS` list + `DESTRUCTIVE`); Test: `src/chat/tools/design.test.ts`, `src/chat/tools/fields.test.ts`

**Interfaces:**
- Design tools, each dispatching the existing action (one `design` / `toolDrop` / `autoConnect` / `paste` … = one Undo step), result naming created ids:
  - `add_step({ processor?, x?, y? })` → `toolDrop` with `{kind:'step'}` or `{kind:'processor', …}` at `(x,y)`; without a point, the first free spot right of the rightmost step on the hub's row (`freeOffset`).
  - `set_processor({ step, processor })` → `toolDrop` processor at the step's centre.
  - `add_cache({ cache? , x?, y? })` → `newCache` or existing `cache`.
  - `connect({ from, to })` — `from`: step or `"workflow"`; `to`: step. Adds a `CircuitWire` tail `{on:'step', step, y:null}` / `{on:'hub', angle:null}`, head `{on:'step', step:to, y:null}` via `addCircuitWire` + `withCircuit`, then `design`. Refused (result explains) if `shortCircuitErrors` grow.
  - `join({ wire, side, host })` — turns `wire`'s `side` end into a junction on `host` (same family, same step, as the wand's merge rule; refused otherwise); the point: where the host passes nearest the end's current point (`at` along the host's drawn line).
  - `auto_connect({ block, dir })`, `move_blocks({ moves: [{ block, x, y }] })` (`moveBlocks`, snapped to `GRID`), `reset_route({ wire })`, `pick({ items })`, `copy()`, `paste()`, `delete_picked()` (ask Yes/No, the question names what goes), `undo()`, `redo()`, `discard_design()` (ask Yes/No).
- Field tools, each first showing the target in the Inspector (`select`, then `drill` steps to the target) and awaiting the read (`service.read`, wait until the inspector's read for that key lands, timeout 10 s):
  - `set_field({ target, field, value })` — `target`: `{ kind: 'workflow' } | { kind:'step', step } | { kind:'processor', step } | { kind:'schema', step, slot } | { kind:'assignment', step } | { kind:'cache', cache }`; `field` a key from `ENTITY_FORMS` for that kind; → `service.edit(workflowId, spec, value)`; result reads the field back, or the Inspector's own field error.
  - `create_assignment({ step })`, `remove_assignment({ step })` (ask Yes/No), `revert_entity({ target })`.
  - Copy a field from one entity to another is `read_entity` + `set_field`; the prompt says so (Task 8).
- `DESTRUCTIVE = new Set(['stop','delete_workflow','close_workflow','delete_picked','discard_design','remove_assignment'])` (`close_workflow` asks only when dirty).

- [ ] **Step 1: Failing tests** on the fixture document: `add_step` with processor `FileFetcher` → a new step with that processor, `canUndo` true; `connect a → b` → `nextOf(a)` includes `b`, no short circuit; `connect` that would short-circuit → `ok:false`, draft unchanged; `pick` + `copy` + `paste` → two steps of the same name, new ids; `set_field` step `a` `entryCondition` `Failed` → the shown step's entry condition is Failed; `set_field` assignment `payload` with invalid JSON → `ok:false` with the Inspector's message; `set_field` on a step the user deleted meanwhile → `ok:false` "no step named …" (Review Focus 1); `delete_picked` returns `ask` and deletes only after `"Yes"`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat(studio): chat design and field tools`.

### Task 8: The model's knowledge and the agent loop

**Files:**
- Create: `src/chat/prompt.ts`, `src/chat/useChat.ts`; Modify: `src/chat/ChatPane.tsx`; Test: `src/chat/useChat.test.tsx`, `src/chat/prompt.test.ts`

**Interfaces:**
- `export function systemPrompt(): string` — covers the spec's "The model's knowledge" list: entities and fields (from `ENTITY_FORMS`), families (`CONDITIONS` names), wiring rules (tail = output, head = input; junctions within one family; no short circuits; loops and self-feeding allowed; paste = exact copy, new ids; a cache root already taken is refused), `DRAWING_RULES` verbatim with "you place what you add by these rules using move_blocks", Save's dry run (read the errors, offer fixes), the destructive list ("the studio asks the user; never ask twice yourself"), "the wand is not available to you", "never guess between same-named things: ask", "copy a field = read_entity then set_field", "always say which entity you acted on, by name and version", "read before you act; the user may change the design meanwhile".
- `export function useChat(ctx: ToolContext, chat: ChatStore): { send(text: string): void; answer(choice: string): void; stop(): void; status: { seconds: number; tokens: number; activity: string } | null }`
- Loop: append user → `requestTurn` → push assistant wire (with `reasoning_content` if Task 1 found it required) → model text as `model` entry → for each call in order: `runTool`; `done` → `action` entry + its entries + `tool` wire; `ask` → `ask` question and return (the loop resumes in `answer`). Next round until a turn has no calls. Cap `MAX_ROUNDS = 40` → note "Stopped after 40 rounds". `activity`: `thinking` / `writing` / `running <tool>`. Stop aborts the request; actions already done stay.
- While a question is open, a typed message equal to one of its choices (case-insensitive, trimmed) answers it; any other text is refused with a note "Answer the question first".
- `open_workflow` / `new_workflow` leave that document active, so its canvas is in view.
- A question restored after refresh: `answer` works with no loop in memory (it runs the call from `wire`'s last assistant message by `callId`, then continues).

- [ ] **Step 1: Failing tests** with a scripted fake fetch: a turn with two calls (`add_step`, `connect`) runs both in order and sends both `tool` messages with matching `tool_call_id`, then the final text appears (Review Focus 3); 503 → note with the wand's not-configured text, input usable again (Review Focus 4); `stop` mid-stream → `busy` false, a `cancelled` note; `prompt.test`: `systemPrompt()` contains `DRAWING_RULES` and every `CONDITIONS` name, and does not contain "wand" as an available tool.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`, `npm run typecheck`. **Step 5:** Commit `feat(studio): chat agent loop and the model's Studio knowledge`.

### Task 9: Browser suite, real model check, deploy

**Files:**
- Create: `e2e/chat.spec.ts` (pattern: `e2e/aidrawing.spec.ts` — throwaway workflow, `/ai/*` mocked as an event stream that now carries `tool_calls`)

- [ ] **Step 1: Tests** (real browser, real mouse for every click):
  - Build: scripted turns `add_step` (processor of the throwaway) → `connect workflow → it` → `set_field` payload; the canvas shows the new step and wire while the status line shows `↓ … tokens`; Ctrl+Z removes the wire.
  - Confirmation: `discard_design` → the question shows in the chat, no `ConfirmDialog`; **No** keeps the draft; again, **Yes** discards.
  - Refresh: open question, `page.reload()`, question still there, **Yes** works and the loop's next scripted turn arrives (Review Focus 2).
  - Echo: `save` with a design BaseApi refuses → the chat shows the same red lines Output shows (compare texts).
  - No lock: while a scripted turn is delayed 2 s, the user drags a block; it moves.
  - The pane docks/floats like the others; New chat empties it.
- [ ] **Step 2:** `npm run e2e -- chat.spec.ts` PASS; full `npm run e2e` green (report any failures with output).
- [ ] **Step 3: Proficiency check with the real model** (the user, 2026-10-23: the chat must be proficient at Studio design). `e2e/chat-real.spec.ts`, run only when `KIMI_REAL=1` (dev server with the cluster's KIMI env), each on a fresh throwaway, Playwright typing into the chat like a user:
  1. "add a step with processor <P> and wire it from the workflow; give it an assignment with payload {}"
  2. "build a chain of three steps a → b → c with processor <P>; c's failure goes to a step named alarm"
  3. "a fans out to b and c, which both feed d" (fan-out / fan-in through junctions)
  4. "copy step b's assignment payload onto step c"
  5. "save it" on a design with a known Save error, expecting the model to report the error and offer a fix.
  Each passes when: the relations are exactly the ones asked (`relationsOf`), no short circuit (`shortCircuitErrors` empty), and the drawing is tidy by the wand's own judge (`remainingProblemsOf` from `src/ai/drawing.ts`: no crossings, main path on one row, Failed below), the chat's reply names what it acted on, and nothing destructive ran without a question. Where one fails, improve `systemPrompt()` (Task 8) and run again; record the scenario results in the handover.
- [ ] **Step 4:** Commit `test(studio): chat pane browser suite`; build and deploy the studio image as for previous Studio deploys (`k8s/31-workflow-studio.yaml`); record the bundle name (`index-*.js`); write `docs/HANDOVER-2026-10-23-studio-chat-pane.md`.

# Acto Plan 6 — Inspector tabs, React Flow look, running wires, ghosts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabbed Studio-like Inspector, several selected workflows compared on shared steps, React Flow UI cards with a
status ring, motion only where a workflow runs, S1 stopped triangles, and restorable ghosts of deleted items.

**Architecture:** The selection gains a list of selected workflows (`workflows: Id[]`) and a `ghost` pick kind. A new
page-memory ghost store records every board item seen since the page loaded; `toFlow` draws real items plus ghosts and
derives running/chips/hues. The Inspector becomes a tab host whose tabs are pure functions of (selection, board).
Everything else — BaseAPI, Save, `/model/apply`, history, drafts — is unchanged.

**Tech Stack:** React 19, TypeScript, @xyflow/react 12, Vitest + Testing Library, Playwright (headed suite in
`src/Acto/e2e`).

**Spec:** `docs/superpowers/specs/2026-11-18-acto-inspector-tabs-design.md` (amends
`docs/superpowers/specs/2026-11-18-acto-triangles-design.md`). Approved mockups:
`.superpowers/brainstorm/1305-1794971489/content/inspector-tabs-v4.html` and `scene4-ghosts-v2.html`.

## Global Constraints

- No Acto rule the database (as BaseAPI enforces it) does not have. A ghost link restore refused for a missing end
  (`restore <name> first`) is the only new refusal.
- Faded/ghost look is used only for deleted items; nothing fades for "not selected".
- Step card = React Flow UI BaseNode look (8px radius, `#D4D4D8` border, soft shadow, header row with processor square +
  processor name + condition pill, body = step name); running ring `#22C55E`.
- Stopped triangle = S1: fill `#F1F3F7`, outline `#64748B`, ■ inside, pill "■ stopped". Running: green ▶, green
  spinning dashed ring, "● running".
- Selected-workflow palette in selection order: `#FF0072`, `#7C3AED`, `#0D9488`, `#D97706`, `#2563EB`, `#DB2777`
  (then repeat).
- Ghost look: opacity `0.32`, dashed outline `#94A3B8`, name struck through, tag `deleted · ghost`; ghost wires grey
  dotted. Ghost toolbar: **Restore · Remove**. Ghosts live in page memory only (a browser reload clears them).
- Toolbars otherwise unchanged; Paste = Ctrl+V only; Delete key does nothing; no key hints.
- JSON shown with Studio's `prettyJson` (two-space, one field per line); text typed back to the same JSON is no edit.
- NEVER stage, stash, reset or modify the user's uncommitted files (k8s/31-workflow-studio.yaml — holds a real API key,
  never print or commit it — k8s/32-valence.yaml, k8s/43-processor-analyst.yaml,
  src/Processor.Analyst/Bit/RehearsalGraph.cs, src/WorkflowStudio/src/canvas/nodes/Chip.tsx, untracked docs,
  .playwright-mcp/, .wf-restore.json, tools/deck-to-pptx/, tools/simulate-unapproved-feed.py). Stage by path only. No
  push, merge or rebase.
- e2e writes only `e2e-` throwaway rows; never Start/Stop a real workflow; never save processor or schema edits.

## Review Focus

1. **Save remaps created ids** — a step created on the board then saved must not leave a ghost under its client id
   (Task 2 test `remap keeps a saved create from becoming a ghost`).
2. **Restore order** — restoring a ghost wire whose source is also a ghost: alone it is refused with
   `restore <name> first`; picked together with the step, one Restore brings both (Task 2 test).
3. **Remove, then the item comes back** — Remove a ghost, undo the delete (item real again), delete again: the ghost
   shows again (Task 2 test `a removed ghost comes back on a new delete`).
4. **A selected workflow disappears** (deleted, undone away) — it leaves `workflows`; the Inspector falls back to what
   remains (Task 1 prune test).
5. **Pretty JSON is not a change** — opening and re-typing a payload/definition/items in another layout keeps the Save
   count at 0 (Task 6 test).

---

### Task 1: Selection with several workflows and ghost picks

**Files:**
- Modify: `src/Acto/src/board/selection.ts`, `src/Acto/src/board/picks.ts`, `src/Acto/src/session/view.ts`,
  `src/Acto/src/App.tsx` (prune + every `{ workflow: … }` literal), `src/Acto/src/chat/tools/*.ts` that read/set the
  selection, `src/Acto/src/inspector/InspectorPanel.tsx` (type only: `selection.workflows`)
- Create: `src/Acto/src/board/hues.ts`
- Test: `src/Acto/src/board/selection.test.ts` (new), `picks.test.ts`, `src/Acto/src/session/view.test.ts`

**Interfaces:**
- Produces:
  - `type Pick = … | { kind: 'ghost'; key: string }` (key = the ghost's item key, see Task 2)
  - `interface SelectionState { workflows: Id[]; picks: Pick[] }` (replaces `workflow: Id | null`)
  - `selectPick(prev: SelectionState, p: Pick | null, additive: boolean): SelectionState`
  - `hueOf(selection: SelectionState, wf: Id): string | null` and `WORKFLOW_HUES: readonly string[]` in `board/hues.ts`
  - `pickKey` handles `ghost` → `gh:<key>`

- [ ] **Step 1: Write the failing tests** in `selection.test.ts`:
  - `a plain triangle click selects it alone` → `{ workflows: ['a'], picks: [{kind:'workflow',id:'a'}] }`
  - `ctrl+click adds and removes triangles` → from `a` selected, Ctrl on `b` → `workflows ['a','b']`, picks both
    triangles; Ctrl on `a` again → `workflows ['b']`
  - `a step click keeps the selected workflows` → `{workflows:['a','b']}` + plain step `s` → `workflows ['a','b'], picks [step s]`
  - `ctrl+click on steps toggles among steps, keeps workflows`; `ctrl+click mixes ghosts with steps`
  - `an entry arrow or cache line click selects its workflow alone`
  - `the empty board clears everything` → `{ workflows: [], picks: [] }`
  - `hues follow selection order` → `hueOf({workflows:['b','a']}, 'a') === '#7C3AED'`, `hueOf(..., 'z') === null`
  - view.test: a stored old shape `{ workflow: 'a', picks: [] }` reads as `{ workflows: ['a'], picks: [] }`; a stored
    `ghost` pick is dropped (ghosts do not survive a reload).
  - App prune (in `App.test.tsx`): a selected workflow that leaves the board leaves `workflows`.
- [ ] **Step 2: Run** `cd src/Acto && npx vitest run src/board/selection.test.ts src/session` — FAIL.
- [ ] **Step 3: Implement.** A ctrl+click on a triangle toggles both its id in `workflows` and its pick; a plain click
  on a step/cache/wire/ghost keeps `workflows`. Update every consumer to `workflows` (App prune, paste, chat
  `setPicks`, InspectorPanel props) — behaviour of the Inspector itself changes in Task 6; here use `workflows.at(-1)`
  where one workflow was used.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck` — all PASS (update existing tests' selection literals).
- [ ] **Step 5: Commit** `feat(acto): several selected workflows and ghost picks in the selection`

### Task 2: Ghost store

**Files:**
- Create: `src/Acto/src/design/ghosts.ts`
- Modify: `src/Acto/src/design/saveBoard.ts` (call `remap` with `made` after a successful apply)
- Test: `src/Acto/src/design/ghosts.test.ts`

**Interfaces:**
- Produces:
  - `type GhostItem = { key: string } & ({ kind: 'step'; row: StepRow } | { kind: 'cache'; row: CacheRow } | { kind: 'workflow'; row: WorkflowRow; assignments: AssignmentRow[] } | { kind: 'wire'; from: Id; to: Id; condition: number } | { kind: 'entry'; workflowId: Id; stepId: Id } | { kind: 'cacheLink'; workflowId: Id; cacheId: Id })`
  - item keys: `step:<id>`, `cache:<id>`, `workflow:<id>`, `wire:<from>:<to>`, `entry:<wf>:<step>`, `cacheLink:<wf>:<cache>`
  - `interface GhostStore { ghosts(): GhostItem[]; get(key: string): GhostItem | undefined; remove(keys: string[]): void; remap(made: Record<string, string>): void; subscribe(fn: () => void): () => void }`
  - `createGhostStore(board: BoardStore): GhostStore` — subscribes to `board`; on every change it records every item
    of `board.state()` (its latest snapshot) and recomputes ghosts = recorded − present − removed. A key that is
    present again is dropped from `removed`.
  - `restoreGhosts(b: BoardState, base: BoardState, items: GhostItem[]): Edit` — one edit: rows first (steps, caches,
    workflows with their assignments), then links. A row BaseAPI still has (in `base`) comes back with `base`'s
    `updatedAt`; otherwise with `updatedAt: null` (a create on the next Save), same id. A step brings its own
    `nextStepIds` filtered to steps present after the restore; a workflow its entry/cache/assignment links whose ends
    exist. A link whose end is missing → `{ refused: 'restore <name> first' }` (name of the missing end from the
    ghost's snapshot).
- Consumes: `BoardStore` (`state`, `base`, `subscribe`) from `design/boardStore.ts`.

- [ ] **Step 1: Write the failing tests** (`ghosts.test.ts`, board fixtures from `boardFixtures.ts`):
  - `deleting a step leaves ghosts for it, its wires and its entry arrows`
  - `undo of the delete removes the ghosts`
  - `remove hides a ghost; a removed ghost comes back on a new delete` (remove → undo delete → delete again → ghost)
  - `remap keeps a saved create from becoming a ghost` (create `tmp1`, `remap({tmp1:'real1'})`, store loads a state with `real1` → no ghost)
  - `a workflow dropped by dropWorkflow is a ghost with its assignments`
  - `restore of an unsaved delete makes the row unchanged` (`changedKeys(base, after)` empty)
  - `restore of a row gone from base is a create` (`updatedAt === null`)
  - `restoring a wire whose source is a ghost alone is refused with "restore fetch first"`; `restoring both together brings both`
  - `ghosts are not in the store state` (BoardState never contains ghosts)
- [ ] **Step 2: Run** `npx vitest run src/design/ghosts.test.ts` — FAIL.
- [ ] **Step 3: Implement** `ghosts.ts`; in `saveBoard`, after `applied`, call an optional `ghosts?.remap(made)` passed
  as a fourth parameter `saveBoard(api, store, output, ghosts?: GhostStore)`.
- [ ] **Step 4: Run** `npx vitest run src/design` — PASS.
- [ ] **Step 5: Commit** `feat(acto): page-memory ghosts of deleted items, restorable`

### Task 3: toFlow — no dimming, hues, key chips, running, ghosts

**Files:**
- Modify: `src/Acto/src/board/toFlow.ts`
- Test: `src/Acto/src/board/toFlow.test.ts`

**Interfaces:**
- Consumes: `SelectionState`/`hueOf` (Task 1), `GhostItem` (Task 2).
- Produces:
  - `BoardView` gets `workflows: Id[]` (replaces `workflow`) and `ghosts?: GhostItem[]`
  - step node `data`: `{ stepId, name, processor, processorId, condition: number, running: boolean, chips: { text: string; hue: string }[], ghost?: boolean, failed, unsaved, pick? }` — `footer` is gone
  - triangle `data`: `{ …, status, hue: string | null, ghost?: boolean }` (`lit` gone); cache `data` adds `ghost?`
  - edge `data`: wire `{ condition, from, to, running, ghost? }`; entry `{ workflowId, stepId, hue: string|null, running: boolean, ghost? }`; cacheLink `{ workflowId, cacheId, hue, ghost? }`
  - ghost nodes/edges: same `type`s as real ones, `id` prefixed `ghost:` + item key, `draggable: false`,
    `connectable: false`, `zIndex: -1`, `className: 'ghost'`, `data.ghost = true`, `data.ghostKey`; positioned at the
    snapshot's `at`; a ghost edge is drawn only when both of its ends are on the board (real or ghost).
  - `flowIdOf({kind:'ghost', key})` → `ghost:<key>`
- [ ] **Step 1: Write the failing tests:**
  - `nothing is dimmed when a workflow is selected` (no node/edge has class `dim`)
  - `chips: one per selected workflow with an assignment on the step` → `{ text: '◆ 2 keys · daily', hue: '#FF0072' }`
    when two are selected; `'◆ 2 keys'` (no suffix) with one; `'◆ payload'` for non-object JSON
  - `a step is running when a running workflow reaches it`; `a wire runs only when a running workflow reaches its
    source`; `an entry arrow runs only while its workflow runs`; `cache lines never run`
  - `selected triangles carry their hue; entry arrows and cache lines of a selected workflow carry it`
  - `ghosts are drawn with ghost: true, not draggable or connectable`; `a ghost wire between a real and a ghost step is
    drawn`; `a ghost wire with a removed end is not drawn`
- [ ] **Step 2: Run** `npx vitest run src/board/toFlow.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Chip text from `payloadKeyCount` (`model/assignments.ts`); suffix `· <first word of the
  workflow name before '-'>` only when 2+ workflows are selected.
- [ ] **Step 4: Run** `npx vitest run src/board` — PASS.
- [ ] **Step 5: Commit** `feat(acto): board view draws hues, key chips, running and ghosts; nothing dims`

### Task 4: React Flow look — BaseNode step card, S1 triangle, cache card, edges, ghosts

**Files:**
- Modify: `src/Acto/src/board/nodes/StepCard.tsx`, `TriangleNode.tsx`, `CacheNode.tsx`,
  `src/Acto/src/board/edges/LinkWire.tsx`, `EntryEdge.tsx`, `CacheLinkEdge.tsx`, `src/Acto/src/board/board.css`,
  `src/Acto/src/board/BoardMiniMap.tsx` (ghosts not in fit/marks)
- Test: `src/Acto/src/board/Board.test.tsx` (render assertions)

**Interfaces:** consumes Task 3's node/edge `data`.

- [ ] **Step 1: Write the failing tests** (render via `Board` with fixtures):
  - step card has `.bn-header` with the processor name and a `.cond-pill` with the letter, `.bn-body` with the step
    name; `.node.running` when `data.running`
  - a running triangle has `.tri.running` with `.tri-ring` and text `● running`; a stopped one `.tri.stopped` with a
    `.tri-stop` square and pill text `■ stopped`; unknown → `.tri.stopped` with `checking…`
  - chips render as `.key-chip` with the text and `style.borderColor` = hue
  - `.wire.running` only on running wires; `.entry-line.running` only for running workflows; no `.running` on cache lines
  - a ghost node has class `ghost`, its name has `text-decoration: line-through` via `.ghost .bn-body` and shows
    `deleted · ghost`; a ghost wire has class `ghost`
- [ ] **Step 2: Run** `npx vitest run src/board/Board.test.tsx` — FAIL.
- [ ] **Step 3: Implement** with the Global Constraints values. Keep `PickBadge`, `UnsavedMark`, failure outline,
  `HealthDot` (in the header, right of the condition pill), `NodeToolbar` usage, handles (`in`/`out`, `tip`/`back`).
  Animations respect `prefers-reduced-motion` as today.
- [ ] **Step 4: Run** `npx vitest run src/board && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(acto): React Flow UI cards, S1 stopped triangles, running ring and ghost look`

### Task 5: Toolbars and the bar — ghosts, several triangles

**Files:**
- Modify: `src/Acto/src/board/Toolbar.tsx`, `src/Acto/src/board/selectionBar.ts`, `SelectionBarView.tsx`,
  `src/Acto/src/App.tsx` (wire ghost store, restore/remove, multi-triangle start/stop/delete),
  `src/Acto/src/operate/deleteWorkflow.ts` (accept several ids; one confirm)
- Test: `Toolbar.test.tsx`, `selectionBar.test.ts`, `src/Acto/src/App.test.tsx`

**Interfaces:**
- Produces: `ToolbarDeps` gains `restore(keys: string[]): void` and `removeGhosts(keys: string[]): void`;
  `toolbarFor({kind:'ghost'})` → `[Restore, Remove]`; `Bar` becomes
  `{ count; copy; del; restore; remove; run }` where `restore/remove` = every pick is a ghost, `run` = every pick is a
  triangle (then `del` = true too, `copy` false). Multi-triangle Delete runs each dry run, shows one confirm
  `Delete a, b? Their steps and caches stay.`, then deletes one by one (a running one is refused by its own dry run and
  reported; the rest go).
- [ ] **Step 1: Write the failing tests:** ghost toolbar labels `Restore`,`Remove`; bar for 2 ghosts
  `{restore:true, remove:true, del:false}`; bar for ghost + step → nothing common; bar for 2 triangles
  `{run:true, del:true}`; App: delete a step → ghost visible → click it → Restore → step real, Save count back to 0;
  Remove → ghost gone, Undo does not bring the ghost back but Undo of the delete brings the step.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Restore goes through `store.editOrRefuse((b) =>
  restoreGhosts(b, store.base(), items))`, so a refusal is an Output warning and success is one undo step.
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(acto): Restore · Remove on ghosts; Start · Stop · Delete on several triangles`

### Task 6: Inspector tabs, show all, pretty JSON

**Files:**
- Create: `src/Acto/src/inspector/tabs.ts` (pure), `src/Acto/src/inspector/MetaToggle.tsx`,
  `src/Acto/src/inspector/JsonField.tsx`, `src/Acto/src/model/json.ts` (`prettyJson`, `sameJson`, ported from
  `src/WorkflowStudio/src/store/entityForms.ts`), tab components under `src/Acto/src/inspector/tabs/`
  (`WorkflowTab`, `StepTab`, `ProcessorTab`, `AssignmentTab`, `CacheTab`, `LinkTab`, `GhostTab`)
- Modify: `InspectorPanel.tsx` (becomes the tab host), `ProcessorSection.tsx` (folded into `ProcessorTab`: three
  schemas stacked, **no Clear/In/Out/Config buttons**), `src/Acto/src/api/toModel.ts` + `design/board.ts` rows gain
  `createdAt: string | null; createdBy: string | null; updatedBy: string | null` (read-only; never sent — check
  `changes.ts` builds DTOs field by field and does not send them)
- Test: `tabs.test.ts`, `InspectorPanel.test.tsx`, `json.test.ts`, `toModel.test.ts`

**Interfaces:**
- Produces: `type TabId = 'workflow' | 'step' | 'processor' | 'cache' | 'link' | 'ghost' | \`assignment:${string}\``;
  `tabsOf(sel: SelectionState, b: BoardState, ghosts: GhostStore): { id: TabId; label: string; hue?: string }[]`;
  `formatInstant(iso: string | null): string` (`YYYY-MM-DD HH:MM:SS.mmm UTC`, `—` when null). Show-all state:
  sessionStorage key `acto.details` (`'1'` open), one for the whole Inspector.
- [ ] **Step 1: Write the failing tests** (`tabs.test.ts` per the spec §5 table):
  - step, no workflows → `['step','processor']`
  - step, workflows `['a','b']` both reaching it → `['step','processor','assignment:a','assignment:b']` with labels
    = workflow names and hues `#FF0072`, `#7C3AED`; one not reaching it → its tab absent
  - triangle(s) only → `['workflow']` for the last clicked; cache → `['cache']`; wire/entry/cacheLink → `['link']`;
    ghost → `['ghost']`; 2+ non-workflow picks → `[]` (pick list)
  - InspectorPanel: the first tab is active on a new pick; a chosen tab is kept while the same pick stays; `▸ show all`
    reveals Id/Created at/Created by/Updated at/Updated by and the toggle state survives switching tabs;
    the Processor tab shows `Input schema · …`, `Output schema · …`, `Config schema · …` headings with pretty JSON and
    no button named `In`, `Out`, `Config` or `Clear …`; the assignment tab shows the payload pretty and the check note
  - Review Focus 5: render a step's assignment tab, retype the payload in a different layout of the same JSON →
    `store.unsaved().size === 0`
  - `prettyJson('{"a":1}') === '{\n  "a": 1\n}'`; `prettyJson('not json') === 'not json'`; `sameJson('{"a":1}', '{ "a" : 1 }')`
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** `JsonField` keeps the typed text locally while focused, shows
  `prettyJson(value)` otherwise, and calls `onChange` only when the text is not `sameJson` with the current value.
  Workflow tab: entry steps and caches as chips with ✕ (removeEntries / unlinkCaches), assignments list, "Payload keys
  in its stream". Ghost tab: the snapshot's fields read-only + "Deleted — Restore or Remove from its toolbar".
- [ ] **Step 4: Run** `npx vitest run && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(acto): tabbed Inspector with show-all metadata and pretty JSON`

### Task 7: Studio's entry-condition picker

**Files:**
- Create: `src/Acto/src/inspector/ConditionPicker.tsx` and `ConditionMark.tsx` — ported from
  `src/WorkflowStudio/src/panels/ConditionPicker.tsx` and `src/WorkflowStudio/src/canvas/ConditionMark.tsx` (Acto's
  `model/entryConditions.ts` already has `CONDITIONS`/`conditionInfo`; drop the dock's `asNode` for
  `e.target instanceof Node`); CSS from `src/WorkflowStudio/src/panels/panels.css` `.cpick`… rules into the
  Inspector's stylesheet with Acto tokens
- Modify: `inspector/tabs/StepTab.tsx` (replaces the `SelectField`)
- Test: `src/Acto/src/inspector/ConditionPicker.test.tsx` (port Studio's `ConditionPicker.test.tsx` cases)

- [ ] **Step 1: Port the tests:** button shows pill + name; click opens a listbox of 5 options with ✓ on the current;
  ArrowDown/Enter picks; a letter key picks while closed; Escape closes without change; picking calls `onChange('4')`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Port** the component. **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(acto): Studio's entry-condition picker in the Step tab`

### Task 8: Chat follows the new selection; spec cross-check

**Files:**
- Modify: `src/Acto/src/chat/tools/*.ts` and the prompt text that mention "the selected workflow" or triangle
  multi-select; `docs/superpowers/specs/2026-11-18-acto-triangles-design.md` §6 and §10 gain a one-line pointer
  "superseded by 2026-11-18-acto-inspector-tabs-design.md" where they contradict it
- Test: the chat tool tests touched

- [ ] **Step 1:** tests: the board-read tool never lists ghosts; a selection tool that sets picks keeps `workflows`.
- [ ] **Step 2–4:** fail, implement, `npm test && npm run typecheck && npm run build` — PASS.
- [ ] **Step 5: Commit** `chore(acto): chat and spec follow several selected workflows`

### Task 9: Headed Playwright suite for Plan 6

**Files:**
- Create: `src/Acto/e2e/tabs.spec.ts`, `src/Acto/e2e/ghosts.spec.ts`, `src/Acto/e2e/motion.spec.ts`,
  `src/Acto/e2e/caches.spec.ts`
- Modify: `src/Acto/e2e/helpers.ts` (helpers: `tab(page, name)`, `ghost(page, name)`), existing specs whose selectors
  changed (`.nf` footer, `.dim`, inspector field labels)

Each test seeds its own `e2e-` rows (as the existing suite does) and cleans them up.
- [ ] **Step 1: Write the specs:**
  - tabs: step alone → tabs `Step`,`Processor`; triangle then step → `Step`,`Processor`,`<wf>`; Ctrl+click a second
    triangle then the shared step → two workflow tabs; show all reveals the five metadata rows; payload and schema
    definitions are pretty (a `pre`/textarea value contains `\n  "`); the condition picker opens by mouse, picks by
    keyboard letter, and the card's pill letter changes
  - ghosts: delete a step → ghost visible with `deleted · ghost`; Restore → real again; delete, Save, ghost still
    there; Restore → Save creates it again (Output `Saved …`); Remove → gone; Ctrl+click two ghosts → bar
    `Restore · Remove`; page reload → no ghosts
  - motion: no `.running` on any wire, entry arrow or step ring of the throwaway (stopped) workflows; for any real
    workflow the live store reports running, its entry arrow has `.running` (read-only check; skip when none runs)
  - caches: link one throwaway workflow to two throwaway caches by dragging from the triangle's back, Save, reload,
    both dashed lines and both chips in the Workflow tab are there
- [ ] **Step 2: Run** headless: `cd src/Acto && npx playwright test` — PASS (chat test skipped without key).
- [ ] **Step 3: Run headed** (visible window): `node scripts/e2e-watch.mjs` — PASS.
- [ ] **Step 4: Commit** `test(acto): headed e2e for tabs, ghosts, motion and several caches`

### Task 10: Deploy

- [ ] **Step 1:** `docker build -f src/Acto/Dockerfile -t acto:local .`, `docker save`, `ctr images import` into
  `desktop-control-plane`, `kubectl -n skp rollout restart deploy/acto`, restart the 18083 port-forward (k8s/README).
- [ ] **Step 2:** verify `curl http://localhost:18083/` serves the bundle name of `src/Acto/dist/assets/index-*.js`.
- [ ] **Step 3:** run `npx playwright test` against the deployed app once more — PASS.

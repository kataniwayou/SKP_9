# Handover 2026-10-08: SKP Studio plan 8 (virtual design, store + dry run + align)

Branch `feature/path-importer` (not pushed, not merged; the user has not chosen merge / PR / keep). Both plan 8
halves are deployed to the dev cluster (ns `skp`): BaseApi with the `AddWorkflowDesign` migration, and the studio
as `workflow-studio:local`, bundle `index-BC19MgmE.js`. Port forwards are supervised by
`./k8s/port-forward-realstack.ps1` (`-Status` to check, run it again to restart): studio `localhost:18081`,
BaseApi `localhost:18080`. Do not stop them by hand.

## Where we are

- **Plan 7 (junctions) is done and deployed** (`30996e5..a2a8c96`, handover `e38a2a3`). Spec
  `docs/superpowers/specs/2026-10-07-skp-studio-07-junctions-design.md`.
- **Plan 8 (virtual design) is BUILT and DEPLOYED.** Spec
  `docs/superpowers/specs/2026-10-07-skp-studio-08-virtual-design-design.md`; plan
  `docs/superpowers/plans/2026-10-07-skp-studio-08-virtual-design.md`. Executed subagent-driven (16 tasks, each
  reviewed). The SDD ledger is `.superpowers/sdd/2026-10-07-skp-studio-08-virtual-design/progress.md` (git-ignored).

## Built: plan 8 virtual design

**Commits.** Docs (spec, plan, handovers) `876c56d..HEAD`; code `e7db275..HEAD`. The first code commit is `e7db275`,
the nullable jsonb `Design` column. The last is `2ce5b40`, the view-restore fix below.

**What it does.**
- The designer opens a workflow with GETs only. There is no `POST /validate` anywhere in the studio; the live
  polls stay.
- Every edit is virtual: canvas edits go to the draft, Inspector edits to the entity edits. Edits to assignments
  (create, update, delete) are virtual too, and so are schema copies (same name and version, re-pointed on Save).
- The session keeps unsaved edits across a refresh.
- **Save** is `PUT /workflows/{id}/design`. It always stores the design on the workflow row (`Design`; the layout
  goes to `Layout`). It then dry-runs seven stages in one transaction (schemas, processors, caches, steps, wires,
  assignments, workflow), collecting every error with one savepoint per entity.
  - No errors: it commits, which aligns the real entities, and empties the stored design.
  - Errors: it rolls back and returns them. Problems lists them and Output logs one line per answer.
  - After every answer the document reloads with GETs.
- Owned entities (workflow, steps, assignments) are checked for conflicts ("changed by someone else since you
  opened it"). Shared entities (processors, caches) are last write wins, with a retry on xmin.
- Wires drop anywhere. Cycles are allowed and self is refused. Anything else becomes a grey dashed **loose wire**
  with an open end: it is kept in the layout and re-attaches when its end is dropped on a step. The hub draws its
  own loose wires.
- The legend shows the loose wire and has neither "broken" nor "parked"; an unwired step looks like any other.
- Closing a dirty document asks Save / Discard / Cancel.

**BaseApi.** Migration `AddWorkflowDesign`; deployed with fix `4275f3c`. Root cause of that fix: an
`x ?? new Dictionary<,>()` in a deconstructing `foreach` header crashed the IDE0028 collection-initializer analyzer
(AD0001) in SDK 8.0.4xx. Only the docker Release build hit it; the fallback is now hoisted to a local.

**Studio.** Bundle `index-BC19MgmE.js`. Fix `2ce5b40` is a pre-plan-8 view-restore bug that the production timing
exposed:
- A restored canvas lays out 26 px taller for one frame before the dock settles. `FollowSize` measured from that
  frame, so after a refresh the view came back 13 px off.
- Each saved view now carries the canvas size it was taken at, and a restore starts from that size.
- `session.spec.ts:12` failed 6 of 8 runs on the old deployed bundle and passes 8 of 8 now.

**After plan 8 (user request, 2026-10-08):** `55f5209`, `35c57ea`: a picked loose wire shows and uses the same
squares as a connected wire. Open-end square = the open circle (attach / move, bends kept); start square moves the
start onto another step or the hub (anywhere else snaps back); mid squares drag runs and the shape is kept
(`LooseWire.bends`, in the layout and the session); right-click Reset route clears it. Vitest 753; Playwright 59 + 2
skips on dev and on the deployed studio.

**More user requests (2026-10-08):** `988581e` no circle on hover at a connection point (the grab spot stays,
invisible) and the hub's pill shows only its state (no cron); `2b30b76` the Inspector's Description opens sized to
its text (cap 40vh); `f38cc40` + `e5f9001` a wire's tail (entry wires from the hub too) can be detached: the wire is
loose at its start, keeps its colour while its head is on a step or a junction, leaves nextStepIds / entryStepIds
until re-attached; a head dropped on nothing when the tail is already open is refused ("needs one end"); joined wires
follow a host re-attached to a new source (`was`). Follow-ups: wires joined on a detached host are drawn plain while
it is detached; a start-loose wire joined on a renamed host is not renamed (renameHost only rewrites routes).
Vitest 775; Playwright 65 + 2 skips on dev and on the deployed studio.

**Both ends open (user request, 2026-10-08):** `dffc157` removes "needs one end" (and "cannot start here" /
"start stays on a block"): a wire may be detached at its tail, head or both. Colour follows what is connected: head
on a step = the step's colour; head joined at a junction = the line's colour (joins only between same colours, chains
agree); head not connected = grey; nothing connected = grey dashed with an open circle at each end, outside the
workflow, kept in the layout and session. A both-open wire's head over a line moves (no colour to join with). Review
minors left: `was` lost when a both-open wire's start connects first; `isLooseEnd` uses `!('open' in l)`; stale
comments (designer.spec "snaps back", CableEdge doc, Inspector loose text); startBothEnd path builder duplicated.
Vitest 785; Playwright 66 + 2 skips on dev and on the deployed studio.

**Plan 9: wires as a circuit — BUILT and DEPLOYED (2026-10-08).** Spec
`docs/superpowers/specs/2026-10-08-skp-studio-09-wire-circuit-design.md` (aaba7cd), plan
`docs/superpowers/plans/2026-10-08-skp-studio-09-wire-circuit.md` (503f194), code 493f6fc..492b5a9, studio bundle
`index-BC19MgmE.js`. The circuit model: current flows one way hub → steps; a step's left side is its input (heads
only), its right side its output (tails only), ends slide anywhere along their side (16..144); tails anywhere around
the hub ring; tail and head junctions (fan-out / fan-in), position along a wire matters; family per net (head on a
step decides; junctions inherit); joining two families is a short circuit, refused while dragging; an Inspector edit
that makes one is listed in Problems, and Save stores the design as drawn but leaves every held-back source's list
as BaseApi had it ("Saved and applied; N short circuit(s) not written; M link(s) held back until fixed"). Open ends
keep the arrow head / ring; grey dashed while the family is undecided; four-way cursor on end squares. Old plan 7/8
layouts and sessions load and settle against BaseApi (a disagreeing junction is drawn plain). Tests: Vitest 802;
Playwright 93 + 2 skips on the dev server and on the deployed studio, incl. circuit.spec (one real-mouse test per
rule 1-14 + the base circuit rule) and circuit-save.spec (fan-in, fan-out, hub entries, held-back short circuit,
clean after Save + reload). Rulings (cost if wrong in brackets): ends slide the whole side minus corners (routing
changes); detaching a host opens its joined ends (spec over plan); short-circuit refusal when a merged net gains a
family (none known); settle opens only junctions whose links disagree (small); a shorted design is sent, held-back
sources keep their lists, settle leaves their links alone (a partial apply while a short exists); no false "design
draft" when the circuit equals the saved wiring; unrepresentable and self-links kept in saved lists (a step's link
to itself can't be removed from the designer — use BaseApi CRUD). Follow-ups: art.spec's pulse selector
(`.wire:not(.dashed)`) not yet run against a live workflow; junction draw vs traced order on a shortened host (plan
7 behaviour); withCircuit per run-drag move not memoised; settle's non-convergence warning is dev-only; creating new
wires deferred (spec §2.1).

**Wire drag (user request, 2026-10-08):** `fa8c137`, `f7e468c`. Cursors: open hand over a wire's body where there
is no square, closed hand while the body is dragged, two-way arrow over run squares, four-way over end squares.
Dragging the body moves the whole wire rigidly (shape frozen, stored as bends) and detaches it from every contact
point (tail, head, its own junction ends); wires joined on it get their ends opened. A press that moves less than a
grid step only picks. Run squares unchanged. An end square dragged across its last run adds exactly one corner (an
L); dropped on a step / the hub / a wire it connects per the circuit rules. On an open drop the other automatic end
is held at its drawn height (`held`, stored in the layout) and goes automatic again when the end reconnects.
Moved wires and L legs are not routed around blocks (as asked). Vitest 821; Playwright 96 + 2 skips on dev and
deployed. Spec §6 of plan 9 and the older specs carry superseded notes.

**Final whole-branch review fixes** (redeployed BaseApi and studio after them; deployed e2e 58 passed + 2 skips,
live 13/6/5 green):
- `c970732`: Revert and the Inspector's unsaved mark follow any edit entry, so a stale stamp with no changed
  fields (a wiring-only step, the workflow, a field typed back) can be cleared. Reverses the Task 8 ruling that
  stamp-only edits do not matter. Side effect: after a not-applied Save the workflow and wiring-only stored steps
  show "● unsaved changes" with Revert enabled (wording is a UX follow-up). A stored assignment delete with a stale
  stamp can only be cleared via ＋ Create → Revert → Remove (follow-up).
- `0aa4641`: a null element in a design's lists is a 400 naming list and index, not a 500 (nested nulls such as a
  null slot value are not yet guarded: follow-up).

**Tests.**
- BaseApi hermetic: 2017/2017.
- BaseApi live, on the deployed BaseApi: `WorkflowDesignLiveTests` 13/13, `WorkflowGraphLiveTests` 6/6,
  `WorkflowValidationLiveTests` 5/5.
- Vitest: 742 passed.
- Playwright on the dev server: 58 passed, 2 skipped (the expected `art.spec.ts` skips).
- Playwright on the deployed studio (`index-BC19MgmE.js`):
  - save + inspector + designer: 26/26.
  - whole suite: 58 passed, 2 skipped.
  - `session.spec.ts:12 --repeat-each=8`: 8/8.
- `e2e/save.spec.ts` writes only to a throwaway `e2e-8-…` workflow that it creates and deletes through BaseApi's
  CRUD. After every run, BaseApi lists no `e2e-8-…` entities.
- Every other spec fails on any request that is not a GET.

### Rulings made along the way

User:
- Subagent-driven execution.
- The legend loses "broken" (nothing is drawn broken without validate) as well as "parked".
- BaseApi and studio deploys approved.
- The plan's other rulings stand.

Controller (from the ledger):
- **F1:** the `Design` column test asserts `Relational:ColumnType` (InMemory throws on `GetColumnType()`).
- **F2-F5:** plan-mandated test updates to `inspectorTarget.test.ts` and `inspectorView.test.ts`. The DocumentPanel
  "● design draft" assertion was dropped (the App test covers it). The existing `SLOTS` is kept.
- **F6:** the legend test asserts "broken" and "parked" absent and the loose wire present.
- **F7-F9 (DRY):** one shared `portOf(placement, source)`, a `parseSlotKey` next to `slotKey`, and one
  `Describe(DesignOutcomeDto)` in `DesignBody`.
- **F10:** no-throw shape tests use `Assert.Null(Record.Exception(...))`.
- **F11:** this section is here, not in the plan 4 handover.
- **F12:** the dead client writes and the broken-wire plumbing stay (see follow-ups).
- Shared units (processors, caches) carry Postgres `xmin`. On a race they roll back to the savepoint and retry on a
  fresh load up to 3 times, then report "The database refused this change." If this is wrong, a shared save under
  heavy contention fails with a vague message.
- `isEmptyEdits` ignores stamp-only edits (they send nothing and cannot conflict).
- Tasks 11 and 12 were done as one commit and one review (Task 11 alone does not type-check). The Inspector
  coverage the plan dropped was added back.
- `canWire` checks `source === target` ("same step") before the not-a-step checks, so a hub wire or loose end
  dropped back on the hub snaps back.

### Follow-ups (deferred minors worth knowing)

- **F12, dead code:**
  - `putEntity`, `createAssignment` and `deleteAssignment` in `src/api/client.ts` are unused.
  - The broken-wire drawing plumbing is dead (`apply.ts` still copies `brokenEdges` from `saved.wires`).
- Commit `5bc0d63` has a "Claude Sonnet 5.5" co-author trailer instead of "Claude Opus 5.5". The branch is
  unpushed, so this can be fixed before merging, if wanted.
- BaseApi design save:
  - A wrong-typed non-nullable field (`"name": 7`) can give both the applier error and a second "required" error.
  - A JSON `null` element inside an entity list gives a 500 in `DesignShape` instead of a 400.
  - The exhausted-retry message is the same as the one for an unknown database failure.
  - `WireStage` re-validates all step fields, so a step whose stored fields are already invalid fails its wires.
  - Missing tests: a wiring-only step with a stale stamp; the `Apply` of processor and assignment updates; stale
    assignment and workflow stamps.
- Studio:
  - A schema edited back to its original value still makes a copy.
  - `apply.ts` repeats the `{ name, version, description }` spread per kind.
  - `applyEdits` re-routes on any edit.
  - The `body as unknown as DesignSaveRequest` cast in `saveDesign` can hide drift.
  - The close dialog's Save on a restored document that is not ready yet does nothing visible.
  - Sessions written before plan 8 lose their Inspector text on the first refresh after the deploy (one time only).
- e2e:
  - The hub snap-back check relies on a fixed 300 ms wait.
  - The "5 px short" test's loose branch depends on the live data.
- Plan 7 follow-ups (still not built):
  - Re-sourcing a joined wire drops its junction (should it survive?).
  - `canJoin` and routing disagree on ignored contacts.
  - Contacts on a deleted host revive if the id is redrawn.
  - A contact exactly on a host corner.
  - The preview re-routes on every pointer move.

### Open spec gaps (decided in the plan; the user may still override)

1. **A released tail cannot become a loose wire** (a loose wire needs its source). It snaps back with "cannot start
   here".
2. **A stale stamp in a stored design repeats its conflict.** Discard returns to the last saved design, which still
   has the old `updatedAt`, so every Save fails the same way. The user clears it with the Inspector's **Revert** on
   that entity.
3. **Broken-wire marks are gone.** They came from validate; the user ruled the legend item removed. The dead
   plumbing is a follow-up.
4. **"Save enabled when the design differs from the base"** is read as: unsaved edits, or a stored design not yet
   applied.
5. Cosmetic: the spec's decision numbers in §1 run 1-6, 9, 8, 7, and its edge cases in §6 run 1-4, 8, 5-7.

## Open question for the user

- Branch: merge to main / push + PR / keep.

## How we work (user rules, also in memory)

- Ask in prose, not multiple choice; "confirm" means verify against the code and cite it.
- **Every UI change is verified with Playwright using real mouse drags** (dev server and the deployed studio)
  before reporting; the user asked twice.
- A refresh must never lose work (documents, dock, drawing, drafts).
- GSD commands use hyphens (`/gsd-plan-phase`).

## Machine notes

- Run npm scripts from PowerShell (Git Bash `npm run` prints nothing); `npx vitest run`, `npx tsc -b`,
  `npx playwright test` work from `src/WorkflowStudio`; delete `tsconfig.tsbuildinfo` after `tsc -b`.
- Studio deploy: `docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .` →
  `kind load docker-image workflow-studio:local --name desktop` → `kubectl -n skp rollout restart deploy/workflow-studio`.
- E2E against the deployed studio: a temporary Playwright config (not committed) with `use.baseURL:
  'http://localhost:18081'` and no `webServer`. Timing bugs can show only there. To reproduce one without a
  redeploy, `vite build` plus `vite preview` on a free port (it proxies `/api` to 18080).
- The docker Release build compiles non-incrementally, so an analyzer crash (AD0001) that passes a local
  incremental build fails there. Check with `dotnet build -c Release --no-incremental` before deploying BaseApi.
- BaseApi tests: never `dotnet test`. Run the built `BaseApi.Tests.exe` with `--filter-class` (fully qualified).
  Live tests need `$env:SKP_REALSTACK='1'` and the forwards.
- Source files are a mix of CRLF and LF; subagents' text replacements silently missed once, so make them check
  `git diff`. Long bash heredocs with quotes broke several times: write Python edit scripts to the scratchpad
  instead.
- SDD workspaces live under `.superpowers/sdd/<plan>/` (git-ignored).
- Untracked, not ours: `.playwright-mcp/`, `.wf-restore.json`, `tools/simulate-*.py`.

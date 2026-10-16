# SKP Valence: handover (2026-10-16)

Start here, then read `docs/valence/valence-spec.md` (the full spec: decisions, schema, diagram rules, field rules).
This file records where the work stands at the restart and what comes next.

---

## 1. Where things are

| What | Where / state |
|---|---|
| Worktree | `C:\Users\UserL\source\repos\SK_P10-molecule-studio` |
| Branch | `feature/molecule-studio`, local only, never pushed. `1dd8453` = spec + stage-1 scaffold + mock; `0add1c9` = the shell, the molecule, the Inspector and this handover |
| Committed | Everything below is in `0add1c9` (2026-10-16). Commit only when the user asks. |
| Main repo folder | `C:\Users\UserL\source\repos\SK_P10` (`feature/in-process-post`, the user's own uncommitted work): **never touch it** |
| Checks at handover | `npx vitest run`: 19 files, **240 tests pass**. `npx tsc --noEmit`: clean |
| Dev server | `npx vite --port 5174 --strictPort` in `src/Valence` (was still running as PID 29824; stop it or reuse it) |
| BaseApi for the dev proxy | `localhost:18080`, already port-forwarded by another process (probably the user's) |
| Image / k8s | `valence:local` builds and runs locally. **Not loaded into kind, not applied.** Deploy only when asked: `kind load docker-image valence:local --name desktop`, then `kubectl apply -f k8s/32-valence.yaml` |

### Files of commit `0add1c9`
- Modified: `.gitignore` (`src/Valence/dist/`), `docs/valence/valence-spec.md`, `k8s/kustomization.yaml`,
  `k8s/port-forward-realstack.ps1` (Valence on 18082), `src/Valence/package.json` + lock (three 0.186.1, @types/three
  0.186.0), `src/Valence/src/dock/{DockShell.tsx, DockShell.test.tsx, keys.ts, layoutPersistence.ts, parts.tsx}`.
- New: `k8s/32-valence.yaml`, `src/Valence/{Dockerfile, nginx.conf, index.html, vite.config.ts}`,
  `src/main.tsx`, `src/App.tsx` (+ test), `src/api/project.ts` (+ test), `src/app/{ProjectDocument, WorkflowSelect,
  highlights, session, workspace, valence.css}` (+ tests), `src/molecule/{model, layout, fields, MoleculeView}`
  (+ tests), `src/panels/{Inspector, Panes}` (+ Inspector test), `src/test/fixtures/project.json`.

---

## 2. What is built (commit `0add1c9`)

**Stage 1, the shell.** SKP Studio's dock and theme, copied. Session key `skp.valence.session`, layout key
`skp.valence.layout`.
- **Menu strip** is brand + **View** + **Window**. The user: "this studio shows all workflows, you don't create new or
  delete by menu". Removed: Workspace and Edit menus, `onNewWorkflow`/`onDeleteWorkflow`/`deleteBlocked`, and Ctrl+N.
  The Load picker code is still there, unused.
- **The one document is named "Canvas"**. Its internal id stays `project`.

**Stage 2, the molecule** (dark version of the approved mock):
- **Data.** `api/project.ts` reads the six list endpoints and builds the project in the client.
- **Model and layout.** `molecule/model.ts` builds the molecule. `molecule/layout.ts` places one band per workflow (~0.4 s).
- **View.** `molecule/MoleculeView.tsx` uses three.js, loaded lazily on first draw.
- **Fixture.** `test/fixtures/project.json` holds the live rows of 2026-10-15: 7 workflows, 47 steps, 11 processors,
  24 schemas, 47 assignments, 1 cache.
- **Labels** show according to on-screen size. This is the only change from the mock.
- **Camera.** FOV 15°, which makes the balls truly round. `minDistance = 1.8/tan(FOV/2)`, and the far plane adjusts to
  the scene.
- **Slide.** Ctrl+drag on empty canvas slides along the screen's X and Y axes, done as a lens shift
  (`camera.setViewOffset`). Measured exact, also after a turn and when zoomed in.
- **Cursors.** Slide: grab when ready, grabbing while dragging. Moving an atom: `move`. Turning: the default arrow at
  rest, a custom circular-arrow SVG while dragging.
- **Arrows.** Each sits on its centre line. When a head would be hidden behind the target ball, the arrow ends at the
  ball's visible outline instead; this is recomputed whenever the camera moves.
- **Removed by the user.** The docbar ("Canvas / Workflows none highlighted ▾") and the hover card. Highlighting is
  off, but `WorkflowSelect`, `highlights.ts` and the session's `highlighted` field are kept for later.
- **Dev hook.** `el.__molecule` is for Playwright and is absent from the production build.

**The Inspector** (spec §3c; layout approved):
- **Hover and pin.** Hovering an atom previews it read-only. A click (under 5 px of movement, no Ctrl) pins it, and a
  click on empty canvas unpins. The pinned atom glows.
- **Open fields.** The kind, then every writable field that is not an arrow. Source hash and Instance id are writable.
  The schema Definition is listed with the writable fields but is read-only for now.
- **One closed "Read-only" section.** First the details, then an "arrows" divider, then the arrows. Its open/closed
  state is in localStorage `skp.valence.inspector.readonly`.
- **Edits stay virtual** (decision 8). Each edit marks its field label with an amber dot, shows the "● Changed in
  Valence only, not applied" note with Revert, marks the Canvas tab dirty, and shows an edited name on the canvas label.
  The session keeps the pin and the edits.
- **Checks while typing** follow BaseApi's rules: version `x.y.z`, Name ≤200, Description ≤2000, cron with 5 or 6
  fields, entry conditions 1–5, source hash of 64 lowercase hex characters, valid JSON, and the cache root/items rules.
- **Shared store.** `app/workspace.ts` holds data, molecule, hovered, pinned and edits, shared by the canvas and the panes.

---

## 3. Open: decide with the user next

1. **Where the apply step lives**, and how virtual edits reach BaseApi (`PUT /api/v1/{entity}/{id}` takes a whole row,
   spec §7). Proposed places: an "Apply" in the change note, on the Canvas tab, or in the menu strip. No answer yet.
2. **Menu strip approval.** It was changed as asked but never explicitly approved. The one-by-one review still has the
   toolbox, the Inspector (mostly done), the document and the output to go.
3. **The workflow multi-select.** Where it goes, or whether highlighting is dropped.
4. **Arrow edits** (they are read-only in the Inspector). On 2026-10-16 the user asked whether processor
   `archive-expander` (`4ad0d5d7-3a5c-4150-b543-b3bf7e944727`) may drop its **config** arrow to schema
   `archive-expander-config` (`9268ba11-76e7-4e2f-bc34-2fe0abba167f`) while steps use the processor. The answer, checked
   against the code and live data, was **yes**:
   - **Why it's allowed.** `processors.config_schema_id` is nullable. FK `fk_processor_config_schema_id` (RESTRICT)
     only protects the schema from deletion. Steps `split-archiveexpander` and `sc-split-archiveexpander` point at the
     processor, not at the schema. BaseApi's processor update rejects only `Guid.Empty` and has no in-use check.
   - **The schema becomes deletable.** It loses its only user, so its definition is no longer frozen.
   - **Payload checks stop.** `PayloadConfigSchemaValidator` skips a processor with no config schema, so those steps'
     payloads are no longer checked at workflow start.
   - **Running pods keep the old schema.** They keep enforcing it, and `SchemaDriftProbe` warns at every check, until
     the pods restart.
   - **Restarts don't restore the arrow.** The processors only read their schema slots at startup and never rewrite them.

   How Valence edits an arrow (Inspector or canvas) is not designed yet.
5. Spec §8 leftovers:
   - Keep or drop `GET /workflows/{id}/molecule`. §8 #1 is answered for now: the client reads the six endpoints.
   - `GET /model/fields` is not built.
   - There is no delete mode yet.
   - How a loop of next-step arrows is broken.

---

## 4. How to work (the user's rules)

- **Questions.** Ask in prose, not multiple choice. "Confirm" means verify against the code before building.
- **UI changes.** Check every one with real Playwright interactions before reporting. The Playwright MCP does not
  connect here, so drive Playwright from Node `.cjs` scripts:
  `require('C:/Users/UserL/source/repos/SK_P10/src/WorkflowStudio/node_modules/playwright')` with
  `chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })`. The earlier session's
  scripts were in its scratchpad and are gone, so write new ones.
- **Live data.** Checks touch only rows the check itself creates. So far every live check was a GET.
- **Bash.** Heredocs with quotes sometimes fail. Use the Write/Edit tools instead.
- **Spec.** Keep `docs/valence/valence-spec.md` up to date as decisions land.

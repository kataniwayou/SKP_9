# Handover 2026-10-08: SKP Studio plan 8 (virtual design, store + dry run + align)

Branch `feature/path-importer` (not pushed, not merged; the user has not chosen merge / PR / keep). Studio deployed
to the dev cluster as `workflow-studio:local` in ns `skp`, bundle `index-ByuqKojD.js` (plan 7 + its fixes). Port
forwards run as detached kubectl processes: studio `localhost:18081` (`svc/workflow-studio 18081:8080`), BaseApi
`localhost:18080` (`svc/baseapi-service 18080:8080`). Restart the studio forward after every studio redeploy.

## Where we are

- **Plan 7 (junctions) is DONE and deployed**: `30996e5..a2a8c96` (+ handover `e38a2a3`). A wire's arrow dropped on a
  same-colour line joins it (filled dot, split dot, branch with the only arrow head); one 8 px drop reach and the
  same green/red feedback for every dragged end (head, tail, contact, arrow, new wire, caches, hub). Also fixed: a
  refresh right after a zoom kept the old view (`60eed9f`). Vitest 774, Playwright 53 + 2 skips; designer e2e
  16/16 on the deployed studio. Spec `docs/superpowers/specs/2026-10-07-skp-studio-07-junctions-design.md`.
- **Plan 8 spec APPROVED by the user**: `docs/superpowers/specs/2026-10-07-skp-studio-08-virtual-design-design.md`
  (commits `876c56d`, `0975404`, `efa87a0`).
- **Plan 8 implementation plan WRITTEN, awaiting the user's review + execution choice**:
  `docs/superpowers/plans/2026-10-07-skp-studio-08-virtual-design.md` (`8cd794e`, 16 tasks, ~6300 lines; drafted by
  an agent, scanned for placeholders). I recommended **subagent-driven** (tasks are tightly coupled through the
  request shape of Tasks 2/8 → 13; a mistake in the backend dry run / rollback would write half a design to the
  live DB). Nothing of plan 8 is implemented yet.

## Plan 8 in one paragraph (the user's decisions, all confirmed)

The designer works offline on **virtual entities** (copies with the same ids, loaded with GETs only; no
`POST /validate`; the live-light polls stay). Edits: update the workflow, steps (fields + wiring), processors,
caches; create / update / delete assignments; a schema edit is a **background copy** (new id, same name **and
version**) re-pointed to its processor on save. Steps and assignments are never shared (new ids); processors,
schemas, caches are shared, **last write wins**. No create/delete of steps, processors, caches, schemas for now.
**Save** = `PUT /workflows/{id}/design` (new): (1) store the design on the workflow row (new jsonb `Design` column;
layout in `Layout`) **regardless of validity**, own commit, last write wins; (2) **dry run** all stages in one
transaction (schemas → processors → caches → step fields → wires → assignments → workflow), collecting every error
(savepoints); (3) no errors → commit (align the real entities) and empty the stored design; errors → roll back,
real entities untouched, errors to **Problems / Output**. Errors are never stored; opening runs no dry run. The
browser session keeps unsaved edits since the last Save. Wires drop anywhere: cycles allowed, self refused,
otherwise a **loose wire** (grey dashed, open end, kept in the layout, re-attachable). Legend gains the loose wire,
loses "parked"; unwired steps look normal. Start checks (BaseApi validators) are not this phase.

## Open questions for the user (asked, not answered)

1. Review the plan; choose **subagent-driven** or **native** execution.
2. Rulings the plan made where the spec was unclear (user may override):
   - a dragged **tail** cannot become loose (a loose wire needs its source): it snaps back with "cannot start here";
   - **conflict recovery**: if someone else changed an owned entity, every Save fails on it until that entity is
     **Reverted in the Inspector** (Discard design only drops unsaved edits; the stored design keeps the old stamp);
   - **"broken" in the legend**: nothing is drawn broken any more (no validate); the plan keeps the legend item, I
     proposed removing it — ask;
   - **Save enabled** = unsaved edits, or a stored design not yet applied.
3. Task 7 deploys BaseApi: ask the user before deploying.
4. Plan 7 follow-ups (not built): re-sourcing a joined wire drops its junction (should it survive?); `canJoin` vs
   routing on ignored contacts; contacts on a deleted host revive if the id is redrawn; contact exactly on a host
   corner; the preview re-routes on every pointer move.
5. Branch: merge to main / push + PR / keep.

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
  'http://localhost:18081'` and no `webServer`.
- Source files are a mix of CRLF and LF; subagents' text replacements silently missed once — make them check
  `git diff`. Long bash heredocs with quotes broke twice: write Python edit scripts to the scratchpad instead.
- SDD workspaces live under `.superpowers/sdd/<plan>/` (git-ignored); plan 7's was deleted after completion.
- Untracked, not ours: `.playwright-mcp/`, `.wf-restore.json`, `tools/simulate-*.py`.

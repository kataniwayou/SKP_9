# Handover: SKP Studio, plan 3d (2026-10-06)

**Start here in a fresh session.** Plan 3d is written and committed but **not started**. The user had not yet confirmed the plan when the context was cleared. Ask them to review it first. Once they agree, execute it with:

```
/superpowers:subagent-driven-development docs/superpowers/plans/2026-10-06-skp-studio-03d-a11y-tooltip-session.md
```

The user has always chosen subagent-driven.

## Where things stand

| Item | State |
|---|---|
| Branch | `feature/path-importer`, no worktree, no merge/PR (user's standing choice). HEAD `4edd3e7` (the plan 3d commit). |
| Plans 1, 1b, 2 | Done and deployed. |
| Plan 3a (dock) | Done and deployed (commits `ca48e74..7832696`). |
| Plan 3c (node art + live states) | Done and deployed (commits `d592b3d..8a300e8`). The cluster serves bundle `index-C_LDjeuu.js`. Unit 423, e2e 27. |
| **Plan 3d** | `docs/superpowers/plans/2026-10-06-skp-studio-03d-a11y-tooltip-session.md`, 8 tasks. Not started; no SDD workspace yet. |
| Next after 3d | Plan 3b (Inspector editing), then 4 (canvas editing), 5, 6 (Toolbox), 7 (junctions). |
| Spec | `docs/superpowers/specs/2026-10-05-skp-studio-design.md`. Plan 3d Task 7 amends §6.1, §6.2.2 and §10. |

## What plan 3d does (user requests, 2026-10-06)

1. **Accessibility pass** (deferred from the 3a/3c reviews):
   - the tab × and Problems items work from the keyboard;
   - the zoom level is an `<output>`;
   - menus give focus back and close on Tab;
   - the Picker follows the arrow keys and `aria-selected` follows it;
   - the switcher headings move out of its listboxes.
2. **Step tooltip:** hovering a step shows its unique name, entry condition, assignment, and a parked note when parked, the way the processor already shows its own.
3. **Refresh keeps everything:** a `skp.studio.session` localStorage entry holds:
   - the open documents (fetched again on load), the active tab, each selection, and each canvas view (zoom and scroll; a view still following Fit re-fits);
   - the dock with floating and auto-hidden panes (pop-outs come back docked);
   - the Inspector's show-all.

   It is written 300 ms after a change and at once on `pagehide`. Window › Save/Apply/Reset keep their separate named layout. At startup the session wins over it.

## The user's binding rule (also in memory)

"Imagine that you work hard and design a workflow without saving, and then you refresh page and everything goes back to first state or discards work." **A refresh must never lose anything.** Today the studio is read-only, so there are no drafts yet. From plan 3b on, every unsaved edit must be kept in the session as that document's draft, restored on reload and marked unsaved until saved or discarded. Plan 3d Task 7 writes this into spec §6.1 and §10.

## Other user instructions

- **Do not touch the Toolbox.** The user has modifications coming. That means `src/panels/PaneNote.tsx` and the Toolbox entries in `src/dock/ids.ts`.
- Ask before every deploy; the user approves each one explicitly.
- The user approves visual work by trying it. Open the page with `Start-Process http://localhost:18081`.
- The user answers in prose, and "confirm" means verify against the code or the running app.

## Known open items (in memory too)

- Final-review minors from 3c that stay open:
  - the `LiveArt` value changes identity on every poll;
  - the cost of the drop-shadow filters is unmeasured on big graphs (59 fps on 10 steps);
  - a revealed tab briefly shows "checking";
  - a vacuous reduced-motion e2e branch;
  - the e2e setup fetches every graph.
- Long chains open at Fit (about 32–56%). The user said "working well"; revisit only if they ask.

## Things the executor must know

- Run `npm run …` and `npm test` **in PowerShell** from `src/WorkflowStudio` (in Git Bash they print nothing). `npx` works anywhere.
- e2e needs BaseApi on `localhost:18080`. Check with `.\k8s\port-forward-realstack.ps1 -Status`.
- Deploy (after approval), from the repo root:
  - `docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .`
  - `kind load docker-image workflow-studio:local --name desktop`
  - `kubectl -n skp rollout restart deploy/workflow-studio`
  - then verify the served `assets/index-*.js` matches `src/WorkflowStudio/dist/assets`.
- Browser checks: chrome-devtools MCP with an `isolatedContext` works.
- Commit trailer: exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. State it in every implementer dispatch: a Haiku implementer once wrote its own model name.
- SDD habits that worked in 3c:
  - save `reviewer-instructions.md`, `implementer-instructions.md`, `re-review-instructions.md` and a `constraints.md` (the plan's Global Constraints and Review Focus) in the plan's workspace, and point dispatches at them;
  - run the final whole-branch review *before* the deploy task, so the cluster restarts once.
- Do not touch `.wf-restore.json`, `tools/simulate-*.py`, `.playwright-mcp/` or `docs/HANDOVER-*.md`. Stage files by name.

# Handover 2026-10-11 — running the SKP Studio tests

Read this first in a fresh session. It is everything needed to run, read and fix the studio's tests without the
conversation that built them.

## 1. Where things stand

- Branch `feature/path-importer`. Pushed to origin up to `6ae9644`. **Three local commits are not pushed:**
  - `7d5c35c` every applied Save publishes the studio's drawing for the Kibana dashboard (studio + BaseApi)
  - `ecf809a` Save is always offered once loaded and idle; its tooltip says why it is off
  - `b8d5de2` the dashboard diagram is the canvas art (canvas components rendered to one standalone SVG, legend below)
- **Do not commit `k8s/43-processor-analyst.yaml`.** It has an uncommitted edit: the user's new Kimi key, inline. The
  key also lives in the `skp-ai` Secret (studio AI route). Never print, copy or commit the key.
- Everything above is deployed to the dev kind cluster (`desktop`, namespace `skp`): `baseapi-service` and `workflow-studio`.

## 2. The two kinds of tests

| | Unit tests | Browser tests |
|---|---|---|
| Where | `src/WorkflowStudio/src/**/*.test.ts(x)` — 98 files, **1,123 tests** | `src/WorkflowStudio/e2e/*.spec.ts` — 29 files, **~185 tests** |
| Runner | Vitest in Node with jsdom (a simulated page) | Playwright, **headless Chromium** (no window), Desktop Chrome 1600×900 |
| Needs | nothing | BaseApi forwarded on **localhost:18080** |
| Writes | nothing | only `e2e-` throwaway entities it creates and deletes (see §5) |

Playwright starts its own Vite dev server on **port 5179** (`playwright.config.ts`), which proxies `/api` to
localhost:18080; it runs one test at a time (`workers: 1`) and keeps a trace of a failed test
(`npx playwright show-trace <test-results/…/trace.zip>`).

## 3. Commands (run npm/npx from PowerShell, in `src/WorkflowStudio`)

```powershell
# BaseApi on 18080 (the whole real stack: ..\..\k8s\port-forward-realstack.ps1; or just this one)
kubectl -n skp port-forward svc/baseapi-service 18080:80
# check it: curl http://localhost:18080/api/v1/workflows  -> 200

npx tsc -b; Remove-Item tsconfig.tsbuildinfo, tsconfig.*.tsbuildinfo -ErrorAction SilentlyContinue   # type check; ALWAYS delete the tsbuildinfo after
npx vitest run                                  # all unit tests (~75 s)
npx vitest run src/app/newWorkflow.test.ts      # one file
npx playwright test                             # all browser tests (~15 min)
npx playwright test e2e/newworkflow.spec.ts     # one spec
npx playwright test e2e/designer.spec.ts:197    # one test, by line
```

A port-forward dies when its pod restarts (every deploy). If a browser test fails with **502** from BaseApi or
`ERR_EMPTY_RESPONSE`, the forward is down: start it again and re-run.

BaseApi's own tests (.NET): `dotnet build src/tests/BaseApi.Tests` then
`src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe` (last run: 2,091 passed, 0 failed, 75 skipped).

## 4. The tests, starting with New workflow

### New workflow
`e2e/newworkflow.spec.ts` (3, browser):
1. New: a blank document with the hub on the left; renamed in the Inspector; Start and Delete wait; a refresh keeps it;
   Save creates it with a pasted step.
2. A taken name: Save refuses it in red and nothing is created; closing asks, and Discard drops it for good.
3. A blank workflow (no entry step) is saved as a design in progress; Start refuses it in red and nothing runs.

`src/app/newWorkflow.test.ts` (7, unit): untitled / untitled-N naming; a blank document (hub only, v1.0.0, nothing
read); opens ready, active and unsaved, Start/Stop/Delete wait; Save sends `newWorkflow` with no stamp; a refused
Save keeps it new, an applied one makes it ordinary and publishes its diagram; a refresh keeps it; Ctrl+N.

### Everything else (browser specs, test count)

| Area | Spec | Tests |
|---|---|---|
| Wires: drawing, junctions, open ends | `circuit.spec.ts` | 46 |
| Designer: moving, arrow keys, dragging wire ends | `designer.spec.ts` | 26 |
| Dock, panes, pop-outs, canvas size | `dock.spec.ts` | 17 |
| Copy and paste | `copypaste.spec.ts` | 9 |
| Node art | `art.spec.ts` | 8 |
| Overlapping wires (short circuits) | `overlap.spec.ts`, `overlap-save.spec.ts`, `overlap-siblings.spec.ts` | 7 + 1 + 1 |
| Saving wires | `circuit-save.spec.ts` | 6 |
| AI drawing: wand, lock, correction round | `aidrawing.spec.ts` | 5 |
| Inspector | `inspector.spec.ts`, `inspector-save.spec.ts` | 5 + 3 |
| Output | `output.spec.ts` | 5 |
| Save | `save.spec.ts` | 4 |
| Read-outs | `readout.spec.ts` | 4 |
| Delete workflow | `deleteworkflow.spec.ts` | 3 |
| Session (a refresh keeps everything) | `session.spec.ts` | 3 |
| Accessibility | `a11y.spec.ts` | 3 |
| Dashboard diagram (publish on Save, unchanged Save) | `diagram.spec.ts` | 2 |
| Toolbox | `toolbox.spec.ts`, `toolboxpick.spec.ts` | 2 + 2 |
| Save spinner | `spinner.spec.ts` | 2 |
| Processors | `processor.spec.ts` | 2 |
| Live status | `live.spec.ts`, `live-processor.spec.ts` | 2 + 1 |
| Cache items table | `cacheitems.spec.ts` | 1 |
| Start / Stop | `run.spec.ts` | 1 |
| Smoke | `smoke.spec.ts` | 1 |

List any spec's test names: `Select-String -Path e2e\<spec>.ts -Pattern "^test\('"`.

## 5. The write guard (`e2e/throwaway.ts`)

Specs that write import `test` from `./throwaway`, which routes every `/api/v1/**` request through `refusal()`:
GETs pass; a write passes only for this run's `e2e-…` throwaway — its Save (`PUT /workflows/{id}/design`), the
diagram that Save publishes (`PUT /workflows/{id}/diagram`, added 2026-10-11), Delete workflow, Start/Stop, and
workflows this run created through New. Any other write is aborted and fails the test. `createThrowaway` /
`removeThrowaway` make and clean up the entities (a schema, a processor, steps A → B, an assignment, a cache, a workflow).
Specs that only read import `test` from `@playwright/test` and must never write.

## 6. Known state of the results (last full runs, 2026-10-11)

- Unit: **1,123 passed**.
- Browser: **149 passed, 5 failed, 1 did not run** in the last wide run (the AI/diagram/spinner specs pass since).
  The 5 failures are **old** — they fail the same way on `c848b24`, before today's lock/diagram/Save work — and run
  on the user's **live** workflows, whose current drawings no longer match their expectations:
  - `designer.spec.ts:197` arrow keys nudge the picked step … (expects a wire path to change; it does not)
  - `designer.spec.ts:259` dragging the last run of a picked wire … slides where its arrow lands
  - `designer.spec.ts:584` a wire's head over a cache tag is a "move here" drop (gets "short circuit")
  - `designer.spec.ts:785` a wire's tail released on empty canvas leaves it open … (an offset of 19.9 px, expects < 6)
  - `dock.spec.ts:121` the canvas follows its size: re-fits until zoomed (768, expects > 788)
  Not investigated yet; the user has not asked. Likely fix: give each test a throwaway of its own instead of a live workflow.
- **Timing flakes** (pass when the file is run alone; seen under load in the full unit run):
  `App.test.tsx` "shows the toast once per failure streak", `App.live.test.tsx` "while the hub is not connected …".
- Vitest empties every `.css` import, `?raw` included, so the diagram's built-in styles are checked in
  `e2e/diagram.spec.ts`, not in `src/diagram/diagramSvg.test.ts`.

## 7. Rules the user holds (keep to them)

- "confirm" means: verify against the code, answer, and wait for "go ahead" before changing anything.
- Every designer change is verified with **real-mouse Playwright** before reporting; report failures with their output.
- Never use git worktrees. Commit on `feature/path-importer`; push only when asked.
- Never write to a real workflow in a test or a demo: throwaways only, or route every non-GET to `abort()` /
  answer it in the test (as the scratch capture of filefetcher-archiveexpander-chain did).
- Deploy order: BaseApi first, then the studio —
  `docker build -q -f src/<X>/Dockerfile -t <img>:local .` → `kind load docker-image <img>:local --name desktop` →
  `kubectl -n skp rollout restart deploy/<name>` (images `baseapi-service`, `workflow-studio`).
- Testing the **deployed** studio: a temporary `playwright.deployed.config.ts` with `baseURL: 'http://localhost:18081'`
  (forward `svc/workflow-studio 18081:80`), deleted afterwards.

## 8. Other ports that day

Studio 18081, Kibana 15601 (`svc/kibana 15601:5601`; dashboard `skp-operator-outcomes`), BaseApi 18080. Kibana caches
the diagram image for 60 s; after a Save, reload the dashboard with Ctrl+Shift+R.

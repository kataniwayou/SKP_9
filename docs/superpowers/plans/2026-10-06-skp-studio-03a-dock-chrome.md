# SKP Studio, Plan 3a of 7: Dock Chrome -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The plan-2 page becomes the studio's real chrome: a menu strip (File · Edit · View · Window) over a Visual Studio-style dock in which every workflow is a document tab with its own canvas and capsule toolbar (name, cron, live status, disabled Save/Start/Stop, its own zoom and Fit), and four shared tool panes (Inspector, Toolbox, Problems, Output) dock, float, pop out and auto-hide. Clicking a step, a processor die, a cache or the sphere selects it and fills a read-only Inspector; Problems lists the document's validate result and selects what a problem names.

**Architecture:** Three new units, as spec §3.1 names them. `store/` is a tiny external store (one reducer, `useSyncExternalStore`) holding the open documents, the active one, each document's selection and the Inspector's shared "show all" switch; it has no undo yet. `dock/` is the chrome: dockview through its React binding, the in-house auto-hide rails and flyout, the window-position menu, the switcher, layout persistence and the studio's keys; it knows documents only by id and asks the page to render a document or a pane (`renderDocument`, `renderTool`), so it imports nothing from `canvas/` or `panels/`. `panels/` holds the Inspector, Problems, Output and Toolbox bodies. `app/` composes a document panel (canvas + toolbar + live status) and `App.tsx` wires the store, the loader and the dock together. `canvas/` gains selection (a class on React Flow's node wrapper, never React Flow's own selection), per-document text fitters and zoom controls.

**Tech Stack:** as plan 2 (Vite 8.3.2, React 19.3.0, TypeScript 5.9.3, @xyflow/react 12.12.0, Vitest 5.0.3 + jsdom 30.1.2), plus **dockview-react 8.4.1** (which brings dockview 8.4.1 and dockview-core 8.4.1, MIT) and **@playwright/test 1.63.0** (Chromium 153, `chromium-1243`).

**Spec:** `docs/superpowers/specs/2026-10-05-skp-studio-design.md`, slice 3a (§10): §3.1 units, §5.4, §6.1–§6.3, the shared rules of §7, §7.3, §8, §9 (3a). The visual reference is the mockup `.superpowers/brainstorm/385-1791189446/content/skp-studio-dock-v49.html` (gitignored); every chrome value below (colours, sizes, fonts, z-index tokens, glyphs) is copied from it, and the auto-hide, re-dock and switcher logic is ported from its script.

## Global Constraints

- **Location.** The app lives in `src/WorkflowStudio`. Every command runs **from `src/WorkflowStudio`** unless it says otherwise; **commit steps run from the repository root**.
- **Shells.** Run `npm run …` and `npm test` **in PowerShell**: in Git Bash `npm run` prints nothing and exits 1. `npx …` works in either shell.
- **Pinned versions.** Exact versions only (no `^`, no `~`); `package-lock.json` is committed and the image builds with `npm ci`. `.npmrc` keeps `legacy-peer-deps=true` (a workaround for an npm 10.9.2 crash in its peer-set resolver). After any dependency change run `npm ls --all --legacy-peer-deps=false` and resolve every real conflict; `UNMET OPTIONAL DEPENDENCY` lines are expected and not conflicts.
- **Same origin only**, relative `/api/v1/` URLs (BaseApi has no CORS). In dev, Vite proxies `/api` to `http://localhost:18080` (the RealStack port-forward).
- **Read-only slice.** Slice 3a sends only `GET`s plus the existing validate `POST` dry run. Nothing is saved, started or stopped: Save, Start and Stop are disabled. Nothing on the canvas is draggable or connectable; only selection is added.
- **`model/` and `layout/` hold no React and no I/O.** `dock/` imports nothing from `canvas/`, `panels/`, `app/` or `store/`.
- **Rendering rules (spec §6.3).** Workflow documents use `renderer: 'always'`. Code inside a panel uses the panel's own document (`panel.getWindow().document`, an element's `ownerDocument`), never the global `document`: this covers the text fitter's measure canvas, font loading, overlays and listeners. Overlay layers are the tokens already in `src/canvas/tokens.css` and nothing else: auto-hide flyout `--z-fly` 1000, menus and pickers `--z-menu` 1010, toast `--z-toast` 1020, modal `--z-modal` 1030, switcher `--z-switcher` 1040, tooltip `--z-tip` 1050 (dockview's floating groups sit at 999 − 2).
- **Plan 2 keeps working:** the per-document canvas key (`<ReactFlowProvider key={workflow id}>`), the read-only surface props, and the font preload (every measured face loaded before a fitter is made).
- **Persistence.** The window layout lives in `localStorage` under `skp.studio.layout`, never in the database. Every `localStorage` access is wrapped in try/catch. Open documents are not restored on reload.
- **Fonts:** IBM Plex Sans Condensed and IBM Plex Mono through `@fontsource` (no CDN).
- **No backend code changes.**
- **Machine notes.** Windows; the Bash tool is Git Bash. Bash heredocs containing apostrophes or backticks fail on this machine: write every file with the Write tool (or Edit). Stage only the files a task names (never `git add -A`). Never touch `.wf-restore.json`, `tools/simulate-approved-feed.py`, `tools/simulate-unapproved-feed.py`, `.playwright-mcp/` or `docs/HANDOVER-*.md`. The kind cluster is named `desktop`.
- **Commits** end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (give it as a second `-m`).
- **Test commands.** Unit tests `npm test` (`vitest run`); types `npm run typecheck`; build `npm run build`; a focused run `npx vitest run src/dock`; end-to-end `npm run e2e` (`playwright test`, needs BaseApi on `localhost:18080`). A run that collects 0 tests is a failure, not a pass. The very first Vitest run in a fresh `node_modules` can time out while Vite pre-bundles; if it reports errors with no failed test names, run it once more before investigating.
- **Clean output.** A React warning in test output (`act(...)`, a missing `key`, "React Flow parent container needs a width and a height") is a defect to fix, not noise.

## Decisions taken while writing this plan (the user is told in the hand-off)

- **The React binding is `dockview-react`, not `dockview`.** Checked on npm and in the installed packages: `dockview` 8.4.1 is a pure re-export of `dockview-core` with no React code (`dockview/dist/cjs/index.d.ts:1`, `export * from 'dockview-core'`); the React binding is `dockview-react` 8.4.1 (`dockview-react/dist/cjs/index.d.ts:1-10`), which depends on `dockview` 8.4.1 → `dockview-core` 8.4.1. We use the binding rather than our own portals: it renders every panel, tab and header button as a React portal inside our tree, so panels share the store context, and React listens for events on each portal container, so clicks keep working after dockview moves a panel into a pop-out window. Only `dockview-react` is a direct dependency; the lock file pins the other two.
- **Auto-hide keeps a docked group's slot.** A docked group of tool panes is hidden in place with dockview's own group visibility (`group.api.setVisible(false)`), so pinning it back restores the exact slot and size for free. A floating, popped-out or document-sharing pane leaves the layout instead and goes back to its remembered home. Auto hide acts on the whole tab group (Problems and Output together), as Visual Studio does.
- **Exact re-dock memory** = the neighbour and side (or the tab group) the pane left, plus the boxes of every docked group at that moment; docking back re-applies those boxes. The dock uses `proportionalLayout: false` (the last group absorbs a size change, as in VS Code), so a rail appearing or disappearing never redistributes every group.
- **Window layout.** Window › Save / Apply / Reset are explicit; at startup the saved layout, if there is one and it is valid, is applied, else the default (documents left; Inspector 340 px and Toolbox 290 px to the right; Problems and Output tabbed, 150 px, under the documents). A saved layout never holds documents or pop-out windows: on Apply, the open documents are put into the saved document area and dockview moves them (`fromJSON(…, { reuseExistingPanels: true })`), so their canvases keep their viewport. A layout of another version, corrupted, or rejected by dockview gives the default layout and a toast.
- **What the graph already carries.** `GET /workflows/{id}/graph` returns the full read DTOs (`WorkflowGraphReader` maps every entity through BaseApi's own mappers), so description, audit fields, source hash, instance id and cache version were there all along; plan 2's model dropped them, and Task 2 keeps them. The one gap: a **parked** step's processor is read with `GET /processors/{id}`, and its schemas are not in the graph. The loader now reads exactly those with `GET /schemas/{id}` (one call per missing slot id); nothing else is fetched for the Inspector.
- **Selection.** A processor is selected through the die of one step, so only that die is highlighted. A problem selects: `cycle` → the first step of the chain this document holds; `missingStep` → the parent step, or the workflow when the parent is all zeros; `schemaEdge` → the child step (whose input does not match), else the parent; `payloadConfigSchema` → the step the assignment belongs to; `processorLiveness` → the processor (`procId`) on the first step that uses it.
- **Window-position menu.** Tool panes: Float/Dock, Dock as tabbed document, Auto hide, Close. Documents: Float/Dock, Maximize/Restore, Close document. The mockup's "new document group" items are not in the spec and are left out. View marks a shown pane with ✓.
- **Keys.** F5 and Shift+F5 are taken (no accidental reload) and answer with a toast "Start and Stop are not available yet."; Ctrl+O opens the picker; Esc closes the switcher, a menu, the picker or the flyout first, and only then clears the selection.
- **The picker re-reads the workflow list each time it opens**, so a workflow created or deleted since the page loaded shows correctly; a document whose workflow has gone says "This workflow no longer exists."
- **Pop-outs.** dockview opens pop-outs at `/popout.html` (its default); Task 1 adds that page. The shell renders the canvas's SVG definitions into every pop-out (gradient and filter ids are per document), and each document measures labels in its own document after loading its own fonts.
- **Plan 2's `?workflow=` URL parameter is dropped:** open documents are not restored on reload (spec §6.1).
- **Not `.shell`:** the shell's grid is `.studio-shell`, because `.shell` is the class of the blocks' SVG body rects; a page-level `.shell { height: 100vh }` stretches every block.

## Review Focus

1. **A saved window layout from an older version, corrupted, or one dockview rejects.** Expected: the default layout and a toast; never a blank or broken dock, never a thrown error. Tests: Task 5 (`layoutPersistence.test.ts`, `windowActions.test.ts`) and Task 7 (`DockShell.test.tsx`, three cases).
2. **A workflow deleted while the page is open.** Expected: opening it gives its tab "This workflow no longer exists." (the Inspector and Problems say so too), the tab can be closed, and the picker re-reads the list when it opens. Tests: Task 9 (`DocumentPanel.test.tsx`) and Task 10 (`App.test.tsx`).
3. **The live poll failing or answering oddly** (a 500, a network error, a body that is not a list, entries that are not strings or not GUIDs, ids in upper case). Expected: "status unknown" on failure, never "stopped"; odd entries skipped; polling only while the tab is visible. Tests: Task 9 (`liveStatus.test.ts`, `DocumentPanel.test.tsx`).
4. **A pop-out window losing fonts, the measure canvas or the SVG definitions.** Expected: labels measured in the pop-out's own document after its fonts load (the old fitter is kept meanwhile), every gradient and filter defined there, zoom working. Tests: Task 4 (`fitText.test.ts`, `useFitter.test.tsx`) and Task 11 (`dock.spec.ts`, the pop-out test).
5. **Dozens of open tabs.** Expected: every document panel exists and renders (`renderer: 'always'`), closing many at once leaves the right ones, and only the visible document polls the live status. Tests: Task 7 (`DockShell.test.tsx`, 40 documents) and Task 9 (`useLiveStatus` polls only while visible).

---

## File Structure

**New in `src/WorkflowStudio/`:**

| File | Responsibility |
|---|---|
| `playwright.config.ts`, `e2e/smoke.spec.ts`, `e2e/studio.ts`, `e2e/dock.spec.ts` | End-to-end tests against the dev server and the live BaseApi |
| `public/popout.html` | The blank same-origin page dockview opens pop-out windows on |
| `src/model/fixtures.ts`, `src/test/memoryStorage.ts`, `src/app/fixtures.ts` | Test-only builders |
| `src/store/selection.ts` | The `Selection` type and its key |
| `src/store/studioState.ts` | State, actions and the pure reducer |
| `src/store/studioStore.ts` | The external store and its React hooks |
| `src/store/problemTarget.ts` | The entity a validate problem names |
| `src/canvas/useFitter.ts` | One text fitter per document, after that document's fonts load |
| `src/canvas/selection.ts` | Selection classes on nodes; what a click selects |
| `src/canvas/ZoomControls.tsx` | Zoom and Fit for one canvas |
| `src/dock/ids.ts`, `dropRules.ts`, `home.ts`, `keys.ts` | Pure dock rules: panel ids, where documents may drop, re-dock homes, the studio's keys |
| `src/dock/layoutPersistence.ts` | Read, write, strip and re-fill the saved window layout |
| `src/dock/windowActions.ts` | Every dockview operation: document area, tools, float, dock back, auto-hide, reset, save, apply |
| `src/dock/Menu.tsx`, `Picker.tsx`, `Tooltip.tsx`, `Switcher.tsx`, `AutoHide.tsx`, `windowKey.ts` | Overlays and the rails, in the right window's document |
| `src/dock/parts.tsx` | Tabs, group header buttons, the watermark and the panel hosts |
| `src/dock/DockShell.tsx` | The chrome: menu strip, dockview, rails, menus, keys, persistence |
| `src/dock/dock.css` | Chrome styles (mockup v49) |
| `src/panels/inspectorView.ts`, `Inspector.tsx`, `Problems.tsx`, `PaneNote.tsx`, `panels.css` | The four pane bodies |
| `src/api/liveStatus.ts` | Reading the live set defensively |
| `src/app/panelHooks.ts` | A panel's own document, its visibility, the live-status poll |
| `src/app/CapsuleToolbar.tsx`, `src/app/DocumentPanel.tsx`, `src/app/document.css` | One document: canvas, toolbar, status |
| `src/App.fonts.test.tsx` | The font preload, in its own module scope |

**Modified:** `package.json`, `package-lock.json`, `tsconfig.json`, root `.gitignore`; `src/model/graph.ts`, `src/api/types.ts`, `src/api/toModel.ts`, `src/api/client.ts`, `src/api/fixtures.ts`, `src/app/loadDocument.ts`; `src/canvas/fitText.ts`, `src/canvas/WorkflowCanvas.tsx`, `src/canvas/SvgDefs.tsx`, `src/canvas/canvas.css`; `src/App.tsx`, `src/main.tsx`, `src/app.css`; tests `src/api/client.test.ts`, `src/api/toModel.test.ts`, `src/app/loadDocument.test.ts`, `src/canvas/toFlow.test.ts`, `src/layout/wires.test.ts`, `src/canvas/fitText.test.ts`, `src/canvas/WorkflowCanvas.test.tsx`, `src/App.test.tsx`.

---

### Task 1: Dependencies, the pop-out page and the end-to-end harness

**Files:**
- Modify: `src/WorkflowStudio/package.json`, `src/WorkflowStudio/package-lock.json` (regenerated), `src/WorkflowStudio/tsconfig.json`, root `.gitignore`
- Create: `src/WorkflowStudio/playwright.config.ts`, `src/WorkflowStudio/public/popout.html`, `src/WorkflowStudio/e2e/smoke.spec.ts`

**Interfaces:**
- Produces: the `dockview-react` 8.4.1 dependency (with `dockview` and `dockview-core` 8.4.1 in the lock file); `npm run e2e`; Playwright's Chromium installed; `/popout.html` served by Vite and by nginx (it is copied into `dist/`); TypeScript checks `e2e/` and `playwright.config.ts`.

- [ ] **Step 1: Replace `package.json`**

```json
{
  "name": "workflow-studio",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "e2e": "playwright test",
    "gen:api": "node scripts/gen-api.mjs"
  },
  "dependencies": {
    "@fontsource/ibm-plex-mono": "5.3.0",
    "@fontsource/ibm-plex-sans-condensed": "5.3.0",
    "@xyflow/react": "12.12.0",
    "dockview-react": "8.4.1",
    "elkjs": "0.12.0",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "devDependencies": {
    "@playwright/test": "1.63.0",
    "@testing-library/dom": "10.4.2",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.3",
    "@types/node": "26.6.4",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.2",
    "jsdom": "30.1.2",
    "openapi-typescript": "7.13.0",
    "typescript": "5.9.3",
    "vite": "8.3.2",
    "vitest": "5.0.3"
  }
}
```

- [ ] **Step 2: Install and check the dependency tree** (PowerShell)

```powershell
npm install
npm ls dockview-react dockview dockview-core @playwright/test
npm ls --all --legacy-peer-deps=false
```

Expected: `npm install` updates `package-lock.json`; `npm ls dockview-react …` prints `dockview-react@8.4.1`, under it `dockview@8.4.1`, under that `dockview-core@8.4.1`, and `@playwright/test@1.63.0`; the full `npm ls` lists no `invalid` or `ERESOLVE` lines (only `UNMET OPTIONAL DEPENDENCY` lines, which plan 2's tree already had). If anything else conflicts, stop and report it.

- [ ] **Step 3: Install Playwright's browser**

```bash
npx playwright install chromium
npx playwright --version
```

Expected: the download ends with `Chrome Headless Shell 153.0.8010.12 (playwright chromium-headless-shell v1243) downloaded to …\ms-playwright\chromium_headless_shell-1243` (or nothing to download when it is already there); `Version 1.63.0`. This was checked on this machine while the plan was written.

- [ ] **Step 4: Point TypeScript at the end-to-end code**

Replace `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vite/client", "node"]
  },
  "include": ["src", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

- [ ] **Step 5: Write the Playwright config, the pop-out page and a smoke test**

`playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests (spec §9) run against the Vite dev server, which proxies /api to the live
// BaseApi on localhost:18080 (k8s/port-forward-realstack.ps1). They only read: GETs and the
// validate dry run. Port 5179, so a dev server you already run on 5173 is left alone.
const PORT = 5179;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 900 } } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
```

`public/popout.html` (dockview's default pop-out URL is `/popout.html`; the page must be same-origin and empty, dockview fills it):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>SKP Studio</title>
    <style>html, body { margin: 0; height: 100%; background: #0A1220; overflow: hidden; }</style>
  </head>
  <body></body>
</html>
```

`e2e/smoke.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('the studio loads, and the dev server reaches BaseApi', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('SKP Studio');
  expect((await request.get('/api/v1/workflows')).ok()).toBe(true);
});
```

Append to the root `.gitignore`:

```
# SKP Studio end-to-end output
src/WorkflowStudio/test-results/
src/WorkflowStudio/playwright-report/
```

- [ ] **Step 6: Verify** (PowerShell; BaseApi must answer on `localhost:18080`, started by `k8s/port-forward-realstack.ps1`)

```powershell
npm run typecheck
npm test
npm run build
npm run e2e
```

Expected: typecheck prints nothing; `npm test` reports 19 test files and 141 tests passed (plan 2's suite, unchanged); the build lists `dist/popout.html`; `npm run e2e` starts Vite on port 5179 and reports `1 passed`. If BaseApi is not reachable the smoke test fails on `request.get('/api/v1/workflows')`: start the port-forward, do not change the test.

- [ ] **Step 7: Commit** (from the repository root)

```bash
git add .gitignore src/WorkflowStudio/package.json src/WorkflowStudio/package-lock.json src/WorkflowStudio/tsconfig.json src/WorkflowStudio/playwright.config.ts src/WorkflowStudio/public/popout.html src/WorkflowStudio/e2e/smoke.spec.ts
git commit -m "build(studio): dockview-react 8.4.1, Playwright 1.63.0 and the pop-out page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The model keeps what the Inspector shows

**Files:**
- Modify: `src/model/graph.ts`, `src/api/types.ts`, `src/api/toModel.ts`, `src/api/client.ts`, `src/api/fixtures.ts`, `src/app/loadDocument.ts`
- Create: `src/model/fixtures.ts` (tests only)
- Test: `src/api/toModel.test.ts`, `src/api/client.test.ts`, `src/app/loadDocument.test.ts`; adjust `src/canvas/toFlow.test.ts` and `src/layout/wires.test.ts` to the new model fields

**Interfaces:**
- Consumes: plan 2's model, client and loader.
- Produces:
  - `model/graph.ts`: `interface Audit { createdAt; createdBy: string | null; updatedAt; updatedBy: string | null }`; `Workflow`, `Step`, `Schema`, `Cache` gain `description: string | null` and `audit: Audit`; `Processor` gains `description`, `sourceHash: string`, `instanceId: string | null`, `audit`; `Cache` gains `version`.
  - `api/types.ts`: `SchemaReadDto`, `CacheReadDto`.
  - `api/toModel.ts`: `schemaFromDto(dto): Schema` (new export).
  - `api/client.ts`: `StudioApi.getSchema(id): Promise<ApiResult<SchemaReadDto>>` and `StudioApi.listLive(): Promise<ApiResult<unknown>>` (`GET /orchestration/live`, read defensively in Task 9).
  - `api/fixtures.ts`: `schemaDto(id, over?)`, `cacheDto(id, over?)`.
  - `model/fixtures.ts`: `AUDIT` (an empty `Audit` for model literals in tests).
  - `loadDocument` also reads, with `GET /schemas/{id}`, every schema a processor names that the graph does not carry (only a parked step's processor can); one it cannot read is left out.

Why: the Inspector shows each entity's description and "▸ show all" details (spec §7), the processor's source hash and instance id, and every schema slot by unique name. The graph DTO already carries all of it (BaseApi's `WorkflowGraphReader` returns full read DTOs); plan 2's model dropped it.

- [ ] **Step 1: Write the failing tests**

Replace `src/api/toModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from './fixtures';
import { graphFromDto, stepFromDto } from './toModel';

describe('graphFromDto', () => {
  it('converts every collection to maps keyed by id and keeps the layout opaque', () => {
    const graph = graphFromDto(graphDto({
      steps: [stepDto('s1', { nextStepIds: ['s2'] }), stepDto('s2', { entryCondition: 5 })],
      processors: [processorDto('p1', { outputSchemaId: 'sc1' })],
      schemas: [{ id: 'sc1', name: 'orders-out', version: '1.4.2', description: null, definition: '{}', createdAt: '', updatedAt: '', createdBy: null, updatedBy: null }],
      assignments: [{ id: 'a1', name: 'x', version: '1.0.0', description: null, stepId: 's1', payload: '{"k":1}', createdAt: '', updatedAt: '', createdBy: null, updatedBy: null }],
      caches: [{ id: 'c1', name: 'cache', version: '1.0.0', description: null, root: 'r', items: '{"a":"1"}', createdAt: '', updatedAt: '', createdBy: null, updatedBy: null }],
      layout: { steps: { s1: { x: 8, y: 16 } } },
    } as never));

    expect([...graph.steps.keys()]).toEqual(['s1', 's2']);
    expect(graph.steps.get('s1')!.nextStepIds).toEqual(['s2']);
    expect(graph.steps.get('s2')!.entryCondition).toBe(5);
    expect(graph.processors.get('p1')!.outputSchemaId).toBe('sc1');
    expect(graph.schemas.get('sc1')!.version).toBe('1.4.2');
    expect(graph.assignments).toEqual([{ id: 'a1', stepId: 's1', payload: '{"k":1}' }]);
    expect(graph.caches.get('c1')!.root).toBe('r');
    expect(graph.layout).toEqual({ steps: { s1: { x: 8, y: 16 } } });
  });

  it('turns missing optional lists into empty lists', () => {
    const graph = graphFromDto(graphDto({
      workflow: workflowDto({ assignmentIds: null, cacheIds: null } as never),
      steps: [stepDto('s1', { nextStepIds: null } as never)],
    }));

    expect(graph.workflow.cacheIds).toEqual([]);
    expect(graph.workflow.assignmentIds).toEqual([]);
    expect(graph.steps.get('s1')!.nextStepIds).toEqual([]);
  });

  it('maps an absent layout to null', () => {
    expect(graphFromDto(graphDto({ layout: undefined } as never)).layout).toBeNull();
  });
});

describe('the fields the Inspector shows', () => {
  it('keeps description, audit, source hash, instance id and cache version', () => {
    const who = { createdAt: '2026-10-01T08:00:00Z', createdBy: 'ana', updatedAt: '2026-10-02T09:30:00Z', updatedBy: null };
    const graph = graphFromDto(graphDto({
      workflow: workflowDto({ description: 'nightly', ...who }),
      steps: [stepDto('s1', { description: 'first', ...who })],
      processors: [processorDto('p1', { description: 'reads', sourceHash: 'f'.repeat(64), instanceId: 'blue', ...who })],
      schemas: [schemaDto('sc1', { description: 'in', ...who })],
      caches: [cacheDto('c1', { version: '2.0.0', description: 'lookups', ...who })],
    }));

    const audit = { createdAt: '2026-10-01T08:00:00Z', createdBy: 'ana', updatedAt: '2026-10-02T09:30:00Z', updatedBy: null };
    expect(graph.workflow).toMatchObject({ description: 'nightly', audit });
    expect(graph.steps.get('s1')).toMatchObject({ description: 'first', audit });
    expect(graph.processors.get('p1')).toMatchObject({ description: 'reads', sourceHash: 'f'.repeat(64), instanceId: 'blue', audit });
    expect(graph.schemas.get('sc1')).toMatchObject({ description: 'in', audit });
    expect(graph.caches.get('c1')).toMatchObject({ version: '2.0.0', description: 'lookups', audit });
  });

  it('turns absent audit fields into empty text and null, never undefined', () => {
    const graph = graphFromDto(graphDto({
      workflow: workflowDto({ createdAt: undefined, createdBy: undefined, updatedAt: undefined, updatedBy: undefined, description: undefined } as never),
    }));
    expect(graph.workflow.audit).toEqual({ createdAt: '', createdBy: null, updatedAt: '', updatedBy: null });
    expect(graph.workflow.description).toBeNull();
  });
});

describe('stepFromDto', () => {
  it('rejects a DTO without an id, because nothing downstream can key it', () => {
    expect(() => stepFromDto(stepDto('', { id: undefined } as never))).toThrow(/id/);
  });
});
```

In `src/api/client.test.ts`, make 1 edit (each "Replace" text occurs exactly once in the file):

1. Replace:

```ts
  it('maps a 200 whose body is not JSON to an error result instead of rejecting', async () => {
```

   with:

```ts
  it('GETs a schema by id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, { id: 'sc1' }));
    expect(await createApi('/api/v1', fetchImpl).getSchema('sc1')).toEqual({ ok: true, value: { id: 'sc1' } });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/schemas/sc1', expect.objectContaining({ method: 'GET' }));
  });

  it('GETs the live set and passes its body through untouched', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, ['a', 7]));
    expect(await createApi('/api/v1', fetchImpl).listLive()).toEqual({ ok: true, value: ['a', 7] });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/orchestration/live', expect.objectContaining({ method: 'GET' }));
  });

  it('maps a 200 whose body is not JSON to an error result instead of rejecting', async () => {
```

In `src/app/loadDocument.test.ts`, make 3 edits (each "Replace" text occurs exactly once in the file):

1. Replace:

```ts
import { graphDto, processorDto, stepDto } from '../api/fixtures';
```

   with:

```ts
import { graphDto, processorDto, schemaDto, stepDto } from '../api/fixtures';
```

2. Replace:

```ts
    getProcessor: vi.fn().mockResolvedValue(notFound),
    validate:
```

   with:

```ts
    getProcessor: vi.fn().mockResolvedValue(notFound),
    getSchema: vi.fn().mockResolvedValue(notFound),
    listLive: vi.fn(),
    validate:
```

3. Replace:

```ts
  it('ignores a parked id the server no longer has, and one that is actually wired (review focus 1)', async () => {
```

   with:

```ts
  it('reads the schemas a parked processor names that the graph does not carry, and only those', async () => {
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({
        processors: [processorDto('p1', { inputSchemaId: 'known' })],
        schemas: [schemaDto('known')],
        layout: { parked: ['pk'] },
      } as never))),
      getStep: vi.fn().mockResolvedValue(ok(stepDto('pk', { processorId: 'p9' }))),
      getProcessor: vi.fn().mockResolvedValue(ok(processorDto('p9', { inputSchemaId: 'known', outputSchemaId: 'sOut', configSchemaId: 'gone' }))),
      getSchema: vi.fn().mockImplementation(async (id: string) => (id === 'sOut' ? ok(schemaDto('sOut', { name: 'orders-out' })) : notFound)),
    });

    const result = await loadDocument(api, 'wf1');

    expect(api.getSchema).toHaveBeenCalledTimes(2);
    expect(api.getSchema).toHaveBeenCalledWith('sOut');
    expect(api.getSchema).toHaveBeenCalledWith('gone');
    expect(result.ok && result.value.graph.schemas.get('sOut')?.name).toBe('orders-out');
    expect(result.ok && result.value.graph.schemas.has('gone')).toBe(false);
  });

  it('ignores a parked id the server no longer has, and one that is actually wired (review focus 1)', async () => {
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/api src/app/loadDocument.test.ts`
Expected: FAIL. `fixtures` has no export `schemaDto`/`cacheDto`, `api.getSchema` and `api.listLive` are not functions, and the model has no `description` or `audit`.

- [ ] **Step 3: Extend the model and the DTO names**

Replace `src/model/graph.ts`:

```ts
/**
 * The graph as the studio reasons about it. Plain data: no React, no I/O.
 *
 * Steps belong to no workflow (spec §2): a workflow names its entry steps, and its step set is
 * whatever is reachable over `nextStepIds`. A wire is a `nextStepIds` entry on its source step.
 */
export type Id = string;

/**
 * The base-entity fields every BaseApi read DTO carries. The Inspector shows them under
 * "▸ show all" (spec §7). `updatedAt` here is for display; `Workflow.updatedAt` and
 * `Step.updatedAt` stay the concurrency tokens a later save sends back.
 */
export interface Audit {
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface Workflow {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  cronExpression: string | null;
  entryStepIds: Id[];
  assignmentIds: Id[];
  cacheIds: Id[];
  updatedAt: string;
  audit: Audit;
}

export interface Step {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  processorId: Id;
  nextStepIds: Id[];
  /** 0..5 on the wire; see model/entryConditions.ts. 0 is invalid but can still arrive. */
  entryCondition: number;
  updatedAt: string;
  audit: Audit;
}

export interface Processor {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  /** 64 lowercase hex characters (BaseApi's rule); shown whole in a tooltip, cut on screen. */
  sourceHash: string;
  instanceId: string | null;
  inputSchemaId: Id | null;
  outputSchemaId: Id | null;
  configSchemaId: Id | null;
  audit: Audit;
}

export interface Schema {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  audit: Audit;
}

export interface Assignment {
  id: Id;
  stepId: Id;
  /** JSON text. */
  payload: string;
}

export interface Cache {
  id: Id;
  name: string;
  version: string;
  description: string | null;
  root: string;
  /** JSON text of an object of string items. */
  items: string;
  audit: Audit;
}

/**
 * One problem BaseApi's validate reported (plan 1b). The studio never derives these: it only draws
 * them. `offending` is the gate's own object (for gate "schemaEdge": `{ parentStepId, childStepId }`).
 */
export interface WorkflowProblem {
  gate: string;
  title: string;
  detail: string;
  offending: unknown;
}

export interface Graph {
  workflow: Workflow;
  steps: Map<Id, Step>;
  processors: Map<Id, Processor>;
  schemas: Map<Id, Schema>;
  assignments: Assignment[];
  caches: Map<Id, Cache>;
  /** The stored canvas layout exactly as the server returned it (opaque JSON), or null. */
  layout: unknown;
}
```

Replace `src/api/types.ts`:

```ts
import type { components } from './schema';

// The wire shapes, exactly as BaseApi's OpenAPI document describes them. Swashbuckle 6.9 marks
// most reference-typed fields optional and nullable whatever the C# says, so the rest of the app
// never reads these directly: api/toModel.ts converts them to model/graph.ts once, at the edge.
type Schemas = components['schemas'];

export type WorkflowGraphDto = Schemas['WorkflowGraphDto'];
export type WorkflowReadDto = Schemas['WorkflowReadDto'];
export type StepReadDto = Schemas['StepReadDto'];
export type ProcessorReadDto = Schemas['ProcessorReadDto'];
export type SchemaReadDto = Schemas['SchemaReadDto'];
export type CacheReadDto = Schemas['CacheReadDto'];
export type WorkflowValidationDto = Schemas['WorkflowValidationDto'];
export type WorkflowProblemDto = Schemas['WorkflowProblemDto'];
```

Create `src/model/fixtures.ts`:

```ts
import type { Audit } from './graph';

/** Tests only: the audit block of a model literal that does not care about it. */
export const AUDIT: Audit = { createdAt: '', createdBy: null, updatedAt: '', updatedBy: null };
```

Replace `src/api/fixtures.ts`:

```ts
import type { CacheReadDto, ProcessorReadDto, SchemaReadDto, StepReadDto, WorkflowGraphDto, WorkflowReadDto } from './types';

// Builders for complete DTOs, so tests state only what they care about. Every field the server
// sends is present, which satisfies the generated types whether they mark fields optional or not.
const audit = { createdAt: '2026-10-05T12:00:00Z', updatedAt: '2026-10-05T12:00:00Z', createdBy: null, updatedBy: null };

export function stepDto(id: string, over: Partial<StepReadDto> = {}): StepReadDto {
  return {
    id, name: `step-${id}`, version: '1.0.0', description: null, processorId: 'p1',
    nextStepIds: [], entryCondition: 1, ...audit, ...over,
  } as StepReadDto;
}

export function processorDto(id: string, over: Partial<ProcessorReadDto> = {}): ProcessorReadDto {
  return {
    id, name: `proc-${id}`, version: '1.0.0', description: null, sourceHash: 'a'.repeat(64),
    instanceId: null, inputSchemaId: null, outputSchemaId: null, configSchemaId: null, ...audit, ...over,
  } as ProcessorReadDto;
}

export function schemaDto(id: string, over: Partial<SchemaReadDto> = {}): SchemaReadDto {
  return { id, name: `schema-${id}`, version: '1.0.0', description: null, definition: '{}', ...audit, ...over } as SchemaReadDto;
}

export function cacheDto(id: string, over: Partial<CacheReadDto> = {}): CacheReadDto {
  return { id, name: `cache-${id}`, version: '1.0.0', description: null, root: id, items: '{}', ...audit, ...over } as CacheReadDto;
}

export function workflowDto(over: Partial<WorkflowReadDto> = {}): WorkflowReadDto {
  return {
    id: 'wf1', name: 'orders', version: '1.0.0', description: null, entryStepIds: ['s1'],
    assignmentIds: [], cacheIds: [], cronExpression: null, ...audit, ...over,
  } as WorkflowReadDto;
}

export function graphDto(over: Partial<WorkflowGraphDto> = {}): WorkflowGraphDto {
  return {
    workflow: workflowDto(),
    steps: [stepDto('s1')],
    processors: [processorDto('p1')],
    schemas: [],
    assignments: [],
    caches: [],
    layout: null,
    ...over,
  } as WorkflowGraphDto;
}
```

- [ ] **Step 4: Map the new fields and add the two reads**

Replace `src/api/toModel.ts`:

```ts
import type { Assignment, Audit, Cache, Graph, Processor, Schema, Step, Workflow } from '../model/graph';
import type { CacheReadDto, ProcessorReadDto, SchemaReadDto, StepReadDto, WorkflowGraphDto, WorkflowReadDto } from './types';

// The generated DTO types mark almost every field optional (see api/types.ts). These helpers state
// once what the server actually guarantees, so the model never carries undefined.

function required(value: string | null | undefined, field: string): string {
  if (value === null || value === undefined || value === '') throw new Error(`The server sent no ${field}.`);
  return value;
}
const text = (value: string | null | undefined): string => value ?? '';
const optional = (value: string | null | undefined): string | null => value ?? null;
const list = (value: (string | null | undefined)[] | null | undefined): string[] =>
  (value ?? []).filter((v): v is string => typeof v === 'string' && v !== '');

type Audited = { createdAt?: string; createdBy?: string | null; updatedAt?: string; updatedBy?: string | null };
const audit = (dto: Audited): Audit => ({
  createdAt: text(dto.createdAt), createdBy: optional(dto.createdBy),
  updatedAt: text(dto.updatedAt), updatedBy: optional(dto.updatedBy),
});

export function workflowFromDto(dto: WorkflowReadDto): Workflow {
  return {
    id: required(dto.id, 'workflow id'),
    name: text(dto.name),
    version: text(dto.version),
    description: optional(dto.description),
    cronExpression: optional(dto.cronExpression),
    entryStepIds: list(dto.entryStepIds),
    assignmentIds: list(dto.assignmentIds),
    cacheIds: list(dto.cacheIds),
    updatedAt: text(dto.updatedAt),
    audit: audit(dto),
  };
}

export function stepFromDto(dto: StepReadDto): Step {
  return {
    id: required(dto.id, 'step id'),
    name: text(dto.name),
    version: text(dto.version),
    description: optional(dto.description),
    processorId: text(dto.processorId),
    nextStepIds: list(dto.nextStepIds),
    entryCondition: typeof dto.entryCondition === 'number' ? dto.entryCondition : 0,
    updatedAt: text(dto.updatedAt),
    audit: audit(dto),
  };
}

export function processorFromDto(dto: ProcessorReadDto): Processor {
  return {
    id: required(dto.id, 'processor id'),
    name: text(dto.name),
    version: text(dto.version),
    description: optional(dto.description),
    sourceHash: text(dto.sourceHash),
    instanceId: optional(dto.instanceId),
    inputSchemaId: optional(dto.inputSchemaId),
    outputSchemaId: optional(dto.outputSchemaId),
    configSchemaId: optional(dto.configSchemaId),
    audit: audit(dto),
  };
}

export function schemaFromDto(dto: SchemaReadDto): Schema {
  return {
    id: required(dto.id, 'schema id'), name: text(dto.name), version: text(dto.version),
    description: optional(dto.description), audit: audit(dto),
  };
}

function cacheFromDto(dto: CacheReadDto): Cache {
  return {
    id: required(dto.id, 'cache id'), name: text(dto.name), version: text(dto.version),
    description: optional(dto.description), root: text(dto.root), items: text(dto.items), audit: audit(dto),
  };
}

export function graphFromDto(dto: WorkflowGraphDto): Graph {
  const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, item]));

  const assignments: Assignment[] = (dto.assignments ?? []).map((a) => ({
    id: required(a.id, 'assignment id'), stepId: text(a.stepId), payload: text(a.payload),
  }));

  if (!dto.workflow) throw new Error('The server sent no workflow.');

  return {
    workflow: workflowFromDto(dto.workflow),
    steps: byId((dto.steps ?? []).map(stepFromDto)),
    processors: byId((dto.processors ?? []).map(processorFromDto)),
    schemas: byId((dto.schemas ?? []).map(schemaFromDto)),
    assignments,
    caches: byId((dto.caches ?? []).map(cacheFromDto)),
    layout: dto.layout ?? null,
  };
}
```

Replace `src/api/client.ts`:

```ts
import type { ProcessorReadDto, SchemaReadDto, StepReadDto, WorkflowGraphDto, WorkflowReadDto, WorkflowValidationDto } from './types';

/**
 * Every way a request can fail, as data. The UI shows these in its status line (Output in plan 5);
 * nothing in the app catches an exception from a request.
 */
export type ApiError =
  | { kind: 'notFound'; status: 404 }
  | { kind: 'badRequest'; status: 400; detail: string }
  | { kind: 'conflict'; status: 409; detail: string; entity: { kind: string; id: string } | null }
  | { kind: 'unprocessable'; status: 422; detail: string }
  | { kind: 'http'; status: number; detail: string }
  | { kind: 'network'; message: string };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface StudioApi {
  listWorkflows(): Promise<ApiResult<WorkflowReadDto[]>>;
  getGraph(workflowId: string): Promise<ApiResult<WorkflowGraphDto>>;
  getStep(stepId: string): Promise<ApiResult<StepReadDto>>;
  getProcessor(processorId: string): Promise<ApiResult<ProcessorReadDto>>;
  getSchema(schemaId: string): Promise<ApiResult<SchemaReadDto>>;
  /**
   * The running workflow ids (`GET /orchestration/live`, the `skp:live` set). Typed `unknown`
   * on purpose: callers read it defensively (api/liveStatus.ts), never trusting its shape.
   */
  listLive(): Promise<ApiResult<unknown>>;
  /** Plan 1b's dry run of the stored workflow: POST, no body. Saves and starts nothing. */
  validate(workflowId: string): Promise<ApiResult<WorkflowValidationDto>>;
}

interface Problem {
  title?: string;
  detail?: string;
  kind?: string;
  id?: string;
}

async function readProblem(response: Response): Promise<Problem> {
  try {
    return (await response.json()) as Problem;
  } catch {
    return {};
  }
}

async function toError(response: Response): Promise<ApiError> {
  if (response.status === 404) return { kind: 'notFound', status: 404 };
  const problem = await readProblem(response);
  const detail = problem.detail ?? problem.title ?? response.statusText;
  switch (response.status) {
    case 400:
      return { kind: 'badRequest', status: 400, detail };
    case 409:
      return {
        kind: 'conflict', status: 409, detail,
        entity: problem.kind && problem.id ? { kind: problem.kind, id: problem.id } : null,
      };
    case 422:
      return { kind: 'unprocessable', status: 422, detail };
    default:
      return { kind: 'http', status: response.status, detail };
  }
}

/** Relative URLs only: the studio is served from the same origin as BaseApi. */
export function createApi(base = '/api/v1', fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): StudioApi {
  async function request<T>(method: 'GET' | 'POST', path: string): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { method, headers: { Accept: 'application/json' } });
    } catch (e) {
      return { ok: false, error: { kind: 'network', message: e instanceof Error ? e.message : String(e) } };
    }
    if (!response.ok) return { ok: false, error: await toError(response) };
    try {
      return { ok: true, value: (await response.json()) as T };
    } catch (e) {
      return { ok: false, error: { kind: 'http', status: 0, detail: `Unreadable response: ${e instanceof Error ? e.message : String(e)}` } };
    }
  }

  const get = <T>(path: string) => request<T>('GET', path);
  const id = (value: string) => encodeURIComponent(value);

  return {
    listWorkflows: () => get<WorkflowReadDto[]>('/workflows'),
    getGraph: (workflowId) => get<WorkflowGraphDto>(`/workflows/${id(workflowId)}/graph`),
    getStep: (stepId) => get<StepReadDto>(`/steps/${id(stepId)}`),
    getProcessor: (processorId) => get<ProcessorReadDto>(`/processors/${id(processorId)}`),
    getSchema: (schemaId) => get<SchemaReadDto>(`/schemas/${id(schemaId)}`),
    listLive: () => get<unknown>('/orchestration/live'),
    validate: (workflowId) => request<WorkflowValidationDto>('POST', `/workflows/${id(workflowId)}/validate`),
  };
}
```

Replace `src/app/loadDocument.ts`:

```ts
import type { ApiResult, StudioApi } from '../api/client';
import { graphFromDto, processorFromDto, schemaFromDto, stepFromDto } from '../api/toModel';
import { parseLayout } from '../layout/layoutDoc';
import { place, type Placement } from '../layout/placement';
import { routeWires } from '../layout/wires';
import type { Graph, Id, WorkflowProblem } from '../model/graph';
import { reachableStepIds } from '../model/reachability';
import type { StudioDocument } from './document';

/**
 * Opens one workflow: the graph, then the parked steps its layout lists (they are not reachable, so
 * GET /graph does not return them; spec §4.3) and any processor they need, then placement and wires.
 * A parked id the server no longer has is dropped silently (spec §8); any other failure is returned.
 * Last, the schemas a parked step's processor names but the graph does not carry are read one by
 * one, so the Inspector and the die can name every slot; a schema that cannot be read is left out
 * (the slot then shows its raw id).
 * Any malformed part of the layout is ignored by `parseLayout`; missing blocks get an elkjs position.
 *
 * Whether the workflow may start is BaseApi's answer, not ours: one `validate` call supplies the
 * problems, and the wires a `schemaEdge` problem names are drawn broken. Validate is advisory: in
 * every non-200 case (400, 409, 422, network) `problems` stays null and the graph still loads.
 *
 * This never rejects: elkjs failures, a malformed body (a missing required field) or anything else
 * thrown becomes an error result (`http`, status 0).
 */
export async function loadDocument(api: StudioApi, workflowId: Id): Promise<ApiResult<StudioDocument>> {
  try {
    return await load(api, workflowId);
  } catch (e) {
    return { ok: false, error: { kind: 'http', status: 0, detail: `Could not open the workflow: ${e instanceof Error ? e.message : String(e)}` } };
  }
}

async function load(api: StudioApi, workflowId: Id): Promise<ApiResult<StudioDocument>> {
  const loaded = await api.getGraph(workflowId);
  if (!loaded.ok) return loaded;

  const graph: Graph = graphFromDto(loaded.value);
  const verdict = await api.validate(workflowId);
  const problems: WorkflowProblem[] | null = verdict.ok
    ? (verdict.value.problems ?? []).map((p) => ({
        gate: p.gate ?? '', title: p.title ?? '', detail: p.detail ?? '', offending: p.offending,
      }))
    : null;
  const brokenEdges = brokenEdgeKeys(problems ?? []);
  const layout = parseLayout(graph.layout);
  const reachable = reachableStepIds(graph.workflow.entryStepIds, graph.steps);
  const reachableSet = new Set(reachable);

  const parkedIds: Id[] = [];
  for (const id of layout.parked) {
    if (reachableSet.has(id)) continue;
    const step = await api.getStep(id);
    if (!step.ok) {
      if (step.error.kind === 'notFound') continue;
      return step;
    }
    const model = stepFromDto(step.value);
    graph.steps.set(id, model);
    parkedIds.push(id);
    if (!graph.processors.has(model.processorId)) {
      const processor = await api.getProcessor(model.processorId);
      if (processor.ok) graph.processors.set(model.processorId, processorFromDto(processor.value));
      else if (processor.error.kind !== 'notFound') return processor;
    }
  }

  await loadMissingSchemas(api, graph);

  let placement: Placement;
  try {
    placement = await place({
      entryStepIds: graph.workflow.entryStepIds,
      reachable: reachable.map((id) => ({ id, nextStepIds: graph.steps.get(id)!.nextStepIds })),
      parkedIds,
      cacheIds: [...graph.caches.keys()],
      layout,
    });
  } catch (e) {
    return { ok: false, error: { kind: 'http', status: 0, detail: `Layout failed: ${e instanceof Error ? e.message : String(e)}` } };
  }
  // routeWires only wires ends that are both placed and known, so every wire end has a position.
  const wires = routeWires({ entryStepIds: graph.workflow.entryStepIds, steps: graph.steps, brokenEdges }, placement);

  return { ok: true, value: { graph, parkedIds, placement, wires, problems } };
}

/** GET /schemas/{id} for every processor slot the graph names but does not carry (parked steps only). */
async function loadMissingSchemas(api: StudioApi, graph: Graph): Promise<void> {
  const missing = new Set<Id>();
  for (const p of graph.processors.values()) {
    for (const id of [p.inputSchemaId, p.outputSchemaId, p.configSchemaId]) {
      if (id && !graph.schemas.has(id)) missing.add(id);
    }
  }
  for (const id of missing) {
    const schema = await api.getSchema(id);
    if (schema.ok) graph.schemas.set(id, schemaFromDto(schema.value));
  }
}

/** `${parentStepId}->${childStepId}` for each schemaEdge problem; offending is read defensively. */
function brokenEdgeKeys(problems: WorkflowProblem[]): Set<string> {
  const keys = new Set<string>();
  for (const problem of problems) {
    if (problem.gate !== 'schemaEdge' || typeof problem.offending !== 'object' || problem.offending === null) continue;
    const { parentStepId, childStepId } = problem.offending as { parentStepId?: unknown; childStepId?: unknown };
    if (typeof parentStepId === 'string' && typeof childStepId === 'string') keys.add(`${parentStepId}->${childStepId}`);
  }
  return keys;
}
```

- [ ] **Step 5: Give plan 2's model literals the new fields**

The model types now require `description` and `audit` (and more on processors and caches), so two older tests need their literals completed. Nothing they assert changes.

In `src/canvas/toFlow.test.ts`, make 6 edits (each "Replace" text occurs exactly once in the file):

1. Replace:

```ts
import type { Graph, Step } from '../model/graph';
```

   with:

```ts
import { AUDIT } from '../model/fixtures';
import type { Graph, Step } from '../model/graph';
```

2. Replace:

```ts
  id, name: id, version: '1.0.0', processorId: 'p1', nextStepIds: [], entryCondition: 1, updatedAt: '', ...over,
```

   with:

```ts
  id, name: id, version: '1.0.0', description: null, processorId: 'p1', nextStepIds: [], entryCondition: 1, updatedAt: '', audit: AUDIT, ...over,
```

3. Replace:

```ts
    workflow: { id: 'wf1', name: 'orders', version: '1.0.0', cronExpression: null, entryStepIds: ['a'], assignmentIds: [], cacheIds: ['c1'], updatedAt: '' },
```

   with:

```ts
    workflow: { id: 'wf1', name: 'orders', version: '1.0.0', description: null, cronExpression: null, entryStepIds: ['a'], assignmentIds: [], cacheIds: ['c1'], updatedAt: '', audit: AUDIT },
```

4. Replace:

```ts
    processors: new Map([['p1', { id: 'p1', name: 'fetcher', version: '2.1.0', inputSchemaId: 'sIn', outputSchemaId: null, configSchemaId: null }]]),
```

   with:

```ts
    processors: new Map([['p1', { id: 'p1', name: 'fetcher', version: '2.1.0', description: null, sourceHash: '', instanceId: null, inputSchemaId: 'sIn', outputSchemaId: null, configSchemaId: null, audit: AUDIT }]]),
```

5. Replace:

```ts
    schemas: new Map([['sIn', { id: 'sIn', name: 'orders-in', version: '1.0.0' }]]),
```

   with:

```ts
    schemas: new Map([['sIn', { id: 'sIn', name: 'orders-in', version: '1.0.0', description: null, audit: AUDIT }]]),
```

6. Replace:

```ts
    caches: new Map([['c1', { id: 'c1', name: 'lookups', root: 'lk', items: '{"k1":"v","k2":"v"}' }]]),
```

   with:

```ts
    caches: new Map([['c1', { id: 'c1', name: 'lookups', version: '1.0.0', description: null, root: 'lk', items: '{"k1":"v","k2":"v"}', audit: AUDIT }]]),
```

In `src/layout/wires.test.ts`, make 2 edits (each "Replace" text occurs exactly once in the file):

1. Replace:

```ts
import type { Step } from '../model/graph';
```

   with:

```ts
import { AUDIT } from '../model/fixtures';
import type { Step } from '../model/graph';
```

2. Replace:

```ts
  id, name: id, version: '1.0.0', processorId: 'p', nextStepIds: next, entryCondition: 1, updatedAt: '', ...over,
```

   with:

```ts
  id, name: id, version: '1.0.0', description: null, processorId: 'p', nextStepIds: next, entryCondition: 1, updatedAt: '', audit: AUDIT, ...over,
```

- [ ] **Step 6: Run the tests, the whole suite and the typecheck** (PowerShell)

```powershell
npx vitest run src/api src/app/loadDocument.test.ts
npm test
npm run typecheck
```

Expected: the focused run passes (3 test files, 34 tests); `npm test` passes 19 test files, 146 tests; typecheck prints nothing.

- [ ] **Step 7: Commit** (from the repository root)

```bash
git add src/WorkflowStudio/src/model/graph.ts src/WorkflowStudio/src/model/fixtures.ts src/WorkflowStudio/src/api/types.ts src/WorkflowStudio/src/api/toModel.ts src/WorkflowStudio/src/api/toModel.test.ts src/WorkflowStudio/src/api/client.ts src/WorkflowStudio/src/api/client.test.ts src/WorkflowStudio/src/api/fixtures.ts src/WorkflowStudio/src/app/loadDocument.ts src/WorkflowStudio/src/app/loadDocument.test.ts src/WorkflowStudio/src/canvas/toFlow.test.ts src/WorkflowStudio/src/layout/wires.test.ts
git commit -m "feat(studio): keep descriptions, audit fields and schema names the Inspector shows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `store/`: open documents, the active one, selections

**Files:**
- Create: `src/store/selection.ts`, `src/store/studioState.ts`, `src/store/studioStore.ts`, `src/store/problemTarget.ts`
- Test: `src/store/studioState.test.ts`, `src/store/studioStore.test.tsx`, `src/store/problemTarget.test.ts`

**Interfaces:**
- Consumes: `StudioDocument` (`app/document.ts`), `Graph`, `WorkflowProblem`, `Id` (`model/graph.ts`).
- Produces:
  - `type Selection = { kind: 'workflow' } | { kind: 'step'; stepId } | { kind: 'processor'; processorId; stepId } | { kind: 'cache'; cacheId }`; `selectionKey(selection | null): string`.
  - `type DocStatus = { kind: 'loading' } | { kind: 'ready'; doc: StudioDocument } | { kind: 'failed'; message: string }`; `interface OpenDocument { workflowId; name; version; status: DocStatus; selection: Selection | null }`; `interface StudioState { docs: OpenDocument[]; activeId: Id | null; showDetails: boolean }`; `type StudioAction` (`open`, `loaded`, `failed`, `close`, `activate`, `select`, `toggleDetails`); `INITIAL_STATE`; `reduce(state, action)`; `activeDocument(state)`; `inspectorKey(state): string`.
  - `interface StudioStore { getState; dispatch; subscribe }`; `createStudioStore(initial?)`; `StudioStoreProvider`; `useStudioStore()`; `useStudio(selector)`.
  - `problemTarget(problem, graph): Selection | null`.

The reducer returns the same state object for any action that changes nothing (an unknown id, the same selection again), so `useSyncExternalStore` re-renders nothing.

- [ ] **Step 1: Write the failing tests**

`src/store/studioState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { StudioDocument } from '../app/document';
import { activeDocument, INITIAL_STATE, inspectorKey, reduce, type StudioAction, type StudioState } from './studioState';

const doc = {} as StudioDocument;
const run = (...actions: StudioAction[]): StudioState => actions.reduce(reduce, INITIAL_STATE);
const open = (workflowId: string): StudioAction => ({ type: 'open', workflowId, name: `wf-${workflowId}`, version: '1.0.0' });

describe('reduce', () => {
  it('opens a document as loading, activates it, and keeps the open order', () => {
    const state = run(open('a'), open('b'));
    expect(state.docs.map((d) => [d.workflowId, d.status.kind, d.name])).toEqual([['a', 'loading', 'wf-a'], ['b', 'loading', 'wf-b']]);
    expect(state.activeId).toBe('b');
  });

  it('opening a document that is already open only activates it', () => {
    const state = run(open('a'), open('b'), { type: 'select', workflowId: 'a', selection: { kind: 'workflow' } }, open('a'));
    expect(state.docs).toHaveLength(2);
    expect(state.activeId).toBe('a');
    expect(state.docs[0]!.selection).toEqual({ kind: 'workflow' });
  });

  it('records a load and a failure', () => {
    const state = run(open('a'), open('b'), { type: 'loaded', workflowId: 'a', doc }, { type: 'failed', workflowId: 'b', message: 'Not found.' });
    expect(state.docs[0]!.status).toEqual({ kind: 'ready', doc });
    expect(state.docs[1]!.status).toEqual({ kind: 'failed', message: 'Not found.' });
  });

  it('closing the active document activates the next one, else the previous, else none', () => {
    expect(run(open('a'), open('b'), open('c'), { type: 'activate', workflowId: 'b' }, { type: 'close', workflowId: 'b' }).activeId).toBe('c');
    expect(run(open('a'), open('b'), { type: 'close', workflowId: 'b' }).activeId).toBe('a');
    expect(run(open('a'), { type: 'close', workflowId: 'a' }).activeId).toBeNull();
  });

  it('closing another document keeps the active one', () => {
    const state = run(open('a'), open('b'), { type: 'close', workflowId: 'a' });
    expect(state.activeId).toBe('b');
    expect(state.docs.map((d) => d.workflowId)).toEqual(['b']);
  });

  it('keeps a selection per document', () => {
    const state = run(open('a'), open('b'),
      { type: 'select', workflowId: 'a', selection: { kind: 'step', stepId: 's1' } },
      { type: 'select', workflowId: 'b', selection: { kind: 'cache', cacheId: 'c1' } },
      { type: 'select', workflowId: 'b', selection: null });
    expect(state.docs.map((d) => d.selection)).toEqual([{ kind: 'step', stepId: 's1' }, null]);
  });

  it('returns the same state for an unknown id or an unchanged selection, so nothing re-renders', () => {
    const state = run(open('a'), { type: 'select', workflowId: 'a', selection: { kind: 'workflow' } });
    expect(reduce(state, { type: 'select', workflowId: 'zz', selection: null })).toBe(state);
    expect(reduce(state, { type: 'select', workflowId: 'a', selection: { kind: 'workflow' } })).toBe(state);
    expect(reduce(state, { type: 'close', workflowId: 'zz' })).toBe(state);
    expect(reduce(state, { type: 'activate', workflowId: 'a' })).toBe(state);
    expect(reduce(state, { type: 'loaded', workflowId: 'zz', doc })).toBe(state);
  });

  it('flips the shared show-all switch', () => {
    expect(run({ type: 'toggleDetails' }).showDetails).toBe(true);
    expect(run({ type: 'toggleDetails' }, { type: 'toggleDetails' }).showDetails).toBe(false);
  });
});

describe('activeDocument and inspectorKey', () => {
  it('follow the active document, its load and its selection', () => {
    const loading = run(open('a'));
    const loaded = reduce(loading, { type: 'loaded', workflowId: 'a', doc });
    const selected = reduce(loaded, { type: 'select', workflowId: 'a', selection: { kind: 'step', stepId: 's1' } });

    expect(activeDocument(INITIAL_STATE)).toBeNull();
    expect(activeDocument(selected)?.workflowId).toBe('a');
    expect(inspectorKey(INITIAL_STATE)).toBe('none');
    expect(new Set([inspectorKey(loading), inspectorKey(loaded), inspectorKey(selected)]).size).toBe(3);
    expect(inspectorKey(reduce(selected, { type: 'toggleDetails' }))).toBe(inspectorKey(selected));
  });
});
```

`src/store/studioStore.test.tsx`:

```tsx
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createStudioStore, StudioStoreProvider, useStudio } from './studioStore';

function ActiveId() {
  const id = useStudio((s) => s.activeId);
  return <span>{id ?? 'none'}</span>;
}

describe('createStudioStore', () => {
  it('notifies listeners on a change and not on a no-op', () => {
    const store = createStudioStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);

    store.dispatch({ type: 'open', workflowId: 'a', name: 'a', version: '1' });
    store.dispatch({ type: 'activate', workflowId: 'a' });
    stop();
    store.dispatch({ type: 'toggleDetails' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().showDetails).toBe(true);
  });

  it('re-renders a component that reads a slice when that slice changes', () => {
    const store = createStudioStore();
    render(<StudioStoreProvider value={store}><ActiveId /></StudioStoreProvider>);
    expect(screen.getByText('none')).toBeInTheDocument();

    act(() => store.dispatch({ type: 'open', workflowId: 'wf9', name: 'n', version: '1' }));

    expect(screen.getByText('wf9')).toBeInTheDocument();
  });

  it('says plainly when the provider is missing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ActiveId />)).toThrow(/StudioStoreProvider/);
    vi.restoreAllMocks();
  });
});
```

`src/store/problemTarget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { graphDto, processorDto, stepDto } from '../api/fixtures';
import { graphFromDto } from '../api/toModel';
import type { WorkflowProblem } from '../model/graph';
import { problemTarget } from './problemTarget';

const graph = graphFromDto(graphDto({
  steps: [stepDto('s1', { nextStepIds: ['s2'], processorId: 'p1' }), stepDto('s2', { processorId: 'p2' })],
  processors: [processorDto('p1'), processorDto('p2')],
  assignments: [{ id: 'a1', name: 'x', version: '1.0.0', description: null, stepId: 's2', payload: '{}', createdAt: '', updatedAt: '', createdBy: null, updatedBy: null }],
} as never));
const problem = (gate: string, offending: unknown): WorkflowProblem => ({ gate, title: 't', detail: 'd', offending });

describe('problemTarget', () => {
  it('cycle: the first step of the chain this document holds', () => {
    expect(problemTarget(problem('cycle', { stepChain: ['gone', 's2', 's1'] }), graph)).toEqual({ kind: 'step', stepId: 's2' });
  });

  it('missingStep: the parent step, or the workflow when the parent is all zeros (a missing entry step)', () => {
    expect(problemTarget(problem('missingStep', { parentStepId: 's1', missingChildId: 'x' }), graph)).toEqual({ kind: 'step', stepId: 's1' });
    expect(problemTarget(problem('missingStep', { parentStepId: '00000000-0000-0000-0000-000000000000', missingChildId: 'x' }), graph))
      .toEqual({ kind: 'workflow' });
  });

  it('schemaEdge: the child step, falling back to the parent', () => {
    expect(problemTarget(problem('schemaEdge', { parentStepId: 's1', childStepId: 's2' }), graph)).toEqual({ kind: 'step', stepId: 's2' });
    expect(problemTarget(problem('schemaEdge', { parentStepId: 's1', childStepId: 'gone' }), graph)).toEqual({ kind: 'step', stepId: 's1' });
  });

  it('payloadConfigSchema: the step the assignment belongs to', () => {
    expect(problemTarget(problem('payloadConfigSchema', { assignmentId: 'a1', errors: ['bad'] }), graph)).toEqual({ kind: 'step', stepId: 's2' });
  });

  it('processorLiveness: the processor (procId, not processorId) on the first step using it', () => {
    expect(problemTarget(problem('processorLiveness', { procId: 'p2', reason: '0 healthy' }), graph))
      .toEqual({ kind: 'processor', processorId: 'p2', stepId: 's2' });
    expect(problemTarget(problem('processorLiveness', { processorId: 'p2' }), graph)).toBeNull();
  });

  it.each([
    ['an unknown gate', problem('frozen', { stepId: 's1' })],
    ['offending null', problem('cycle', null)],
    ['offending a string', problem('schemaEdge', 's1->s2')],
    ['a chain that is not an array', problem('cycle', { stepChain: 's1' })],
    ['ids of the wrong type', problem('schemaEdge', { parentStepId: 1, childStepId: { id: 's2' } })],
    ['an id this document does not hold', problem('missingStep', { parentStepId: 'elsewhere' })],
    ['an unknown assignment', problem('payloadConfigSchema', { assignmentId: 'a9' })],
  ])('names nothing for %s, without throwing', (_name, p) => {
    expect(problemTarget(p, graph)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/store`
Expected: FAIL, `./studioState`, `./studioStore` and `./problemTarget` cannot be resolved.

- [ ] **Step 3: Implement the store**

`src/store/selection.ts`:

```ts
import type { Id } from '../model/graph';

/**
 * What the operator clicked on a document's canvas (spec §6.1). A processor is selected through
 * the die of one particular step, so the highlight lands on that die only. Nothing else is
 * selectable in slice 3a: wires, junctions and multi-select come with canvas editing.
 */
export type Selection =
  | { kind: 'workflow' }
  | { kind: 'step'; stepId: Id }
  | { kind: 'processor'; processorId: Id; stepId: Id }
  | { kind: 'cache'; cacheId: Id };

/** A stable string for a selection, for equality and for "did the Inspector's content change". */
export function selectionKey(selection: Selection | null): string {
  if (selection === null) return 'none';
  switch (selection.kind) {
    case 'workflow': return 'workflow';
    case 'step': return `step:${selection.stepId}`;
    case 'processor': return `processor:${selection.processorId}@${selection.stepId}`;
    case 'cache': return `cache:${selection.cacheId}`;
  }
}
```

`src/store/studioState.ts`:

```ts
import type { StudioDocument } from '../app/document';
import type { Id } from '../model/graph';
import { selectionKey, type Selection } from './selection';

/** Where one open document is in its life: being read, ready to draw, or failed with a message. */
export type DocStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: StudioDocument }
  | { kind: 'failed'; message: string };

export interface OpenDocument {
  workflowId: Id;
  /** From the picker's list, so the tab has a title before the graph arrives. */
  name: string;
  version: string;
  status: DocStatus;
  /** Kept per document, so switching tabs and coming back keeps it (spec §9). */
  selection: Selection | null;
}

/**
 * The studio's shared state. Slice 3a holds no drafts and no undo: nothing can be edited yet.
 * Open documents are not restored on reload (spec §6.1), so none of this is persisted.
 */
export interface StudioState {
  /** In the order they were opened. */
  docs: OpenDocument[];
  /** The document the shared panes (Inspector, Problems) follow: the one last activated. */
  activeId: Id | null;
  /** The Inspector's one "▸ show all" switch, shared by every entity (spec §7). */
  showDetails: boolean;
}

export type StudioAction =
  | { type: 'open'; workflowId: Id; name: string; version: string }
  | { type: 'loaded'; workflowId: Id; doc: StudioDocument }
  | { type: 'failed'; workflowId: Id; message: string }
  | { type: 'close'; workflowId: Id }
  | { type: 'activate'; workflowId: Id }
  | { type: 'select'; workflowId: Id; selection: Selection | null }
  | { type: 'toggleDetails' };

export const INITIAL_STATE: StudioState = { docs: [], activeId: null, showDetails: false };

const update = (state: StudioState, id: Id, change: (doc: OpenDocument) => OpenDocument): StudioState => {
  const index = state.docs.findIndex((d) => d.workflowId === id);
  if (index < 0) return state;
  const changed = change(state.docs[index]!);
  if (changed === state.docs[index]) return state;
  const docs = state.docs.slice();
  docs[index] = changed;
  return { ...state, docs };
};

/** Pure: every change to the studio's state goes through here. Unknown ids leave the state as it was. */
export function reduce(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'open': {
      if (state.docs.some((d) => d.workflowId === action.workflowId)) return { ...state, activeId: action.workflowId };
      const doc: OpenDocument = {
        workflowId: action.workflowId, name: action.name, version: action.version, status: { kind: 'loading' }, selection: null,
      };
      return { ...state, docs: [...state.docs, doc], activeId: action.workflowId };
    }
    case 'loaded':
      return update(state, action.workflowId, (d) => ({ ...d, status: { kind: 'ready', doc: action.doc } }));
    case 'failed':
      return update(state, action.workflowId, (d) => ({ ...d, status: { kind: 'failed', message: action.message } }));
    case 'close': {
      const index = state.docs.findIndex((d) => d.workflowId === action.workflowId);
      if (index < 0) return state;
      const docs = state.docs.filter((d) => d.workflowId !== action.workflowId);
      const activeId = state.activeId !== action.workflowId
        ? state.activeId
        : (docs[index] ?? docs[index - 1])?.workflowId ?? null;
      return { ...state, docs, activeId };
    }
    case 'activate':
      return state.docs.some((d) => d.workflowId === action.workflowId) && state.activeId !== action.workflowId
        ? { ...state, activeId: action.workflowId }
        : state;
    case 'select':
      return update(state, action.workflowId, (d) =>
        selectionKey(d.selection) === selectionKey(action.selection) ? d : { ...d, selection: action.selection });
    case 'toggleDetails':
      return { ...state, showDetails: !state.showDetails };
  }
}

export function activeDocument(state: StudioState): OpenDocument | null {
  return state.docs.find((d) => d.workflowId === state.activeId) ?? null;
}

/**
 * Changes whenever what the Inspector shows changes: another document, another selection, or the
 * document finishing its load. A hidden Inspector's rail tab glows when it changes (spec §6.2.5).
 */
export function inspectorKey(state: StudioState): string {
  const active = activeDocument(state);
  return active === null ? 'none' : `${active.workflowId}|${active.status.kind}|${selectionKey(active.selection)}`;
}
```

`src/store/studioStore.ts`:

```ts
import { createContext, useContext, useSyncExternalStore } from 'react';
import { INITIAL_STATE, reduce, type StudioAction, type StudioState } from './studioState';

/** A minimal external store around `reduce`: one state, one dispatch, change listeners. */
export interface StudioStore {
  getState(): StudioState;
  dispatch(action: StudioAction): void;
  subscribe(listener: () => void): () => void;
}

export function createStudioStore(initial: StudioState = INITIAL_STATE): StudioStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const StoreContext = createContext<StudioStore | null>(null);

/** Provides the store to the page. Dock panels are React portals, so they see it too. */
export const StudioStoreProvider = StoreContext.Provider;

export function useStudioStore(): StudioStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStudioStore needs a StudioStoreProvider above it.');
  return store;
}

/**
 * Reads a slice of the state and re-renders when it changes. The selector must return a value
 * that is stable while the state is unchanged (a slice, an existing object or a primitive), never
 * a fresh object or array: useSyncExternalStore compares with Object.is.
 */
export function useStudio<T>(selector: (state: StudioState) => T): T {
  const store = useStudioStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
```

`src/store/problemTarget.ts`:

```ts
import type { Graph, Id, WorkflowProblem } from '../model/graph';
import type { Selection } from './selection';

/** BaseApi names a missing *entry* step with an all-zero parent (the workflow is the parent). */
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * The entity a validate problem names, as a canvas selection, or null when it names nothing on this
 * canvas (spec §7.3). `offending` is typed `unknown` and read defensively: a field that is missing,
 * of the wrong type or naming an id this document does not hold gives null, never a throw.
 *
 * - cycle `{ stepChain }`: the first step of the chain this document holds;
 * - missingStep `{ parentStepId, missingChildId }`: the parent step; an all-zero parent is the workflow;
 * - schemaEdge `{ parentStepId, childStepId }`: the child (whose input does not match), else the parent;
 * - payloadConfigSchema `{ assignmentId, errors }`: the step the assignment belongs to;
 * - processorLiveness `{ procId, reason }`: the processor, on the first step that uses it.
 */
export function problemTarget(problem: WorkflowProblem, graph: Graph): Selection | null {
  const offending = problem.offending;
  if (typeof offending !== 'object' || offending === null) return null;
  const field = (name: string): unknown => (offending as Record<string, unknown>)[name];
  const step = (id: unknown): Selection | null =>
    typeof id === 'string' && graph.steps.has(id) ? { kind: 'step', stepId: id } : null;

  switch (problem.gate) {
    case 'cycle': {
      const chain = field('stepChain');
      if (!Array.isArray(chain)) return null;
      for (const id of chain) {
        const hit = step(id);
        if (hit) return hit;
      }
      return null;
    }
    case 'missingStep': {
      const parent = field('parentStepId');
      if (typeof parent === 'string' && parent.toLowerCase() === ZERO_GUID) return { kind: 'workflow' };
      return step(parent);
    }
    case 'schemaEdge':
      return step(field('childStepId')) ?? step(field('parentStepId'));
    case 'payloadConfigSchema': {
      const id = field('assignmentId');
      const assignment = graph.assignments.find((a) => a.id === id);
      return assignment ? step(assignment.stepId) : null;
    }
    case 'processorLiveness': {
      const id = field('procId');
      if (typeof id !== 'string' || !graph.processors.has(id)) return null;
      const user = firstStepUsing(graph, id);
      return user === null ? null : { kind: 'processor', processorId: id, stepId: user };
    }
    default:
      return null;
  }
}

function firstStepUsing(graph: Graph, processorId: Id): Id | null {
  for (const step of graph.steps.values()) if (step.processorId === processorId) return step.id;
  return null;
}
```

- [ ] **Step 4: Run the tests and the typecheck** (PowerShell)

```powershell
npx vitest run src/store
npm run typecheck
```

Expected: 3 test files, 24 tests passed; typecheck prints nothing.

- [ ] **Step 5: Commit** (from the repository root)

```bash
git add src/WorkflowStudio/src/store
git commit -m "feat(studio): store of open documents, the active document and selections" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Canvas selection, a fitter per document, and zoom controls

**Files:**
- Create: `src/canvas/useFitter.ts`, `src/canvas/selection.ts`, `src/canvas/ZoomControls.tsx`
- Modify: `src/canvas/fitText.ts`, `src/canvas/WorkflowCanvas.tsx`, `src/canvas/SvgDefs.tsx`, `src/canvas/canvas.css`
- Test: `src/canvas/selection.test.ts`, `src/canvas/useFitter.test.tsx`, `src/canvas/fitText.test.ts`, `src/canvas/WorkflowCanvas.test.tsx`

**Interfaces:**
- Consumes: `Selection` (Task 3), `SPHERE_NODE_ID`, `cacheNodeId`, `StudioNode` (`canvas/toFlow.ts`).
- Produces:
  - `loadMeasuredFonts(doc?: Document)` and `canvasMeasure(doc?: Document)` (default: the global document, so plan 2's callers are unchanged).
  - `fitterFor(doc): Promise<TextFitter>` (one per document, cached in a `WeakMap`); `useFitter(doc): TextFitter | null`.
  - `SELECTED_CLASS = 'studio-sel'`, `DIE_SELECTED_CLASS = 'studio-die-sel'`; `withSelection(nodes, selection)`; `selectionFromClick(node, target, graph)`.
  - `WorkflowCanvas` gains optional props `selection?: Selection | null`, `onSelect?: (s: Selection | null) => void` and `children?: ReactNode` (drawn inside its `ReactFlowProvider`); `FIT_VIEW_OPTIONS`.
  - `ZoomControls()`: −, the zoom level (`aria-label="Zoom level"`), +, Fit, for the canvas it is rendered in.
  - `SvgDefs` defines `#glow`, the mockup's selection glow.

React Flow's own selection stays off (`elementsSelectable={false}`): `onNodeClick` still fires (React Flow calls it whether or not a node is selectable), and the selection is drawn by a class on the node wrapper, which keeps the store the only owner of selection. The selection styles are the mockup's `.sel` rules, re-targeted at that wrapper class.

- [ ] **Step 1: Write the failing tests**

`src/canvas/selection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, stepDto } from '../api/fixtures';
import { graphFromDto } from '../api/toModel';
import { DIE_SELECTED_CLASS, SELECTED_CLASS, selectionFromClick, withSelection } from './selection';
import type { StudioNode } from './toFlow';

const nodes = [{ id: 'wf' }, { id: 's1' }, { id: 's2' }, { id: 'cache:c1' }] as StudioNode[];
const graph = graphFromDto(graphDto({
  steps: [stepDto('s1', { processorId: 'p1' }), stepDto('s2', { processorId: 'gone' })],
  processors: [processorDto('p1')],
  caches: [cacheDto('c1')],
} as never));

describe('withSelection', () => {
  it('returns the same array when nothing is selected', () => {
    expect(withSelection(nodes, null)).toBe(nodes);
  });

  it.each([
    [{ kind: 'workflow' } as const, 'wf', SELECTED_CLASS],
    [{ kind: 'step', stepId: 's2' } as const, 's2', SELECTED_CLASS],
    [{ kind: 'processor', processorId: 'p1', stepId: 's1' } as const, 's1', DIE_SELECTED_CLASS],
    [{ kind: 'cache', cacheId: 'c1' } as const, 'cache:c1', SELECTED_CLASS],
  ])('marks exactly one node for %o', (selection, id, className) => {
    const marked = withSelection(nodes, selection).filter((n) => n.className);
    expect(marked.map((n) => [n.id, n.className])).toEqual([[id, className]]);
  });

  it('marks nothing for a selection whose entity is not drawn', () => {
    expect(withSelection(nodes, { kind: 'step', stepId: 'elsewhere' }).some((n) => n.className)).toBe(false);
  });
});

describe('selectionFromClick', () => {
  const die = document.createElement('g');
  die.setAttribute('class', 'chipg');
  const inDie = document.createElement('rect');
  die.appendChild(inDie);
  const outside = document.createElement('rect');

  it('selects the sphere, a cache and a step', () => {
    expect(selectionFromClick({ id: 'wf', type: 'workflow' }, outside, graph)).toEqual({ kind: 'workflow' });
    expect(selectionFromClick({ id: 'cache:c1', type: 'cache' }, outside, graph)).toEqual({ kind: 'cache', cacheId: 'c1' });
    expect(selectionFromClick({ id: 's1', type: 'step' }, outside, graph)).toEqual({ kind: 'step', stepId: 's1' });
  });

  it('selects the processor when the click lands inside the die', () => {
    expect(selectionFromClick({ id: 's1', type: 'step' }, inDie, graph)).toEqual({ kind: 'processor', processorId: 'p1', stepId: 's1' });
  });

  it('falls back to the step when its processor is not in the graph', () => {
    expect(selectionFromClick({ id: 's2', type: 'step' }, inDie, graph)).toEqual({ kind: 'step', stepId: 's2' });
  });

  it('selects nothing for an unknown step or node type', () => {
    expect(selectionFromClick({ id: 'zz', type: 'step' }, outside, graph)).toBeNull();
    expect(selectionFromClick({ id: 'x', type: 'other' }, null, graph)).toBeNull();
  });
});
```

`src/canvas/useFitter.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fitterFor, useFitter } from './useFitter';

/** A stand-in document whose canvas measures every character as `px` wide and whose fonts load when told. */
function fakeDocument(px: number) {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => { release = resolve; });
  const doc = {
    fonts: { load: vi.fn(() => loaded), ready: loaded },
    createElement: () => ({ getContext: () => ({ font: '', measureText: (t: string) => ({ width: t.length * px }) }) }),
  } as unknown as Document;
  return { doc, release };
}

describe('fitterFor', () => {
  it('makes one fitter per document', () => {
    const { doc } = fakeDocument(1);
    expect(fitterFor(doc)).toBe(fitterFor(doc));
  });
});

describe('useFitter', () => {
  it('is null until the document fonts load, then measures in that document', async () => {
    const main = fakeDocument(2);
    const { result } = renderHook(() => useFitter(main.doc));
    expect(result.current).toBeNull();

    main.release();

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current!.width('abc', 'f')).toBe(6);
  });

  it('keeps the old fitter while a pop-out loads its fonts, then switches', async () => {
    const main = fakeDocument(2);
    main.release();
    const popout = fakeDocument(5);
    const { result, rerender } = renderHook(({ doc }) => useFitter(doc), { initialProps: { doc: main.doc } });
    await waitFor(() => expect(result.current).not.toBeNull());

    rerender({ doc: popout.doc });
    expect(result.current!.width('a', 'f')).toBe(2);

    popout.release();
    await waitFor(() => expect(result.current!.width('a', 'f')).toBe(5));
  });
});
```

In `src/canvas/fitText.test.ts`, make 2 edits (each "Replace" text occurs exactly once in the file):

1. Replace:

```ts
import { describe, expect, it } from 'vitest';
import { createTextFitter } from './fitText';
```

   with:

```ts
import { describe, expect, it, vi } from 'vitest';
import { canvasMeasure, createTextFitter, loadMeasuredFonts, MEASURED_FONTS } from './fitText';
```

2. Replace:

```ts
  it('measures through the injected measurer', () => {
    expect(fitter.width('abcd', 'f')).toBe(28);
  });
});
```

   with:

```ts
  it('measures through the injected measurer', () => {
    expect(fitter.width('abcd', 'f')).toBe(28);
  });
});

describe('measuring in the document the labels are drawn in (spec §6.3)', () => {
  it('canvasMeasure makes its canvas in the given document, once', () => {
    const measureText = vi.fn((t: string) => ({ width: t.length * 3 }));
    const createElement = vi.fn(() => ({ getContext: () => ({ font: '', measureText }) }));
    const popout = { createElement } as unknown as Document;

    const measure = canvasMeasure(popout);
    expect(createElement).not.toHaveBeenCalled();
    expect(measure('abcd', '10px x')).toBe(12);
    expect(measure('ab', '10px x')).toBe(6);
    expect(createElement).toHaveBeenCalledTimes(1);
  });

  it('loadMeasuredFonts loads every measured face in the given document', async () => {
    const load = vi.fn().mockResolvedValue([]);
    const popout = { fonts: { load, ready: Promise.resolve() } } as unknown as Document;

    await loadMeasuredFonts(popout);

    expect(load.mock.calls.map((c) => c[0]).sort()).toEqual([...MEASURED_FONTS].sort());
  });

  it('loadMeasuredFonts never rejects when a face fails to load', async () => {
    const popout = { fonts: { load: vi.fn().mockRejectedValue(new Error('404')), ready: Promise.resolve() } } as unknown as Document;
    await expect(loadMeasuredFonts(popout)).resolves.toBeUndefined();
  });
});
```

In `src/canvas/WorkflowCanvas.test.tsx`, make 3 edits (each "Replace" text occurs exactly once in the file):

1. Replace:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
```

   with:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
```

2. Replace:

```tsx
import { WorkflowCanvas } from './WorkflowCanvas';
```

   with:

```tsx
import { WorkflowCanvas } from './WorkflowCanvas';
import { ZoomControls } from './ZoomControls';
```

3. Replace:

```tsx
    expect(container.querySelector('.studio-canvas')).not.toBe(first);
  });
});
```

   with:

```tsx
    expect(container.querySelector('.studio-canvas')).not.toBe(first);
  });

  describe('selection (slice 3a)', () => {
    async function twoSteps() {
      const api = {
        getGraph: async () => ({ ok: true, value: graphDto({ steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'] }), stepDto('s2', { name: 'store' })] }) }),
        validate: async () => ({ ok: true, value: { valid: true, problems: [] } }),
      } as unknown as StudioApi;
      const r = await loadDocument(api, 'wf1');
      if (!r.ok) throw new Error('load failed');
      return r.value;
    }
    const node = (container: HTMLElement, id: string) => container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;

    it('reports a click on a step, on its die, on the sphere and on empty canvas', async () => {
      const onSelect = vi.fn();
      const { container } = render(<WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800} onSelect={onSelect} />);

      fireEvent.click(node(container, 's1'));
      fireEvent.click(node(container, 's2').querySelector('.chipg .diebody')!);
      fireEvent.click(node(container, 'wf'));
      fireEvent.click(container.querySelector('.react-flow__pane')!);

      expect(onSelect.mock.calls.map((c) => c[0])).toEqual([
        { kind: 'step', stepId: 's1' },
        { kind: 'processor', processorId: 'p1', stepId: 's2' },
        { kind: 'workflow' },
        null,
      ]);
    });

    it('marks the selected step, and a selected processor on its own step only', async () => {
      const doc = await twoSteps();
      const { container, rerender } = render(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} selection={{ kind: 'step', stepId: 's2' }} />);
      expect(node(container, 's2')).toHaveClass('studio-sel');
      expect(node(container, 's1')).not.toHaveClass('studio-sel');

      rerender(<WorkflowCanvas doc={doc} fitter={fitter} width={1200} height={800} selection={{ kind: 'processor', processorId: 'p1', stepId: 's1' }} />);
      expect(node(container, 's1')).toHaveClass('studio-die-sel');
      expect(node(container, 's2')).not.toHaveClass('studio-die-sel');
      expect(container.querySelectorAll('.studio-sel')).toHaveLength(0);
    });

    it('drives its own React Flow instance from controls passed as children', async () => {
      render(
        <WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800}>
          <ZoomControls />
        </WorkflowCanvas>,
      );
      const level = () => Number(screen.getByLabelText('Zoom level').textContent!.replace('%', ''));
      await waitFor(() => expect(level()).toBeGreaterThan(0));
      const before = level();

      fireEvent.click(screen.getByLabelText('Zoom in'));

      await waitFor(() => expect(level()).toBeGreaterThan(before));
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/canvas`
Expected: FAIL: `./selection`, `./useFitter` and `./ZoomControls` cannot be resolved; `canvasMeasure` ignores the document it is given.

- [ ] **Step 3: Measure in a given document**

In `src/canvas/fitText.ts`, make 2 edits (each "Replace" text occurs exactly once in the file):

1. Replace:

```ts
/** Requests every measured face, then waits for fonts to settle. Safe where `document.fonts` is missing (jsdom). */
export async function loadMeasuredFonts(): Promise<void> {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (!fonts) return;
```

   with:

```ts
/**
 * Requests every measured face in `doc`, then waits for its fonts to settle. Each document loads its
 * own faces: a pop-out window starts with none (spec §6.3). Safe where `fonts` is missing (jsdom).
 */
export async function loadMeasuredFonts(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): Promise<void> {
  const fonts = doc?.fonts;
  if (!fonts) return;
```

2. Replace:

```ts
/**
 * Measures with an offscreen 2D canvas. Call after `document.fonts.ready`. The context is created on
 * the first measurement, so merely creating the measurer touches no canvas (jsdom has none and logs
 * an error when one is asked for).
 */
export function canvasMeasure(): Measure {
  let context: CanvasRenderingContext2D | null | undefined;
  return (text, font) => {
    if (context === undefined) context = document.createElement('canvas').getContext('2d');
```

   with:

```ts
/**
 * Measures with an offscreen 2D canvas of `doc`, the document the labels are drawn in (its
 * `ownerDocument`, never the global one, so a pop-out measures with the fonts it has; spec §6.3).
 * Call after `loadMeasuredFonts(doc)`. The context is created on the first measurement, so merely
 * creating the measurer touches no canvas (jsdom has none and logs an error when one is asked for).
 */
export function canvasMeasure(doc: Document = document): Measure {
  let context: CanvasRenderingContext2D | null | undefined;
  return (text, font) => {
    if (context === undefined) context = doc.createElement('canvas').getContext('2d');
```

`src/canvas/useFitter.ts`:

```ts
import { useEffect, useState } from 'react';
import { canvasMeasure, createTextFitter, loadMeasuredFonts, type TextFitter } from './fitText';

// One fitter per document, made once that document's fonts have loaded. A WeakMap, so a closed
// pop-out window's entry goes with it.
const fitters = new WeakMap<Document, Promise<TextFitter>>();

/** The fitter for `doc`: measures in `doc` with `doc`'s fonts, after loading every measured face. */
export function fitterFor(doc: Document): Promise<TextFitter> {
  let fitter = fitters.get(doc);
  if (!fitter) {
    fitter = loadMeasuredFonts(doc).then(() => createTextFitter(canvasMeasure(doc)));
    fitters.set(doc, fitter);
  }
  return fitter;
}

/**
 * The text fitter for the document a canvas is drawn in. Null until the first one is ready. When
 * the canvas moves to another document (a pop-out), the previous fitter is kept until the new
 * document's fonts have loaded, so the labels never flash.
 */
export function useFitter(doc: Document): TextFitter | null {
  const [fitter, setFitter] = useState<TextFitter | null>(null);
  useEffect(() => {
    let live = true;
    void fitterFor(doc).then((f) => { if (live) setFitter(() => f); });
    return () => { live = false; };
  }, [doc]);
  return fitter;
}
```

- [ ] **Step 4: Selection, the glow and zoom**

`src/canvas/selection.ts`:

```ts
import type { Graph } from '../model/graph';
import type { Selection } from '../store/selection';
import { cacheNodeId, SPHERE_NODE_ID, type StudioNode } from './toFlow';

/** Classes on React Flow's node wrapper; canvas.css draws the mockup's selection from them. */
export const SELECTED_CLASS = 'studio-sel';
export const DIE_SELECTED_CLASS = 'studio-die-sel';

/** Which node wrapper carries which selection class. A processor is highlighted on one step's die. */
function selectedNode(selection: Selection): { id: string; className: string } {
  switch (selection.kind) {
    case 'workflow': return { id: SPHERE_NODE_ID, className: SELECTED_CLASS };
    case 'step': return { id: selection.stepId, className: SELECTED_CLASS };
    case 'processor': return { id: selection.stepId, className: DIE_SELECTED_CLASS };
    case 'cache': return { id: cacheNodeId(selection.cacheId), className: SELECTED_CLASS };
  }
}

/** The nodes with the selection marked. Pure; with nothing selected the same array comes back. */
export function withSelection(nodes: StudioNode[], selection: Selection | null): StudioNode[] {
  if (selection === null) return nodes;
  const { id, className } = selectedNode(selection);
  return nodes.map((n) => (n.id === id ? { ...n, className } : n));
}

/**
 * What a click on a node selects. A click inside a step's die (`.chipg`) selects that step's
 * processor, unless the step's processor is not in the graph (then the step itself).
 */
export function selectionFromClick(node: { id: string; type?: string }, target: Element | null, graph: Graph): Selection | null {
  switch (node.type) {
    case 'workflow':
      return { kind: 'workflow' };
    case 'cache':
      return { kind: 'cache', cacheId: node.id.slice(cacheNodeId('').length) };
    case 'step': {
      const step = graph.steps.get(node.id);
      if (!step) return null;
      if (target?.closest('.chipg') && graph.processors.has(step.processorId)) {
        return { kind: 'processor', processorId: step.processorId, stepId: step.id };
      }
      return { kind: 'step', stepId: step.id };
    }
    default:
      return null;
  }
}
```

In `src/canvas/SvgDefs.tsx`, make 1 edit (each "Replace" text occurs exactly once in the file):

1. Replace:

```tsx
        <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7" /></filter>
```

   with:

```tsx
        <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7" /></filter>
        {/* the selection glow (mockup v49 #glow): the selected block, die or sphere */}
        <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4" result="b" /><feFlood floodColor="#7DD3FC" floodOpacity=".45" /><feComposite in2="b" operator="in" /><feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge></filter>
```

Replace `src/canvas/WorkflowCanvas.tsx`:

```tsx
import { useMemo, type ReactNode } from 'react';
import { ReactFlow, ReactFlowProvider, type EdgeTypes, type FitViewOptions, type NodeTypes } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import type { Selection } from '../store/selection';
import { CableEdge } from './edges/CableEdge';
import { TetherEdge } from './edges/TetherEdge';
import type { TextFitter } from './fitText';
import { GridBackground } from './GridBackground';
import { Legend } from './Legend';
import { CacheNode } from './nodes/CacheNode';
import { StepNode } from './nodes/StepNode';
import { WorkflowNode } from './nodes/WorkflowNode';
import { selectionFromClick, withSelection } from './selection';
import { toFlow } from './toFlow';

// Defined outside the component, as React Flow requires, so they are not re-created per render.
const nodeTypes: NodeTypes = { workflow: WorkflowNode, step: StepNode, cache: CacheNode };
const edgeTypes: EdgeTypes = { cable: CableEdge, tether: TetherEdge };

/** The first fit and the Fit button frame the workflow the same way. */
export const FIT_VIEW_OPTIONS: FitViewOptions = { padding: 0.12, maxZoom: 1 };

interface Props {
  doc: StudioDocument;
  fitter: TextFitter;
  /** Only for tests, where jsdom has no layout. */
  width?: number;
  height?: number;
  /** The highlighted entity (slice 3a). Omitted: nothing is highlighted. */
  selection?: Selection | null;
  /** Called with what a click selects, or null for a click on empty canvas. Omitted: clicks do nothing. */
  onSelect?: (selection: Selection | null) => void;
  /** Drawn over the canvas inside its React Flow provider: the document's toolbar and zoom controls. */
  children?: ReactNode;
}

/**
 * The workflow canvas. Pan with Space+drag, the middle button or the wheel; Ctrl+wheel zooms at
 * the pointer (spec §5.4). Slice 3a makes it clickable (spec §6.1): a step, a processor die, a
 * cache or the sphere can be selected. Nothing can be dragged or connected, and React Flow's own
 * selection stays off: the selection lives in the store and is drawn with a class.
 */
export function WorkflowCanvas({ doc, fitter, width, height, selection = null, onSelect, children }: Props) {
  const { nodes, edges } = useMemo(() => toFlow(doc, fitter), [doc, fitter]);
  const shown = useMemo(() => withSelection(nodes, selection), [nodes, selection]);

  return (
    <ReactFlowProvider key={doc.graph.workflow.id}>
      <div className="studio-canvas" style={{ position: 'relative', width: width ?? '100%', height: height ?? '100%' }}>
        <ReactFlow
          nodes={shown}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          width={width}
          height={height}
          colorMode="dark"
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          minZoom={0.1}
          maxZoom={4}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          nodesFocusable={false}
          panOnScroll
          zoomOnScroll={false}
          zoomActivationKeyCode="Control"
          panOnDrag={[1]}
          panActivationKeyCode="Space"
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          onNodeClick={onSelect ? (event, node) => onSelect(selectionFromClick(node, event.target as Element, doc.graph)) : undefined}
          onPaneClick={onSelect ? () => onSelect(null) : undefined}
        >
          <GridBackground />
        </ReactFlow>
        <Legend />
        {children}
      </div>
    </ReactFlowProvider>
  );
}
```

`src/canvas/ZoomControls.tsx`:

```tsx
import { useReactFlow, useStore } from '@xyflow/react';
import { FIT_VIEW_OPTIONS } from './WorkflowCanvas';

/**
 * Zoom and Fit for one document (spec §6.1). It must be rendered inside that document's
 * WorkflowCanvas (its `children`), so it drives that canvas's own React Flow instance and no other.
 */
export function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  return (
    <div className="zoom">
      <button type="button" aria-label="Zoom out" data-tip="Zoom out" onClick={() => void zoomOut()}>−</button>
      <span aria-label="Zoom level">{`${Math.round(zoom * 100)}%`}</span>
      <button type="button" aria-label="Zoom in" data-tip="Zoom in" onClick={() => void zoomIn()}>+</button>
      <button type="button" className="fit" aria-label="Fit" data-tip="Fit this workflow" onClick={() => void fitView(FIT_VIEW_OPTIONS)}>Fit</button>
    </div>
  );
}
```

In `src/canvas/canvas.css`, make 2 edits (each "Replace" text occurs exactly once in the file):

1. Replace:

```css
.studio-canvas .react-flow__node { cursor: default; }
```

   with:

```css
.studio-canvas .react-flow__node { cursor: pointer; }
```

2. Replace:

```css
.legend .pill { font-family: var(--mono); font-size: 10px; border-radius: 3px; padding: 0 4px; color: #04111F; margin-right: 4px; font-weight: 600; }
```

   with:

```css
.legend .pill { font-family: var(--mono); font-size: 10px; border-radius: 3px; padding: 0 4px; color: #04111F; margin-right: 4px; font-weight: 600; }

/* hover and selection (mockup v49, the .sel rules); the selection class sits on React Flow's node wrapper */
.blk:hover .cap, .cachetag:hover .cap { filter: brightness(1.1); }
.wf:hover .sphere { filter: brightness(1.08); }
.chipg:hover .crim { stroke: #35598A; }
.studio-sel .blk .rimr, .studio-sel .cachetag .rimr { stroke: var(--accent); stroke-width: 1.8; stroke-dasharray: none; }
.studio-sel .blk .shell, .studio-sel .cachetag .shell { filter: url(#glow); }
.studio-sel .wf .sphere { filter: url(#glow); }
.studio-die-sel .chipg .crim { stroke: var(--accent); stroke-width: 1.6; }
.studio-die-sel .chipg .diebody { filter: url(#glow); }

/* a document's zoom (mockup v49 .zoom, .docbar .zoom) */
.zoom { display: flex; align-items: center; border: 1px solid var(--line-2); border-radius: 6px; overflow: hidden; background: rgba(14, 24, 40, .86); backdrop-filter: blur(6px); }
.zoom button { background: var(--panel-2); border: 0; color: var(--ink); width: 30px; height: 28px; cursor: pointer; font-size: 15px; }
.zoom button:hover { background: var(--line); }
.zoom button.fit { width: 38px; font-size: 11px; font-family: var(--sans); }
.zoom span { font-family: var(--mono); font-size: 12px; width: 52px; text-align: center; color: var(--muted); }
```

- [ ] **Step 5: Run the tests, the whole suite and the typecheck** (PowerShell)

```powershell
npx vitest run src/canvas
npm test
npm run typecheck
```

Expected: the focused run passes (7 test files, 45 tests) with no React warning; `npm test` passes 24 test files, 189 tests; typecheck prints nothing. Plan 2's page still uses `WorkflowCanvas` without the new props and is unchanged.

- [ ] **Step 6: Commit** (from the repository root)

```bash
git add src/WorkflowStudio/src/canvas/fitText.ts src/WorkflowStudio/src/canvas/fitText.test.ts src/WorkflowStudio/src/canvas/useFitter.ts src/WorkflowStudio/src/canvas/useFitter.test.tsx src/WorkflowStudio/src/canvas/selection.ts src/WorkflowStudio/src/canvas/selection.test.ts src/WorkflowStudio/src/canvas/ZoomControls.tsx src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx src/WorkflowStudio/src/canvas/WorkflowCanvas.test.tsx src/WorkflowStudio/src/canvas/SvgDefs.tsx src/WorkflowStudio/src/canvas/canvas.css
git commit -m "feat(studio): select on the canvas, measure per document, zoom per canvas" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `dock/` rules, layout persistence and window actions

**Files:**
- Create: `src/dock/ids.ts`, `src/dock/dropRules.ts`, `src/dock/home.ts`, `src/dock/keys.ts`, `src/dock/layoutPersistence.ts`, `src/dock/windowActions.ts`, `src/test/memoryStorage.ts` (tests only)
- Test: `src/dock/rules.test.ts`, `src/dock/layoutPersistence.test.ts`, `src/dock/windowActions.test.ts`, `src/dock/overlayTokens.test.ts`

**Interfaces:**
- Consumes: `dockview-react` (Task 1): `DockviewApi`, `DockviewGroupPanel`, `IDockviewPanel`, `SerializedDockview`, `SerializedFloatingGroup`, `SerializedGridObject`, `GroupviewPanelState`; in tests `createDockview`, `IContentRenderer`, `Orientation`.
- Produces:
  - `ids.ts`: `type ToolId = 'inspector' | 'toolbox' | 'problems' | 'output'`; `TOOL_IDS`; `TOOL_TITLES`; `isToolId`; `docPanelId(documentId)` (`doc:<id>`); `isDocPanelId`; `documentIdOf(panelId): string | null`.
  - `dropRules.ts`: `type DropKind`; `canDrop(dragged, kind, target, targetIsDocumentArea?)`.
  - `home.ts`: `type Side`, `Direction` (with `within`), `Position`, `Rect`, `GroupBox`, `Home { ref; direction; size; layout: GroupBox[] }`; `SIDE_DIRECTION`; `toPosition`; `sideOf(group, dock)`; `findHome(group, neighbours)`.
  - `keys.ts`: `type KeyCommand`; `keyCommand(e)`.
  - `layoutPersistence.ts`: `LAYOUT_KEY = 'skp.studio.layout'`; `LAYOUT_VERSION = 1`; `interface SavedLayout`; `browserStorage()`; `readLayout(storage)`; `writeLayout(storage, layout): boolean`; `stripDocuments(layout)`; `withDocuments(stripped, documentGroupId, documents, activeId)`.
  - `windowActions.ts`: `interface DockMemory { sides; homes; documentGroupId }`; `newMemory()`; `DEFAULT_SIDES`; `toolSide`; `documentArea`; `ensureDocumentArea`; `addDocument(api, memory, documentId, title)`; `recordHome`; `showTool`; `floatPanel`; `floatGroup`; `popOut`; `dockBack`; `autoHide(api, memory, panel, dock): ToolId[]`; `pinBack(api, memory, id): ToolId[]`; `dockAsDocument`; `resetLayout(api, memory, dockWidth)`; `captureLayout(api, memory, hidden): SavedLayout`; `applyLayout(api, memory, saved): ToolId[]` (throws when dockview rejects the layout).
  - `test/memoryStorage.ts`: `memoryStorage(initial?)`.

Everything here is logic without React. dockview's core runs in jsdom (no sizes, so the tests give homes directly or stub `getBoundingClientRect`), so the window actions are tested against a real dockview. The overlay test guards spec §6.3: the six tokens keep their values, and no stylesheet reaches dockview's floating groups (999) except through a token.

- [ ] **Step 1: Write the failing tests**

`src/test/memoryStorage.ts`:

```ts
/** Tests only: a Storage that keeps its items in memory, optionally starting with some. */
export function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => { data.delete(k); },
    setItem: (k, v) => { data.set(k, v); },
  };
}
```

`src/dock/rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canDrop } from './dropRules';
import { findHome, sideOf, toPosition } from './home';
import { docPanelId, documentIdOf, isDocPanelId, isToolId } from './ids';
import { keyCommand } from './keys';

describe('ids', () => {
  it('tells documents and tool panes apart', () => {
    expect(docPanelId('wf1')).toBe('doc:wf1');
    expect(isDocPanelId('doc:wf1')).toBe(true);
    expect(isDocPanelId('inspector')).toBe(false);
    expect(documentIdOf('doc:wf1')).toBe('wf1');
    expect(documentIdOf('problems')).toBeNull();
    expect(isToolId('output')).toBe(true);
    expect(isToolId('doc:output')).toBe(false);
  });
});

describe('canDrop (spec §6.2.4)', () => {
  it('lets a tool pane go anywhere, the layout edge included', () => {
    expect(canDrop(['inspector'], 'edge', null)).toBe(true);
    expect(canDrop(['problems'], 'content', ['doc:a'])).toBe(true);
    expect(canDrop(['problems'], 'tab', ['toolbox'])).toBe(true);
  });

  it('lets a document go only into or beside a group that holds a document', () => {
    expect(canDrop(['doc:a'], 'content', ['doc:b'])).toBe(true);
    expect(canDrop(['doc:a'], 'tab', ['inspector', 'doc:b'])).toBe(true);
    expect(canDrop(['doc:a'], 'content', ['inspector'])).toBe(false);
    expect(canDrop(['doc:a'], 'header_space', ['toolbox'])).toBe(false);
    expect(canDrop(['doc:a'], 'edge', null)).toBe(false);
    expect(canDrop(['doc:a'], 'content', null)).toBe(false);
  });

  it('lets a document go into the empty document area', () => {
    expect(canDrop(['doc:a'], 'content', [], true)).toBe(true);
    expect(canDrop(['doc:a'], 'content', [], false)).toBe(false);
  });

  it('treats a dragged group holding any document as a document', () => {
    expect(canDrop(['inspector', 'doc:a'], 'content', ['toolbox'])).toBe(false);
  });
});

describe('sideOf and findHome (spec §6.2.3)', () => {
  const dock = { left: 0, top: 0, right: 1000, bottom: 600 };

  it('names the dock edge a group is nearest to', () => {
    expect(sideOf({ left: 700, top: 0, right: 1000, bottom: 600 }, dock)).toBe('right');
    expect(sideOf({ left: 0, top: 0, right: 200, bottom: 600 }, dock)).toBe('left');
    expect(sideOf({ left: 0, top: 450, right: 700, bottom: 600 }, dock)).toBe('bottom');
    expect(sideOf({ left: 700, top: 0, right: 900, bottom: 600 }, dock)).toBe('right');
    expect(sideOf({ left: 0, top: 0, right: 700, bottom: 100 }, dock)).toBe('top');
  });

  it('remembers the neighbour sharing the longest edge, the side and the size', () => {
    const inspector = { left: 700, top: 0, right: 1000, bottom: 450 };
    const neighbours = [
      { ref: 'doc:a', rect: { left: 0, top: 0, right: 700, bottom: 450 } },
      { ref: 'problems', rect: { left: 0, top: 450, right: 1000, bottom: 600 } },
    ];
    expect(findHome(inspector, neighbours)).toEqual({ ref: 'doc:a', direction: 'right', size: 300 });
  });

  it('remembers a pane below its neighbour by height', () => {
    const problems = { left: 0, top: 450, right: 700, bottom: 600 };
    expect(findHome(problems, [{ ref: 'doc:a', rect: { left: 0, top: 0, right: 700, bottom: 450 } }]))
      .toEqual({ ref: 'doc:a', direction: 'below', size: 150 });
  });

  it('has no home when it touches nothing', () => {
    expect(findHome({ left: 0, top: 0, right: 10, bottom: 10 }, [{ ref: 'x', rect: { left: 500, top: 500, right: 600, bottom: 600 } }])).toBeNull();
  });

  it('turns a direction into a moveTo position', () => {
    expect([toPosition('left'), toPosition('right'), toPosition('above'), toPosition('below'), toPosition('within')])
      .toEqual(['left', 'right', 'top', 'bottom', 'center']);
  });
});

describe('keyCommand (spec §6.2.6)', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    keyCommand({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it('maps the studio keys and nothing else', () => {
    expect(key('e', { ctrlKey: true })).toBe('switcher');
    expect(key('E', { ctrlKey: true, shiftKey: true })).toBe('switcherBack');
    expect(key('w', { altKey: true })).toBe('closeDocument');
    expect(key('o', { ctrlKey: true })).toBe('open');
    expect(key('Escape')).toBe('escape');
    expect(key('F5')).toBe('start');
    expect(key('F5', { shiftKey: true })).toBe('stop');
    expect(key('w', { ctrlKey: true })).toBeNull();
    expect(key('Tab', { ctrlKey: true })).toBeNull();
    expect(key('e')).toBeNull();
  });
});
```

`src/dock/layoutPersistence.test.ts`:

```ts
import { Orientation, type SerializedDockview } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';
import { LAYOUT_KEY, readLayout, stripDocuments, withDocuments, writeLayout, type SavedLayout } from './layoutPersistence';
import { memoryStorage } from '../test/memoryStorage';

const panel = (id: string, contentComponent = 'tool') => ({ id, contentComponent, title: id });

/** A layout as toJSON() writes it: two documents and the Inspector in g1, the Toolbox in g2, a floating
 *  document, a floating Problems pane and a popped-out Output pane. */
function layout(): SerializedDockview {
  return {
    grid: {
      root: {
        type: 'branch',
        data: [
          { type: 'leaf', data: { id: 'g1', views: ['doc:a', 'doc:b', 'inspector'], activeView: 'doc:b' }, size: 600 },
          { type: 'leaf', data: { id: 'g2', views: ['toolbox'], activeView: 'toolbox' }, size: 300 },
        ],
        size: 600,
      },
      width: 900, height: 600, orientation: Orientation.HORIZONTAL,
    },
    panels: {
      'doc:a': panel('doc:a', 'document'), 'doc:b': panel('doc:b', 'document'), 'doc:c': panel('doc:c', 'document'),
      inspector: panel('inspector'), toolbox: panel('toolbox'), problems: panel('problems'), output: panel('output'),
    },
    floatingGroups: [
      { data: { id: 'g3', views: ['doc:c'], activeView: 'doc:c' }, position: { left: 10, top: 10, width: 300, height: 200 } },
      { data: { id: 'g4', views: ['problems'], activeView: 'problems' }, position: { left: 40, top: 40, width: 300, height: 200 } },
    ],
    popoutGroups: [{ data: { id: 'g5', views: ['output'], activeView: 'output' }, position: null }],
  };
}


const saved = (over: Partial<SavedLayout> = {}): SavedLayout => ({
  version: 1, dock: stripDocuments(layout()).dock, documentGroupId: 'g1', hidden: ['output'], sides: { inspector: 'right' },
  homes: { output: { ref: 'problems', direction: 'below', size: 180, layout: [{ ref: 'problems', left: 0, top: 450, width: 700, height: 180 }] } }, ...over,
});

describe('stripDocuments', () => {
  it('takes every document out and keeps the group they sat in as the document area', () => {
    const { dock, documentGroupId } = stripDocuments(layout());

    expect(documentGroupId).toBe('g1');
    expect(Object.keys(dock.panels).sort()).toEqual(['inspector', 'output', 'problems', 'toolbox']);
    const g1 = (dock.grid.root.data as { data: { views: string[]; activeView?: string } }[])[0]!.data;
    expect(g1).toEqual({ id: 'g1', views: ['inspector'], activeView: 'inspector' });
  });

  it('drops a floating window left empty and every pop-out window, and keeps a floating tool pane', () => {
    const { dock } = stripDocuments(layout());
    expect(dock.floatingGroups?.map((f) => f.data?.id)).toEqual(['g4']);
    expect(dock.popoutGroups).toEqual([]);
  });

  it('does not touch its input', () => {
    const input = layout();
    stripDocuments(input);
    expect(input).toEqual(layout());
  });

  it('has no document area when no grid group holds a document', () => {
    const input = layout();
    (input.grid.root.data as { data: { views: string[] } }[])[0]!.data.views = ['inspector'];
    expect(stripDocuments(input).documentGroupId).toBeNull();
  });
});

describe('withDocuments', () => {
  const docs = [panel('doc:x', 'document'), panel('doc:y', 'document')];

  it('puts the open documents back as tabs of the document area, the active one shown', () => {
    const dock = withDocuments(stripDocuments(layout()).dock, 'g1', docs, 'doc:y');
    const g1 = (dock.grid.root.data as { data: { views: string[]; activeView?: string } }[])[0]!.data;
    expect(g1.views).toEqual(['inspector', 'doc:x', 'doc:y']);
    expect(g1.activeView).toBe('doc:y');
    expect(dock.panels['doc:x']).toEqual(docs[0]);
  });

  it('uses the first group of the main grid when the document area is gone', () => {
    const dock = withDocuments(stripDocuments(layout()).dock, 'g9', docs, null);
    expect((dock.grid.root.data as { data: { views: string[] } }[])[0]!.data.views).toContain('doc:x');
  });
});

describe('readLayout and writeLayout (review focus 1: old, corrupt or unreadable layouts)', () => {
  it('round-trips a layout', () => {
    const storage = memoryStorage();
    expect(writeLayout(storage, saved())).toBe(true);
    expect(readLayout(storage)).toEqual(saved());
  });

  it.each([
    ['nothing saved', {}],
    ['text that is not JSON', { [LAYOUT_KEY]: '{"version":1,' }],
    ['JSON that is not an object', { [LAYOUT_KEY]: '[1,2]' }],
    ['an older version', { [LAYOUT_KEY]: JSON.stringify({ ...saved(), version: 0 }) }],
    ['a newer version', { [LAYOUT_KEY]: JSON.stringify({ ...saved(), version: 2 }) }],
    ['a dock part that is not a dockview layout', { [LAYOUT_KEY]: JSON.stringify({ ...saved(), dock: { grid: { root: { type: 'leaf' } }, panels: {} } }) }],
    ['a dock part missing its panels', { [LAYOUT_KEY]: JSON.stringify({ ...saved(), dock: { grid: { root: { type: 'branch', data: [] } } } }) }],
  ])('gives null for %s', (_name, initial) => {
    expect(readLayout(memoryStorage(initial))).toBeNull();
  });

  it('drops unknown tool ids, bad sides and malformed homes, and keeps the rest', () => {
    const storage = memoryStorage({
      [LAYOUT_KEY]: JSON.stringify({
        ...saved(),
        hidden: ['output', 'terminal', 7, 'output'],
        sides: { inspector: 'left', toolbox: 'middle', ghost: 'right' },
        homes: { problems: { ref: 'output', direction: 'sideways', size: 100 }, toolbox: { ref: 'inspector', direction: 'right', size: -5 }, output: { ref: 'problems', direction: 'below', size: 180, layout: [{ ref: 'problems', left: 0, top: 450, width: 700, height: 180 }] } },
        documentGroupId: 42,
      }),
    });

    const read = readLayout(storage)!;

    expect(read.hidden).toEqual(['output']);
    expect(read.sides).toEqual({ inspector: 'left' });
    expect(read.homes).toEqual({ output: { ref: 'problems', direction: 'below', size: 180, layout: [{ ref: 'problems', left: 0, top: 450, width: 700, height: 180 }] } });
    expect(read.documentGroupId).toBeNull();
  });

  it('never throws when the storage itself throws', () => {
    const hostile = { getItem: vi.fn(() => { throw new Error('SecurityError'); }), setItem: vi.fn(() => { throw new Error('QuotaExceededError'); }) } as unknown as Storage;
    expect(readLayout(hostile)).toBeNull();
    expect(writeLayout(hostile, saved())).toBe(false);
    expect(readLayout(null)).toBeNull();
    expect(writeLayout(null, saved())).toBe(false);
  });
});
```

`src/dock/windowActions.test.ts`:

```ts
import { createDockview, type DockviewApi, type IContentRenderer } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDocument, applyLayout, autoHide, captureLayout, dockAsDocument, dockBack, ensureDocumentArea, floatPanel,
  newMemory, pinBack, resetLayout, showTool, type DockMemory,
} from './windowActions';

// dockview's core runs in jsdom (no sizes, so recordHome finds no home: tests set homes directly).
class Part implements IContentRenderer {
  readonly element = document.createElement('div');
  init() {}
}
const NO_RECT = { left: 0, top: 0, right: 0, bottom: 0 };

let hosts: HTMLElement[] = [];
afterEach(() => { hosts.forEach((h) => h.remove()); hosts = []; });

function dock(): { api: DockviewApi; memory: DockMemory } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const api = createDockview(host, { createComponent: () => new Part() });
  api.layout(1200, 700);
  return { api, memory: newMemory() };
}

const where = (api: DockviewApi, id: string) => {
  const panel = api.getPanel(id);
  return panel ? { group: panel.group.id, location: panel.group.api.location.type } : null;
};

describe('window actions on a real dockview', () => {
  it('keeps one document area: an empty group at first, then the documents as its tabs', () => {
    const { api, memory } = dock();
    const area = ensureDocumentArea(api, memory);
    expect(area.panels).toHaveLength(0);
    expect(ensureDocumentArea(api, memory)).toBe(area);

    addDocument(api, memory, 'a', 'orders');
    addDocument(api, memory, 'b', 'billing');

    expect(where(api, 'doc:a')).toEqual({ group: area.id, location: 'grid' });
    expect(where(api, 'doc:b')?.group).toBe(area.id);
    expect(api.getPanel('doc:a')!.api.renderer).toBe('always');
  });

  it('shows the tool panes at their default places, Problems and Output tabbed together', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    for (const id of ['inspector', 'toolbox', 'problems', 'output'] as const) showTool(api, memory, id);

    expect(api.panels.map((p) => p.id).sort()).toEqual(['doc:a', 'inspector', 'output', 'problems', 'toolbox']);
    expect(where(api, 'output')!.group).toBe(where(api, 'problems')!.group);
    expect(where(api, 'inspector')!.group).not.toBe(where(api, 'doc:a')!.group);
    expect(showTool(api, memory, 'inspector')).toBe(api.getPanel('inspector'));
  });

  it('docks a floated pane back to the exact neighbour and side it remembered', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    showTool(api, memory, 'inspector');
    showTool(api, memory, 'problems');
    floatPanel(api, memory, api.getPanel('problems')!, NO_RECT);
    expect(where(api, 'problems')!.location).toBe('floating');
    memory.homes.problems = { ref: 'inspector', direction: 'below', size: 150, layout: [] };

    dockBack(api, memory, api.getPanel('problems')!.group);

    const branch = JSON.stringify(api.toJSON().grid.root);
    expect(where(api, 'problems')!.location).toBe('grid');
    expect(branch.indexOf('"inspector"')).toBeLessThan(branch.indexOf('"problems"'));
    expect(where(api, 'problems')!.group).not.toBe(where(api, 'inspector')!.group);
  });

  it('docks a tab floated out of a tab group back into that group', () => {
    // jsdom lays nothing out; give every group a box so the home is recorded
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0, width: 100, height: 100 } as DOMRect);
    try {
      const { api, memory } = dock();
      resetLayout(api, memory, 1200);
      floatPanel(api, memory, api.getPanel('output')!, { left: 0, top: 0, right: 1200, bottom: 700 });
      expect(where(api, 'output')!.location).toBe('floating');
      expect(memory.homes.output).toMatchObject({ ref: 'problems', direction: 'within' });

      dockBack(api, memory, api.getPanel('output')!.group);

      expect(where(api, 'output')).toEqual(where(api, 'problems'));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('without a home, docks a document into the document area and a tool pane back to its side', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    addDocument(api, memory, 'b', 'billing');
    showTool(api, memory, 'toolbox');
    floatPanel(api, memory, api.getPanel('doc:b')!, NO_RECT);
    floatPanel(api, memory, api.getPanel('toolbox')!, NO_RECT);

    dockBack(api, memory, api.getPanel('doc:b')!.group);
    dockBack(api, memory, api.getPanel('toolbox')!.group);

    expect(where(api, 'doc:b')).toEqual(where(api, 'doc:a'));
    expect(where(api, 'toolbox')!.location).toBe('grid');
  });

  it('auto-hides a docked tool group in place and pins it back where it was', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    const problems = api.getPanel('problems')!;

    expect(autoHide(api, memory, problems, NO_RECT)).toEqual(['problems', 'output']);
    expect(problems.group.api.isVisible).toBe(false);
    expect(api.getPanel('output')!.group).toBe(problems.group);

    expect(pinBack(api, memory, 'output')).toEqual(['problems', 'output']);
    expect(problems.group.api.isVisible).toBe(true);
  });

  it('auto-hides a pane that shares the document area by taking it out, and shows it again', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    showTool(api, memory, 'inspector');
    dockAsDocument(api, memory, api.getPanel('inspector')!, NO_RECT);

    expect(autoHide(api, memory, api.getPanel('inspector')!, NO_RECT)).toEqual(['inspector']);
    expect(api.getPanel('inspector')).toBeUndefined();
    expect(api.getPanel('doc:a')).toBeDefined();
    expect(autoHide(api, memory, api.getPanel('doc:a')!, NO_RECT)).toEqual([]);

    expect(pinBack(api, memory, 'inspector')).toEqual(['inspector']);
    expect(where(api, 'inspector')!.location).toBe('grid');
  });

  it('docks a tool pane as a tab of the document area', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    showTool(api, memory, 'output');
    dockAsDocument(api, memory, api.getPanel('output')!, NO_RECT);
    expect(where(api, 'output')).toEqual(where(api, 'doc:a'));
  });

  it('resets the layout without re-creating the open documents', () => {
    const { api, memory } = dock();
    addDocument(api, memory, 'a', 'orders');
    const docA = api.getPanel('doc:a');
    showTool(api, memory, 'inspector');
    floatPanel(api, memory, docA!, NO_RECT);
    memory.homes.inspector = { ref: 'gone', direction: 'left', size: 10, layout: [] };

    resetLayout(api, memory, 1200);

    expect(api.getPanel('doc:a')).toBe(docA);
    expect(where(api, 'doc:a')!.location).toBe('grid');
    expect(api.panels.map((p) => p.id).sort()).toEqual(['doc:a', 'inspector', 'output', 'problems', 'toolbox']);
    expect(memory.homes).toEqual({});
  });

  it('saves a layout without documents and applies it back around the open documents', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'a', 'orders');
    floatPanel(api, memory, api.getPanel('toolbox')!, NO_RECT);
    const hidden = autoHide(api, memory, api.getPanel('output')!, NO_RECT);
    const saved = captureLayout(api, memory, hidden);
    expect(JSON.stringify(saved.dock)).not.toContain('doc:a');
    expect(saved.hidden).toEqual(['problems', 'output']);

    resetLayout(api, memory, 1200);
    addDocument(api, memory, 'b', 'billing');
    const docA = api.getPanel('doc:a'), docB = api.getPanel('doc:b');

    expect(applyLayout(api, memory, saved)).toEqual(['problems', 'output']);

    expect(where(api, 'toolbox')!.location).toBe('floating');
    expect(api.getPanel('output')!.group.api.isVisible).toBe(false);
    expect(api.getPanel('doc:a')).toBe(docA);
    expect(api.getPanel('doc:b')).toBe(docB);
    expect(where(api, 'doc:a')!.group).toBe(saved.documentGroupId);
  });

  it('throws, and leaves the documents to be re-added, when dockview rejects a layout', () => {
    const { api, memory } = dock();
    resetLayout(api, memory, 1200);
    const saved = captureLayout(api, memory, []);
    saved.dock = { ...saved.dock, grid: { ...saved.dock.grid, root: { type: 'branch', data: [{ type: 'leaf', data: { views: [] } }] } } } as never;
    expect(() => applyLayout(api, memory, saved)).toThrow();
  });
});
```

`src/dock/overlayTokens.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from src/WorkflowStudio (npm test, npx vitest).
const src = path.resolve(process.cwd(), 'src');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return name.endsWith('.css') ? [full] : [];
  });
}

describe('overlay layers (spec §6.3)', () => {
  it('are defined once, as tokens above dockview floating groups (999)', () => {
    const tokens = readFileSync(path.join(src, 'canvas', 'tokens.css'), 'utf8');
    for (const [name, value] of [['fly', 1000], ['menu', 1010], ['toast', 1020], ['modal', 1030], ['switcher', 1040], ['tip', 1050]] as const) {
      expect(tokens).toMatch(new RegExp(`--z-${name}:\\s*${value};`));
    }
  });

  it('are the only way any stylesheet reaches dockview floating groups', () => {
    const offenders: string[] = [];
    for (const file of cssFiles(src)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/z-index:\s*([^;]+);/g)) {
        const value = match[1]!.trim();
        if (value.startsWith('var(--z-')) continue;
        if (Number(value) >= 999 || Number.isNaN(Number(value))) offenders.push(`${path.relative(src, file)}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/dock`
Expected: FAIL: `./dropRules`, `./home`, `./ids`, `./keys`, `./layoutPersistence` and `./windowActions` cannot be resolved. (`overlayTokens.test.ts` already passes: the tokens exist since plan 2.)

- [ ] **Step 3: Implement the pure rules**

`src/dock/ids.ts`:

```ts
/** The four shared tool panes (spec §6.1). Their ids are their dockview panel ids. */
export type ToolId = 'inspector' | 'toolbox' | 'problems' | 'output';

export const TOOL_IDS: readonly ToolId[] = ['inspector', 'toolbox', 'problems', 'output'];

export const TOOL_TITLES: Readonly<Record<ToolId, string>> = {
  inspector: 'Inspector', toolbox: 'Toolbox', problems: 'Problems', output: 'Output',
};

export const isToolId = (id: string): id is ToolId => (TOOL_IDS as readonly string[]).includes(id);

const DOC_PREFIX = 'doc:';

/** A document's dockview panel id. Documents and tool panes never share an id. */
export const docPanelId = (documentId: string): string => `${DOC_PREFIX}${documentId}`;
export const isDocPanelId = (panelId: string): boolean => panelId.startsWith(DOC_PREFIX);
/** The document id inside a document panel id, or null for any other panel. */
export const documentIdOf = (panelId: string): string | null =>
  isDocPanelId(panelId) ? panelId.slice(DOC_PREFIX.length) : null;
```

`src/dock/dropRules.ts`:

```ts
import { isDocPanelId } from './ids';

/** Where dockview is about to show a drop overlay (its `DockviewGroupDropLocation`). */
export type DropKind = 'tab' | 'header_space' | 'content' | 'edge';

/**
 * Documents can only be dropped into or beside the document area (spec §6.2.4): onto a group that
 * already holds a document, never onto a tool pane's group and never onto the outer edge of the
 * whole layout. Tool panes may go anywhere, in among the documents included.
 *
 * `dragged` are the panel ids being dragged (one tab, or every panel of a dragged group);
 * `target` are the panel ids of the group under the pointer, or null when there is none;
 * `targetIsDocumentArea` is true for the document area while it is empty.
 */
export function canDrop(dragged: readonly string[], kind: DropKind, target: readonly string[] | null, targetIsDocumentArea = false): boolean {
  if (!dragged.some(isDocPanelId)) return true;
  if (kind === 'edge' || target === null) return false;
  return targetIsDocumentArea || target.some(isDocPanelId);
}
```

`src/dock/home.ts`:

```ts
/** An edge of the layout. A tool pane remembers the one it sat nearest. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/** dockview's placement words: beside a reference, or `within` it (as a tab of its group). */
export type Direction = 'left' | 'right' | 'above' | 'below' | 'within';

/** dockview's drop positions, for `moveTo`. */
export type Position = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface Rect { left: number; top: number; right: number; bottom: number }

/** One docked group's box, named by a panel in it. */
export interface GroupBox { ref: string; left: number; top: number; width: number; height: number }

/**
 * Where a group sat before it left the layout (spec §6.2.3): a panel of the neighbour it touched,
 * which side of that neighbour it was on, its width (left/right) or height (above/below), and the
 * box of every docked group at that moment, so the whole layout can be put back as it was.
 */
export interface Home { ref: string; direction: Direction; size: number; layout: GroupBox[] }

export const SIDE_DIRECTION: Readonly<Record<Side, Direction>> = { left: 'left', right: 'right', top: 'above', bottom: 'below' };

export function toPosition(direction: Direction): Position {
  switch (direction) {
    case 'above': return 'top';
    case 'below': return 'bottom';
    case 'within': return 'center';
    default: return direction;
  }
}

/**
 * The edge of the dock a group belongs to: a tall pane to the nearer of left and right, a wide one
 * to the nearer of top and bottom (a tie goes right, or bottom). Its rail is that edge's.
 */
export function sideOf(group: Rect, dock: Rect): Side {
  const tall = group.bottom - group.top > group.right - group.left;
  if (tall) return group.left - dock.left < dock.right - group.right ? 'left' : 'right';
  return group.top - dock.top < dock.bottom - group.bottom ? 'top' : 'bottom';
}

const TOUCH = 6; // px: closer than this, two groups share an edge
const SHARED = 20; // px: and they must overlap along it by more than this

/**
 * The neighbour the group shares the longest edge with, and on which side of it the group sits
 * (mockup v49 recordHome). Null when it touches no other group.
 */
export function findHome(group: Rect, neighbours: readonly { ref: string; rect: Rect }[]): Omit<Home, 'layout'> | null {
  const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.min(a2, b2) - Math.max(a1, b1);
  let best: (Omit<Home, 'layout'> & { shared: number }) | null = null;
  for (const { ref, rect: q } of neighbours) {
    const vertical = overlap(group.top, group.bottom, q.top, q.bottom);
    const horizontal = overlap(group.left, group.right, q.left, q.right);
    const candidates: [Direction, number, number][] = [
      ['right', Math.abs(group.left - q.right), vertical],
      ['left', Math.abs(group.right - q.left), vertical],
      ['below', Math.abs(group.top - q.bottom), horizontal],
      ['above', Math.abs(group.bottom - q.top), horizontal],
    ];
    for (const [direction, gap, shared] of candidates) {
      if (gap < TOUCH && shared > SHARED && (best === null || shared > best.shared)) {
        const size = direction === 'left' || direction === 'right' ? group.right - group.left : group.bottom - group.top;
        best = { ref, direction, size: Math.round(size), shared };
      }
    }
  }
  return best === null ? null : { ref: best.ref, direction: best.direction, size: best.size };
}
```

`src/dock/keys.ts`:

```ts
/** The studio's own keys (spec §6.1, §6.2.6). The browser keeps Ctrl+Tab and Ctrl+W, so these avoid them. */
export type KeyCommand = 'switcher' | 'switcherBack' | 'closeDocument' | 'open' | 'escape' | 'start' | 'stop';

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

export function keyCommand(e: KeyLike): KeyCommand | null {
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && key === 'e') return e.shiftKey ? 'switcherBack' : 'switcher';
  if (e.altKey && !mod && key === 'w') return 'closeDocument';
  if (mod && !e.altKey && !e.shiftKey && key === 'o') return 'open';
  if (e.key === 'Escape') return 'escape';
  if (e.key === 'F5') return e.shiftKey ? 'stop' : 'start';
  return null;
}
```

- [ ] **Step 4: Implement layout persistence**

`src/dock/layoutPersistence.ts`:

```ts
import type { GroupviewPanelState, SerializedDockview, SerializedFloatingGroup, SerializedGridObject } from 'dockview-react';
import { isDocPanelId, isToolId, type ToolId } from './ids';
import type { Direction, Home, Side } from './home';

/** localStorage key of the saved window layout (spec §6.2.2: per browser, never in the database). */
export const LAYOUT_KEY = 'skp.studio.layout';
/** Bumped whenever the saved shape changes; an older or unknown version is ignored, never migrated. */
export const LAYOUT_VERSION = 1;

type GroupState = NonNullable<SerializedFloatingGroup['data']>;

/** What Window › Save window layout stores. It never holds a document: they are not restored. */
export interface SavedLayout {
  version: typeof LAYOUT_VERSION;
  /** `DockviewApi.toJSON()` with every document panel taken out and no pop-out windows. */
  dock: SerializedDockview;
  /** The main-grid group the documents sat in, kept (possibly empty) so they go back there. */
  documentGroupId: string | null;
  /** Tool panes on an auto-hide rail. */
  hidden: ToolId[];
  sides: Partial<Record<ToolId, Side>>;
  homes: Partial<Record<ToolId, Home>>;
}

/** `window.localStorage`, or null where reading it throws (blocked storage, sandboxed frames). */
export function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Writes the layout. False when the browser refuses (quota, blocked storage): never throws. */
export function writeLayout(storage: Storage | null, layout: SavedLayout): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    return true;
  } catch {
    return false;
  }
}

/**
 * The saved layout, or null when there is none, it cannot be read, it is not JSON, it is from
 * another version or its dock part is not a dockview layout. Unknown tool ids, sides and malformed
 * homes are dropped rather than failing the whole layout.
 */
export function readLayout(storage: Storage | null): SavedLayout | null {
  let text: string | null;
  try {
    text = storage?.getItem(LAYOUT_KEY) ?? null;
  } catch {
    return null;
  }
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== LAYOUT_VERSION || !isDockLayout(value.dock)) return null;

  const hidden = Array.isArray(value.hidden) ? value.hidden.filter((id): id is ToolId => typeof id === 'string' && isToolId(id)) : [];
  const sides: Partial<Record<ToolId, Side>> = {};
  const homes: Partial<Record<ToolId, Home>> = {};
  if (isRecord(value.sides)) {
    for (const [id, side] of Object.entries(value.sides)) if (isToolId(id) && isSide(side)) sides[id] = side;
  }
  if (isRecord(value.homes)) {
    for (const [id, home] of Object.entries(value.homes)) if (isToolId(id) && isHome(home)) homes[id] = home;
  }
  return {
    version: LAYOUT_VERSION,
    dock: value.dock,
    documentGroupId: typeof value.documentGroupId === 'string' ? value.documentGroupId : null,
    hidden: [...new Set(hidden)],
    sides,
    homes,
  };
}

/**
 * A copy of `toJSON()` without documents: their panels and tab entries go, a floating window left
 * empty goes, and pop-out windows go (Apply never opens a browser window). The main-grid group that
 * held documents stays, empty, and its id is returned as the document area.
 */
export function stripDocuments(layout: SerializedDockview): { dock: SerializedDockview; documentGroupId: string | null } {
  const dock = JSON.parse(JSON.stringify(layout)) as SerializedDockview;
  let documentGroupId: string | null = null;
  forEachGroup(dock.grid.root, (g) => {
    if (documentGroupId === null && g.views.some(isDocPanelId)) documentGroupId = g.id;
  });

  const clean = (g: GroupState) => {
    g.views = g.views.filter((v) => !isDocPanelId(v));
    if (g.activeView !== undefined && !g.views.includes(g.activeView)) {
      if (g.views.length > 0) g.activeView = g.views[0];
      else delete g.activeView;
    }
  };
  forEachGroup(dock.grid.root, clean);
  for (const id of Object.keys(dock.panels)) if (isDocPanelId(id)) delete dock.panels[id];

  dock.floatingGroups = (dock.floatingGroups ?? []).filter((f) => {
    let views = 0;
    const visit = (g: GroupState) => { clean(g); views += g.views.length; };
    if (f.data) visit(f.data);
    if (f.grid) forEachGroup(f.grid.root, visit);
    return views > 0;
  });
  dock.popoutGroups = [];
  return { dock, documentGroupId };
}

/**
 * A copy of a stripped layout with the given document panels put back as tabs of the document
 * area (the saved group, or the first group of the main grid when that group is gone). Applied
 * with `reuseExistingPanels`, dockview then moves the open documents there instead of re-creating
 * them, so their canvases keep their viewport.
 */
export function withDocuments(
  stripped: SerializedDockview, documentGroupId: string | null, documents: readonly GroupviewPanelState[], activeId: string | null,
): SerializedDockview {
  const dock = JSON.parse(JSON.stringify(stripped)) as SerializedDockview;
  if (documents.length === 0) return dock;
  let target: GroupState | null = null;
  forEachGroup(dock.grid.root, (g) => { if (g.id === documentGroupId) target = g; });
  if (target === null) forEachGroup(dock.grid.root, (g) => { target ??= g; });
  const area = target as GroupState | null;
  if (area === null) return dock;
  for (const panel of documents) {
    dock.panels[panel.id] = panel;
    if (!area.views.includes(panel.id)) area.views.push(panel.id);
  }
  if (activeId !== null && area.views.includes(activeId)) area.activeView = activeId;
  return dock;
}

/** Every group (grid leaf) in a serialized grid, depth first. */
function forEachGroup(node: SerializedGridObject<GroupState>, visit: (group: GroupState) => void): void {
  if (node.type === 'leaf') visit(node.data as GroupState);
  else for (const child of node.data as SerializedGridObject<GroupState>[]) forEachGroup(child, visit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDockLayout(value: unknown): value is SerializedDockview {
  if (!isRecord(value) || !isRecord(value.grid) || !isRecord(value.panels)) return false;
  const root = value.grid.root;
  return isRecord(root) && root.type === 'branch' && Array.isArray(root.data);
}

function isSide(value: unknown): value is Side {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom';
}

const DIRECTIONS: readonly Direction[] = ['left', 'right', 'above', 'below', 'within'];

function isHome(value: unknown): value is Home {
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  const isBox = (b: unknown) => isRecord(b) && typeof b.ref === 'string' && finite(b.left) && finite(b.top) && finite(b.width) && finite(b.height);
  return isRecord(value) && typeof value.ref === 'string' && DIRECTIONS.includes(value.direction as Direction)
    && finite(value.size) && (value.size as number) > 0 && Array.isArray(value.layout) && value.layout.every(isBox);
}
```

- [ ] **Step 5: Implement the window actions**

`src/dock/windowActions.ts`:

```ts
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-react';
import { findHome, SIDE_DIRECTION, sideOf, toPosition, type GroupBox, type Home, type Rect, type Side } from './home';
import { docPanelId, isDocPanelId, isToolId, TOOL_IDS, TOOL_TITLES, type ToolId } from './ids';
import { stripDocuments, withDocuments, type SavedLayout } from './layoutPersistence';

/**
 * What the dock remembers beyond dockview's own state (mockup v49 SIDE and HOME): the edge each tool
 * pane belongs to, where each group sat before it left the layout, and which group is the document
 * area. Mutated in place by the actions below; the shell keeps one per dock.
 */
export interface DockMemory {
  sides: Partial<Record<ToolId, Side>>;
  homes: Partial<Record<string, Home>>;
  documentGroupId: string | null;
}

export const newMemory = (): DockMemory => ({ sides: {}, homes: {}, documentGroupId: null });

export const DEFAULT_SIDES: Readonly<Record<ToolId, Side>> = { inspector: 'right', toolbox: 'right', problems: 'bottom', output: 'bottom' };
/** The default sizes (mockup v49 TOOLS): Inspector 340 wide, Toolbox 290 wide, Problems and Output 150 high. */
const TOOL_SIZE: Readonly<Record<ToolId, number>> = { inspector: 340, toolbox: 290, problems: 150, output: 150 };
/** Problems and Output share a group when they share a side. */
const MATE: Readonly<Partial<Record<ToolId, ToolId>>> = { problems: 'output', output: 'problems' };

export const toolSide = (memory: DockMemory, id: ToolId): Side => memory.sides[id] ?? DEFAULT_SIDES[id];

const toolPanel = (id: ToolId) => ({ id, component: 'tool', title: TOOL_TITLES[id] });
const inGrid = (group: DockviewGroupPanel | undefined): group is DockviewGroupPanel => group?.api.location.type === 'grid';
const hasDocument = (group: DockviewGroupPanel) => group.panels.some((p) => isDocPanelId(p.id));
const rectOf = (el: Element): Rect => el.getBoundingClientRect();

/** The main-grid group documents go into: one that holds a document, else the remembered empty area. */
export function documentArea(api: DockviewApi, memory: DockMemory, except?: DockviewGroupPanel): DockviewGroupPanel | null {
  const withDoc = api.groups.find((g) => g !== except && inGrid(g) && hasDocument(g));
  if (withDoc) return withDoc;
  const remembered = memory.documentGroupId === null ? undefined : api.groups.find((g) => g.id === memory.documentGroupId);
  return remembered && remembered !== except && inGrid(remembered) ? remembered : null;
}

/** The document area, created as an empty group left of the Inspector (or of everything) when there is none. */
export function ensureDocumentArea(api: DockviewApi, memory: DockMemory): DockviewGroupPanel {
  const area = documentArea(api, memory);
  if (area) return area;
  const inspector = api.getPanel('inspector');
  const group = inGrid(inspector?.group)
    ? api.addGroup({ referencePanel: 'inspector', direction: 'left' })
    : api.groups.length === 0 ? api.addGroup() : api.addGroup({ direction: 'left' });
  memory.documentGroupId = group.id;
  return group;
}

/** Opens a document as a tab of the document area. `renderer: 'always'` keeps its canvas mounted (spec §6.3). */
export function addDocument(api: DockviewApi, memory: DockMemory, documentId: string, title: string): IDockviewPanel {
  const area = ensureDocumentArea(api, memory);
  const panel = api.addPanel({
    id: docPanelId(documentId), component: 'document', tabComponent: 'studio', title, renderer: 'always',
    position: { referenceGroup: area },
  });
  memory.documentGroupId = panel.group.id;
  return panel;
}

/** The box of every docked group, named by its first panel. */
function dockedBoxes(api: DockviewApi): GroupBox[] {
  return api.groups.filter((g) => inGrid(g) && g.panels.length > 0).map((g) => {
    const r = rectOf(g.element);
    return { ref: g.panels[0]!.id, left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.right - r.left), height: Math.round(r.bottom - r.top) };
  });
}

/**
 * Remembers where panels sat before they leave the layout (spec §6.2.3): a tab taken out of a
 * group goes back into that group; a whole group goes back beside the neighbour it shared the
 * longest edge with. Either way the boxes of all docked groups are kept, to put sizes back.
 */
export function recordHome(api: DockviewApi, memory: DockMemory, group: DockviewGroupPanel, dock: Rect, leaving: readonly IDockviewPanel[] = group.panels): void {
  if (!inGrid(group)) return;
  const rect = rectOf(group.element);
  if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return;
  const side = sideOf(rect, dock);
  const layout = dockedBoxes(api);
  const staying = group.panels.find((p) => !leaving.includes(p));
  const beside = staying ? null : findHome(rect, layout.filter((b) => !group.panels.some((p) => p.id === b.ref))
    .map((b) => ({ ref: b.ref, rect: { left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height } })));
  const home: Home | null = staying
    ? { ref: staying.id, direction: 'within', size: 0, layout }
    : beside ? { ...beside, layout } : null;
  for (const panel of leaving) {
    if (isToolId(panel.id)) memory.sides[panel.id] = side;
    if (home) memory.homes[panel.id] = home;
    else delete memory.homes[panel.id];
  }
}

/**
 * Puts every docked group back to the box it had when the home was recorded, left to right and
 * top to bottom, twice: dockview gives each resize's difference to the other groups, so a second
 * pass settles what the first disturbed. Groups that no longer exist are skipped.
 */
function restoreLayout(api: DockviewApi, layout: readonly GroupBox[]): void {
  const ordered = [...layout].sort((a, b) => a.left - b.left || a.top - b.top);
  for (let pass = 0; pass < 2; pass++) {
    for (const box of ordered) {
      const group = api.getPanel(box.ref)?.group;
      if (inGrid(group)) group.api.setSize({ width: box.width, height: box.height });
    }
  }
}

/** Shows a tool pane: focused if open, else back at its home, else on its side (next to its mate). */
export function showTool(api: DockviewApi, memory: DockMemory, id: ToolId): IDockviewPanel {
  const existing = api.getPanel(id);
  if (existing) { existing.api.setActive(); return existing; }
  const base = toolPanel(id);
  const home = memory.homes[id];
  const ref = home ? api.getPanel(home.ref) : undefined;
  if (home && ref && inGrid(ref.group)) {
    const panel = home.direction === 'within'
      ? api.addPanel({ ...base, position: { referencePanel: home.ref } })
      : api.addPanel({ ...base, position: { referencePanel: home.ref, direction: home.direction }, initialWidth: home.size, initialHeight: home.size });
    restoreLayout(api, home.layout);
    return panel;
  }
  const side = toolSide(memory, id);
  const mate = MATE[id];
  const matePanel = mate ? api.getPanel(mate) : undefined;
  if (mate && matePanel && inGrid(matePanel.group) && toolSide(memory, mate) === side) {
    return api.addPanel({ ...base, position: { referencePanel: mate } });
  }
  return api.addPanel({ ...base, position: { direction: SIDE_DIRECTION[side] }, initialWidth: TOOL_SIZE[id], initialHeight: TOOL_SIZE[id] });
}

/** Floats a panel (the whole group when it is alone in it), remembering where it was. */
export function floatPanel(api: DockviewApi, memory: DockMemory, panel: IDockviewPanel, dock: Rect): void {
  const alone = panel.group.panels.length === 1;
  recordHome(api, memory, panel.group, dock, [panel]);
  api.addFloatingGroup(alone ? panel.group : panel);
}

/** Floats a whole group (the header's ⧉), remembering where it was. */
export function floatGroup(api: DockviewApi, memory: DockMemory, group: DockviewGroupPanel, dock: Rect): void {
  recordHome(api, memory, group, dock);
  api.addFloatingGroup(group);
}

/** Pops a group out into its own browser window, remembering where it was. */
export function popOut(api: DockviewApi, memory: DockMemory, group: DockviewGroupPanel, dock: Rect): void {
  recordHome(api, memory, group, dock);
  void api.addPopoutGroup(group);
}

/**
 * Dock: a floating or popped-out group returns to the exact spot it left (spec §6.2.3); without a
 * home, a document goes into the document area and a tool pane back to its side.
 */
export function dockBack(api: DockviewApi, memory: DockMemory, group: DockviewGroupPanel): void {
  const panels = [...group.panels];
  const first = panels[0];
  if (!first) return;
  const home = memory.homes[first.id];
  const ref = home ? api.getPanel(home.ref) : undefined;
  if (home && ref && ref.group !== group && inGrid(ref.group)) {
    if (home.direction === 'within') {
      for (const p of panels) p.api.moveTo({ group: ref.group, position: 'center' });
      restoreLayout(api, home.layout);
      first.api.setActive();
      return;
    }
    first.api.moveTo({ group: ref.group, position: toPosition(home.direction) });
    const landed = first.group;
    for (const p of panels.slice(1)) p.api.moveTo({ group: landed, position: 'center' });
    restoreLayout(api, home.layout);
    first.api.setActive();
    return;
  }
  if (!isDocPanelId(first.id)) {
    for (const p of panels) api.removePanel(p);
    for (const p of panels) if (isToolId(p.id)) showTool(api, memory, p.id);
    return;
  }
  const area = documentArea(api, memory, group) ?? ensureDocumentArea(api, memory);
  for (const p of panels) p.api.moveTo({ group: area, position: 'center' });
  first.api.setActive();
}

/**
 * Auto hide (spec §6.2.5). A docked group of tool panes is hidden in place (dockview keeps its
 * slot and size, so pinning it back is exact); a floating, popped-out or document-sharing pane
 * leaves the layout instead, remembering where it was. Returns the panes that go to a rail.
 */
export function autoHide(api: DockviewApi, memory: DockMemory, panel: IDockviewPanel, dock: Rect): ToolId[] {
  if (!isToolId(panel.id)) return [];
  const group = panel.group;
  if (inGrid(group) && !hasDocument(group)) {
    for (const p of group.panels) if (isToolId(p.id)) memory.sides[p.id] = sideOf(rectOf(group.element), dock);
    group.api.setVisible(false);
    return group.panels.map((p) => p.id).filter(isToolId);
  }
  recordHome(api, memory, group, dock, [panel]);
  api.removePanel(panel);
  return [panel.id];
}

/** Pin back from a rail: a hidden group shows again where it was; a removed pane goes home. Returns the panes that leave the rail. */
export function pinBack(api: DockviewApi, memory: DockMemory, id: ToolId): ToolId[] {
  const panel = api.getPanel(id);
  if (panel && !panel.group.api.isVisible) {
    panel.group.api.setVisible(true);
    panel.api.setActive();
    return panel.group.panels.map((p) => p.id).filter(isToolId);
  }
  showTool(api, memory, id);
  return [id];
}

/** "Dock as tabbed document": a tool pane becomes a tab of the document area. */
export function dockAsDocument(api: DockviewApi, memory: DockMemory, panel: IDockviewPanel, dock: Rect): void {
  const area = documentArea(api, memory, panel.group);
  if (!area) return;
  recordHome(api, memory, panel.group, dock, [panel]);
  panel.api.moveTo({ group: area, position: 'center' });
  panel.api.setActive();
}

/**
 * Reset window layout (mockup v49 resetLayout): every document into one document area, every
 * tool pane at its default place and size, nothing remembered. Open documents are moved, never
 * re-created, so their canvases keep their viewport.
 */
export function resetLayout(api: DockviewApi, memory: DockMemory, dockWidth: number): void {
  memory.sides = {};
  memory.homes = {};
  for (const id of TOOL_IDS) { const p = api.getPanel(id); if (p) api.removePanel(p); }
  const area = ensureDocumentArea(api, memory);
  for (const p of api.panels.filter((x) => isDocPanelId(x.id))) {
    if (p.group !== area) p.api.moveTo({ group: area, position: 'center' });
  }
  memory.documentGroupId = area.id;
  api.addPanel({ ...toolPanel('inspector'), position: { referenceGroup: area, direction: 'right' }, initialWidth: TOOL_SIZE.inspector });
  api.addPanel({ ...toolPanel('toolbox'), position: { referencePanel: 'inspector', direction: 'right' }, initialWidth: TOOL_SIZE.toolbox });
  api.addPanel({ ...toolPanel('problems'), position: { referenceGroup: area, direction: 'below' }, initialHeight: TOOL_SIZE.problems });
  api.addPanel({ ...toolPanel('output'), position: { referencePanel: 'problems' }, inactive: true });
  area.api.setSize({ width: Math.max(480, dockWidth - TOOL_SIZE.inspector - TOOL_SIZE.toolbox) });
  api.getPanel('inspector')?.group.api.setSize({ width: TOOL_SIZE.inspector });
  area.activePanel?.api.setActive();
}

/** Window › Save window layout: dockview's layout without documents, plus what the dock remembers. */
export function captureLayout(api: DockviewApi, memory: DockMemory, hidden: readonly ToolId[]): SavedLayout {
  const { dock, documentGroupId } = stripDocuments(api.toJSON());
  const homes: SavedLayout['homes'] = {};
  for (const id of TOOL_IDS) { const h = memory.homes[id]; if (h) homes[id] = h; }
  const remembered = memory.documentGroupId !== null && api.groups.some((g) => g.id === memory.documentGroupId) ? memory.documentGroupId : null;
  return { version: 1, dock, documentGroupId: documentGroupId ?? remembered, hidden: [...hidden], sides: { ...memory.sides }, homes };
}

/**
 * Window › Apply saved layout. The open documents are put into the saved document area and
 * dockview moves them there (`reuseExistingPanels`), so their canvases are not re-created.
 * Returns the panes that go back on a rail. Throws when dockview rejects the layout.
 */
export function applyLayout(api: DockviewApi, memory: DockMemory, saved: SavedLayout): ToolId[] {
  const current = api.toJSON();
  const documents = Object.values(current.panels).filter((p) => isDocPanelId(p.id));
  const active = api.activePanel && isDocPanelId(api.activePanel.id) ? api.activePanel.id : documents[0]?.id ?? null;
  api.fromJSON(withDocuments(saved.dock, saved.documentGroupId, documents, active), { reuseExistingPanels: true });
  memory.sides = { ...saved.sides };
  memory.homes = { ...saved.homes };
  memory.documentGroupId = saved.documentGroupId;
  return saved.hidden.filter((id) => { const p = api.getPanel(id); return !p || !p.group.api.isVisible; });
}
```

- [ ] **Step 6: Run the tests and the typecheck** (PowerShell)

```powershell
npx vitest run src/dock
npm run typecheck
```

Expected: 4 test files, 40 tests passed; typecheck prints nothing.

- [ ] **Step 7: Commit** (from the repository root)

```bash
git add src/WorkflowStudio/src/dock src/WorkflowStudio/src/test/memoryStorage.ts
git commit -m "feat(studio): dock rules, window layout persistence and window actions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Overlays and auto-hide rails

**Files:**
- Create: `src/dock/dock.css`, `src/dock/Menu.tsx`, `src/dock/Picker.tsx`, `src/dock/Tooltip.tsx`, `src/dock/Switcher.tsx`, `src/dock/AutoHide.tsx`, `src/dock/windowKey.ts`
- Test: `src/dock/overlays.test.tsx`

**Interfaces:**
- Consumes: `ToolId`, `TOOL_TITLES` (Task 5), `Side` (Task 5).
- Produces:
  - `Menu.tsx`: `interface Anchor { x; y; doc: Document }`; `anchorBelow(el)`; `anchorAt(event)`; `interface MenuItem { id; label; icon?; kbd?; disabled?; tip?; onSelect }`; `type MenuEntry = MenuItem | 'separator'`; `Menu({ entries, anchor, onClose, label })`.
  - `Picker.tsx`: `interface PickerItem { id; label; open }`; `filterItems(items, query)`; `Picker({ items, anchor, onPick, onClose, note? })`.
  - `Tooltip.tsx`: `tipFor(target)`; `Tooltips({ windows })`.
  - `Switcher.tsx`: `touch(mru, id)`; `switcherOrder(mru, present)`; `interface SwitcherEntry`; `Switcher({ entries, selected, onPick })`.
  - `AutoHide.tsx`: `type Rail = 'l' | 'r' | 'b'`; `railOf(side)`; `AutoHide({ hidden, sideOf, flyId, fresh, onOpen, onClose, onPin, renderTool })`.
  - `windowKey(win)`: a stable React key per browser window.
  - `dock.css`: the chrome's styles. Every value is the mockup's (`.menubar`, `.dropdown`, `.mi`, `.picker`, `.pk`, `.rail-*`, `.rt`, `.fly*`, `.doctab`, `.ghead`, `.empty`, `.btn`, the `.dockview-theme-vs` variables, `.toast`, `.switcher`, `.sw-*`, `.tip`).

Menus, the picker and tooltips render into the document of the element that opened them (`createPortal(…, anchor.doc.body)`), so they open inside a pop-out window too, and every overlay sits on its `--z-*` token, above dockview's floating groups. A tooltip with `data-tip` always shows; `data-tipcut` shows only when the element's text was cut (spec §7). The rails and the flyout are the mockup's own auto-hide, ported: resting 280 ms on a side tab opens the pane, leaving both tab and pane for 550 ms closes it, a press elsewhere closes it.

- [ ] **Step 1: Write the failing tests**

`src/dock/overlays.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { railOf } from './AutoHide';
import { Menu } from './Menu';
import { filterItems } from './Picker';
import { switcherOrder, touch } from './Switcher';
import { tipFor } from './Tooltip';

describe('Menu', () => {
  it('renders into the anchor document, runs an item, and skips a disabled one', () => {
    const onClose = vi.fn(), run = vi.fn(), never = vi.fn();
    render(<Menu label="Test" anchor={{ x: 10, y: 20, doc: document }} onClose={onClose} entries={[
      { id: 'a', label: 'Float', kbd: 'Ctrl+dbl-click', onSelect: run },
      'separator',
      { id: 'b', label: 'Undo', disabled: true, tip: 'Not available yet', onSelect: never },
    ]} />);

    fireEvent.click(screen.getByRole('menuitem', { name: /Undo/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Float/ }));

    expect(never).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menuitem', { name: /Undo/ })).toHaveAttribute('data-tip', 'Not available yet');
  });

  it('closes on a press outside it', () => {
    const onClose = vi.fn();
    render(<Menu label="Test" anchor={{ x: 0, y: 0, doc: document }} onClose={onClose} entries={[{ id: 'a', label: 'A', onSelect: () => {} }]} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('filterItems', () => {
  const items = [{ id: '1', label: 'orders_1.0.0-ab12', open: false }, { id: '2', label: 'Billing_2.0.0-cd34', open: true }];
  it('matches any part of the unique name, ignoring case, and keeps the order', () => {
    expect(filterItems(items, '').map((i) => i.id)).toEqual(['1', '2']);
    expect(filterItems(items, ' bill ').map((i) => i.id)).toEqual(['2']);
    expect(filterItems(items, 'cd34').map((i) => i.id)).toEqual(['2']);
    expect(filterItems(items, 'zzz')).toEqual([]);
  });
});

describe('tipFor', () => {
  const el = (html: string) => { document.body.innerHTML = html; return document.body.firstElementChild!; };

  it('always shows data-tip, from the element or an ancestor', () => {
    const host = el('<button data-tip="Not available yet"><span>▶ Start</span></button>');
    expect(tipFor(host.querySelector('span'))?.text).toBe('Not available yet');
  });

  it('shows data-tipcut only when the text overflows its box', () => {
    const span = el('<span data-tipcut="a very long source hash">a very…</span>') as HTMLElement;
    Object.defineProperty(span, 'clientWidth', { value: 100, configurable: true });
    Object.defineProperty(span, 'scrollWidth', { value: 100, configurable: true });
    expect(tipFor(span)).toBeNull();
    Object.defineProperty(span, 'scrollWidth', { value: 240, configurable: true });
    expect(tipFor(span)?.text).toBe('a very long source hash');
  });

  it('shows nothing outside any tip', () => {
    expect(tipFor(el('<div>plain</div>'))).toBeNull();
    expect(tipFor(null)).toBeNull();
  });
});

describe('switcher order and rails', () => {
  it('keeps recently used first, then the rest in their own order', () => {
    expect(touch(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(switcherOrder(['c', 'gone', 'a'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('sends a top pane to the bottom rail', () => {
    expect([railOf('left'), railOf('right'), railOf('top'), railOf('bottom')]).toEqual(['l', 'r', 'b', 'b']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/dock/overlays.test.tsx`
Expected: FAIL, `./AutoHide`, `./Menu`, `./Picker`, `./Switcher` and `./Tooltip` cannot be resolved.

- [ ] **Step 3: Write the chrome's stylesheet**

`src/dock/dock.css`:

```css
/* The studio chrome (mockup v49): menu strip, dock, auto-hide rails and flyout, menus, picker,
   switcher, toast and tooltip. Values are the mockup's, verbatim. Every overlay sits on a
   --z-* token (canvas/tokens.css), above dockview's floating groups (999). */
/* not .shell: the canvas's blocks use that class on SVG rects */
.studio-shell { display: grid; grid-template-rows: 34px 1fr; height: 100vh; }

/* menu strip */
.menubar { display: flex; align-items: center; gap: 6px; padding: 0 10px; background: #0B1424; border-bottom: 1px solid var(--line); font-size: 13px; position: relative; z-index: 20; }
.brand { display: flex; align-items: center; gap: 7px; font-weight: 600; letter-spacing: .02em; margin-right: 10px; color: var(--ink); }
.menus { display: flex; }
.menu { padding: 6px 10px; border-radius: 5px; color: var(--muted); cursor: pointer; user-select: none; background: none; border: 0; font: inherit; }
.menu:hover, .menu.open { background: var(--panel-2); color: var(--ink); }

/* dropdown menus: the strip's menus and the window-position menu */
.dropdown { position: fixed; min-width: 240px; padding: 6px; background: var(--panel-2); border: 1px solid var(--line-2); border-radius: 8px; box-shadow: 0 18px 40px -12px rgba(0, 0, 0, .7); z-index: var(--z-menu); font-family: var(--sans); }
.mi { display: flex; justify-content: space-between; gap: 24px; padding: 7px 10px; border-radius: 5px; font-size: 13px; color: var(--ink); cursor: pointer; }
.mi:hover { background: rgba(125, 211, 252, .10); }
.mi kbd { font-family: var(--mono); font-size: 11px; color: var(--faint); }
.mi .ml { display: flex; align-items: center; gap: 8px; }
.mi .mic { width: 16px; text-align: center; color: var(--muted); }
.mi.dis .mic { opacity: .4; }
.mi.dis { color: var(--faint); cursor: default; }
.mi.dis:hover { background: none; }
.msep { height: 1px; background: var(--line); margin: 5px 4px; }

/* the open-workflow picker */
.picker { position: fixed; width: 440px; max-height: 60vh; overflow: auto; padding: 8px; background: var(--panel-2); border: 1px solid var(--line-2); border-radius: 10px; box-shadow: 0 24px 60px -16px rgba(0, 0, 0, .8); z-index: var(--z-menu); font-family: var(--sans); }
.pk-h { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); padding: 6px 8px 8px; }
.pk { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 9px 10px; border-radius: 6px; cursor: pointer; }
.pk:hover, .pk.hi { background: rgba(125, 211, 252, .10); }
.pk b { font-weight: 600; font-size: 13.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pk .o { font-size: 11px; color: var(--accent); }
.picker .input { font-family: var(--mono); font-size: 12px; background: var(--ground-2); border: 1px solid var(--line-2); border-radius: 5px; padding: 6px 8px; color: var(--ink); width: 100%; margin: 0 0 6px; }
.picker .note { font-size: 11.5px; color: var(--faint); line-height: 1.5; padding: 8px; }

/* the dock and its auto-hide rails (our own: dockview's auto-hide is an enterprise module) */
.dockwrap { position: relative; display: grid; grid-template-columns: auto 1fr auto; grid-template-rows: 1fr auto; min-height: 0; }
.dock { min-height: 0; height: 100%; grid-area: 1 / 2; }
.rail-r { grid-area: 1 / 3; display: none; flex-direction: column; gap: 4px; padding: 8px 0; width: 28px; background: #0B1424; border-left: 1px solid var(--line); }
.rail-l { grid-area: 1 / 1; display: none; flex-direction: column; gap: 4px; padding: 8px 0; width: 28px; background: #0B1424; border-right: 1px solid var(--line); }
.rail-l.on { display: flex; }
.rail-l .rt { writing-mode: vertical-rl; transform: rotate(180deg); padding: 10px 6px; }
.rail-b { grid-area: 2 / 1 / 3 / 4; display: none; gap: 4px; padding: 0 8px; height: 26px; align-items: center; background: #0B1424; border-top: 1px solid var(--line); }
.rail-r.on, .rail-b.on { display: flex; }
.rt { font-size: 11.5px; color: var(--muted); cursor: pointer; border-radius: 4px; user-select: none; display: flex; align-items: center; gap: 6px; }
.rail-r .rt { writing-mode: vertical-rl; padding: 10px 6px; }
.rail-b .rt { padding: 3px 10px; }
.rt:hover, .rt.open { color: var(--ink); background: var(--panel-2); }
.rt .fd { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 6px var(--accent); display: none; }
.rt.fresh .fd { display: block; }
.fly { position: absolute; z-index: var(--z-fly); display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line-2); box-shadow: 0 20px 60px -12px rgba(0, 0, 0, .85); }
.fly.r { top: 0; bottom: 0; right: 28px; width: 340px; animation: flyR .16s ease-out; }
.fly.l { top: 0; bottom: 0; left: 28px; width: 340px; animation: flyL .16s ease-out; }
.fly.b { left: 0; right: 0; bottom: 26px; height: 220px; animation: flyB .16s ease-out; }
@keyframes flyL { from { transform: translateX(-24px); opacity: 0; } }
@keyframes flyR { from { transform: translateX(24px); opacity: 0; } }
@keyframes flyB { from { transform: translateY(24px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .fly.r, .fly.l, .fly.b { animation: none; } }
.fly-h { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px 0 12px; background: #0B1424; border-bottom: 1px solid var(--line); font-size: 12.5px; }
.fly-h .spacer { flex: 1; }
.fly-h button { font-family: var(--sans); font-size: 12px; padding: 3px 8px; border-radius: 4px; border: 1px solid transparent; background: none; color: var(--muted); cursor: pointer; }
.fly-h button:hover { color: var(--ink); background: var(--panel-2); border-color: var(--line-2); }
.fly-b { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* tabs */
.doctab { display: flex; align-items: center; gap: 7px; height: 100%; padding: 0 4px 0 2px; font-size: 12.5px; white-space: nowrap; }
.doctab .tv { font-family: var(--mono); font-size: 10.5px; color: var(--faint); }
.doctab .nm { max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.doctab .x { width: 18px; height: 18px; border-radius: 4px; display: grid; place-items: center; color: var(--faint); font-size: 13px; cursor: pointer; }
.doctab .x:hover { background: var(--line); color: var(--ink); }

/* group header actions */
.ghead { display: flex; align-items: center; gap: 2px; height: 100%; padding: 0 6px; }
.ghead button { width: 24px; height: 22px; border: 1px solid transparent; border-radius: 4px; background: none; color: var(--faint); cursor: pointer; font-size: 12.5px; line-height: 1; }
.ghead button:hover { color: var(--ink); background: var(--panel-2); border-color: var(--line-2); }

/* an empty document area */
.empty { position: absolute; inset: 0; display: grid; place-items: center; background: var(--ground); text-align: center; }
.empty .e1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
.empty .e2 { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
.btn { font-family: var(--sans); font-size: 13px; font-weight: 600; padding: 7px 16px; border-radius: 6px; border: 1px solid var(--line-2); background: var(--panel-2); color: var(--ink); cursor: pointer; }
.btn.primary { background: linear-gradient(180deg, #38BDF8, #0EA5E9); border-color: #38BDF8; color: #04111F; box-shadow: 0 0 0 1px rgba(56, 189, 248, .25), 0 6px 18px -6px rgba(56, 189, 248, .55); }

/* dockview, in the blueprint's colours (VS behaviour, our palette) */
.dockview-theme-vs {
  --dv-group-view-background-color: var(--panel);
  --dv-tabs-and-actions-container-background-color: #0B1424;
  --dv-tabs-and-actions-container-height: 32px;
  --dv-tabs-and-actions-container-font-size: 12.5px;
  --dv-activegroup-visiblepanel-tab-background-color: var(--panel);
  --dv-activegroup-hiddenpanel-tab-background-color: #0B1424;
  --dv-inactivegroup-visiblepanel-tab-background-color: #101C30;
  --dv-inactivegroup-hiddenpanel-tab-background-color: #0B1424;
  --dv-activegroup-visiblepanel-tab-color: var(--ink);
  --dv-activegroup-hiddenpanel-tab-color: var(--muted);
  --dv-inactivegroup-visiblepanel-tab-color: var(--muted);
  --dv-inactivegroup-hiddenpanel-tab-color: var(--faint);
  --dv-tab-divider-color: var(--line);
  --dv-separator-border: var(--line);
  --dv-paneview-header-border-color: var(--line);
  --dv-sash-color: transparent;
  --dv-active-sash-color: var(--accent);
  --dv-drag-over-background-color: rgba(125, 211, 252, .16);
  --dv-drag-over-border-color: var(--accent);
  --dv-edge-dock-indicator-color: var(--accent);
  --dv-floating-box-shadow: 0 24px 60px -16px rgba(0, 0, 0, .85);
  --dv-floating-titlebar-background-color: #0B1424;
  --dv-icon-hover-background-color: var(--panel-2);
  --dv-background-color: var(--ground);
  --dv-scrollbar-background-color: var(--line-2);
  font-family: var(--sans);
}
.dockview-theme-vs .dv-tab.dv-active-tab { box-shadow: inset 0 2px 0 var(--accent); }

/* toast, switcher, tooltip */
.toast { position: fixed; left: 50%; top: 44px; z-index: var(--z-toast); transform: translate(-50%, -8px); opacity: 0; padding: 8px 14px; border-radius: 8px; font-size: 13px;
  background: var(--panel-2); border: 1px solid var(--line-2); color: var(--ink); transition: opacity .2s, transform .2s; pointer-events: none; }
.toast.on { opacity: 1; transform: translate(-50%, 0); }
.switcher { position: fixed; left: 50%; top: 22%; transform: translateX(-50%); z-index: var(--z-switcher); width: 620px; max-width: 92vw; padding: 12px; background: var(--panel-2); border: 1px solid var(--line-2); border-radius: 12px; box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .9); font-family: var(--sans); }
.sw-t { font-size: 13px; font-weight: 600; margin: 2px 4px 10px; }
.sw-t .m, .sw-i .m { font-family: var(--mono); font-size: 11px; color: var(--faint); font-weight: 400; }
.sw-b { display: grid; grid-template-columns: 1fr 1.4fr; gap: 12px; }
.sw-h { font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); margin: 0 6px 6px; }
.sw-i { padding: 7px 10px; border-radius: 6px; font-size: 13px; cursor: pointer; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-i b { color: var(--ink); font-weight: 500; }
.sw-i:hover { background: rgba(125, 211, 252, .08); }
.sw-i.on { background: rgba(125, 211, 252, .16); color: var(--ink); box-shadow: inset 2px 0 0 var(--accent); }
.tip { position: fixed; left: 0; top: 0; pointer-events: none; z-index: var(--z-tip); padding: 6px 10px; border-radius: 7px; background: #0B1424; border: 1px solid var(--line-2);
  box-shadow: 0 12px 30px -10px rgba(0, 0, 0, .8); color: var(--ink); font: 12px/1.5 var(--mono); white-space: pre; opacity: 0; transform: translateY(3px); transition: opacity .12s, transform .12s; }
.tip.on { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) { .tip { transition: none; } }

/* a group auto-hidden in place keeps its slot at zero size; nothing of it may show or take a click */
.dockview-theme-vs .dv-view:not(.visible) { visibility: hidden; }
```

- [ ] **Step 4: Implement the overlays**

`src/dock/windowKey.ts`:

```ts
const keys = new WeakMap<Window, string>();
let next = 0;

/** A stable React key for a browser window (the main one or a pop-out). */
export function windowKey(win: Window): string {
  let key = keys.get(win);
  if (key === undefined) { key = `w${next++}`; keys.set(win, key); }
  return key;
}
```

`src/dock/Menu.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/** Where an overlay opens: viewport coordinates in one window's document (a pop-out has its own). */
export interface Anchor { x: number; y: number; doc: Document }

/** Below an element, in that element's own document (spec §6.3: never the global document). */
export function anchorBelow(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 2, doc: el.ownerDocument };
}

/** At the pointer, in the document the event happened in. */
export function anchorAt(e: { clientX: number; clientY: number; target: EventTarget | null }): Anchor {
  const doc = e.target instanceof Node ? e.target.ownerDocument ?? document : document;
  return { x: e.clientX, y: e.clientY, doc };
}

export interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  kbd?: string;
  disabled?: boolean;
  /** Shown as a tooltip; a disabled item says why. */
  tip?: string;
  onSelect: () => void;
}
export type MenuEntry = MenuItem | 'separator';

/**
 * A dropdown (mockup v49 .dropdown): the menu strip's menus and the window-position menu. It is
 * rendered into the anchor's document at --z-menu, so it opens above a floating group and inside a
 * pop-out window. A pointer press anywhere outside closes it, except on the menu strip, whose
 * buttons toggle and switch menus themselves.
 */
export function Menu({ entries, anchor, onClose, label }: { entries: readonly MenuEntry[]; anchor: Anchor; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[role="menubar"]')) return;
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    anchor.doc.addEventListener('pointerdown', away, true);
    return () => anchor.doc.removeEventListener('pointerdown', away, true);
  }, [anchor.doc, onClose]);

  const view = anchor.doc.defaultView;
  const left = Math.max(8, Math.min(anchor.x, (view?.innerWidth ?? 1280) - 270));
  const top = Math.max(8, anchor.y);

  return createPortal(
    <div ref={ref} className="dropdown" role="menu" aria-label={label} style={{ left, top }}>
      {entries.map((entry, i) =>
        entry === 'separator' ? (
          <div key={`sep${i}`} className="msep" role="separator" />
        ) : (
          <div
            key={entry.id}
            role="menuitem"
            aria-disabled={entry.disabled ? true : undefined}
            className={entry.disabled ? 'mi dis' : 'mi'}
            data-tip={entry.tip}
            onClick={() => {
              if (entry.disabled) return;
              onClose();
              entry.onSelect();
            }}
          >
            <span className="ml"><span className="mic">{entry.icon ?? ''}</span>{entry.label}</span>
            <kbd>{entry.kbd ?? ''}</kbd>
          </div>
        ))}
    </div>,
    anchor.doc.body,
  );
}
```

`src/dock/Picker.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Anchor } from './Menu';

export interface PickerItem {
  id: string;
  /** The unique entity name (spec §7: the name the logs use). */
  label: string;
  /** Already open as a document: picking it switches to that tab. */
  open: boolean;
}

/** Case-insensitive substring match on the label; the list keeps its order. */
export function filterItems(items: readonly PickerItem[], query: string): PickerItem[] {
  const q = query.trim().toLowerCase();
  return q === '' ? [...items] : items.filter((i) => i.label.toLowerCase().includes(q));
}

/**
 * The searchable open-workflow dropdown (spec §6.1, mockup v49 .picker). Type to filter, Enter
 * opens the first match, Escape or a press outside closes it.
 */
export function Picker({ items, anchor, onPick, onClose, note }: {
  items: readonly PickerItem[]; anchor: Anchor; onPick: (id: string) => void; onClose: () => void;
  /** Shown instead of the list when there is nothing to list (the list could not be read). */
  note?: string;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterItems(items, query), [items, query]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    anchor.doc.addEventListener('pointerdown', away, true);
    return () => anchor.doc.removeEventListener('pointerdown', away, true);
  }, [anchor.doc, onClose]);

  const pick = (id: string) => { onClose(); onPick(id); };
  const view = anchor.doc.defaultView;
  const left = Math.max(8, Math.min(anchor.x, (view?.innerWidth ?? 1280) - 452));

  return createPortal(
    <div ref={ref} className="picker" role="dialog" aria-label="Open workflow" style={{ left, top: anchor.y }}>
      <div className="pk-h">Open workflow</div>
      <input
        className="input"
        aria-label="Search workflows"
        placeholder="Search workflows…"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          if (e.key === 'Enter' && shown[0]) { e.preventDefault(); pick(shown[0].id); }
        }}
      />
      <div role="listbox" aria-label="Workflows">
        {shown.map((item, i) => (
          <div key={item.id} role="option" aria-selected={i === 0} className={i === 0 ? 'pk hi' : 'pk'} onClick={() => pick(item.id)}>
            <b data-tipcut={item.label}>{item.label}</b>
            <span className="o">{item.open ? 'open — switch' : ''}</span>
          </div>
        ))}
        {shown.length === 0 && <div className="note">{items.length === 0 && note ? note : 'No workflow matches.'}</div>}
      </div>
    </div>,
    anchor.doc.body,
  );
}
```

`src/dock/Tooltip.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { windowKey } from './windowKey';

const DELAY_MS = 350;

/**
 * The tooltip an element asks for (mockup v49): `data-tip` always shows; `data-tipcut` (read-only
 * text) shows only when the element's text was cut, i.e. it overflows its box (spec §7).
 */
export function tipFor(target: Element | null): { el: Element; text: string } | null {
  const el = target?.closest('[data-tip],[data-tipcut]') ?? null;
  if (!el) return null;
  const always = el.getAttribute('data-tip');
  if (always !== null) return always === '' ? null : { el, text: always };
  const box = el as HTMLElement;
  if (box.scrollWidth <= box.clientWidth + 1) return null;
  return { el, text: el.getAttribute('data-tipcut') ?? '' };
}

/** One window's tooltip, at --z-tip, following the pointer in that window's document. */
function WindowTooltip({ win }: { win: Window }) {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [on, setOn] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const doc = win.document;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | null = null;
    const move = (e: PointerEvent) => {
      const found = tipFor(e.target instanceof Element ? e.target : null);
      if ((found?.el ?? null) !== current) {
        current = found?.el ?? null;
        clearTimeout(timer);
        setOn(false);
        if (found) timer = setTimeout(() => { setTip({ text: found.text, x: e.clientX, y: e.clientY }); setOn(true); }, DELAY_MS);
      } else if (found) {
        setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t));
      }
    };
    const down = () => { clearTimeout(timer); current = null; setOn(false); };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerdown', down, true);
    return () => {
      clearTimeout(timer);
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerdown', down, true);
    };
  }, [win]);

  // keep it inside the window, as the mockup's placeTip does
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    el.style.left = `${Math.min(tip.x + 14, win.innerWidth - el.offsetWidth - 8)}px`;
    el.style.top = `${Math.min(tip.y + 18, win.innerHeight - el.offsetHeight - 8)}px`;
  }, [tip, win]);

  return createPortal(
    <div ref={ref} className={on ? 'tip on' : 'tip'} role="tooltip" aria-hidden={!on}>{tip?.text ?? ''}</div>,
    win.document.body,
  );
}

/** Tooltips for the main window and every pop-out window. */
export function Tooltips({ windows }: { windows: readonly Window[] }) {
  return <>{windows.map((w) => <WindowTooltip key={windowKey(w)} win={w} />)}</>;
}
```

`src/dock/Switcher.tsx`:

```tsx
/** Moves `id` to the front of a most-recently-used list. Pure. */
export function touch(mru: readonly string[], id: string): string[] {
  return [id, ...mru.filter((x) => x !== id)];
}

/** The switcher's order: recently used first, then everything else present, in its own order. */
export function switcherOrder(mru: readonly string[], present: readonly string[]): string[] {
  const known = mru.filter((id) => present.includes(id));
  return [...known, ...present.filter((id) => !known.includes(id))];
}

export interface SwitcherEntry { id: string; label: string; document: boolean; hint?: string }

/**
 * Ctrl+E (spec §6.2.6; the browser keeps Ctrl+Tab), mockup v49 .switcher: hold Ctrl, tap E to move
 * down the most-recent list, release Ctrl to go there. A click goes straight there.
 */
export function Switcher({ entries, selected, onPick }: { entries: readonly SwitcherEntry[]; selected: string | null; onPick: (id: string) => void }) {
  const row = (e: SwitcherEntry) => (
    <div key={e.id} role="option" aria-selected={e.id === selected} className={e.id === selected ? 'sw-i on' : 'sw-i'} onClick={() => onPick(e.id)}>
      {e.document ? <b>{e.label}</b> : e.label}
      {e.hint && <span className="m">{` · ${e.hint}`}</span>}
    </div>
  );
  return (
    <div className="switcher" role="dialog" aria-label="Switch window">
      <div className="sw-t">Switch window <span className="m">hold Ctrl · tap E · release</span></div>
      <div className="sw-b">
        <div role="listbox" aria-label="Active tool windows"><div className="sw-h">Active tool windows</div>{entries.filter((e) => !e.document).map(row)}</div>
        <div role="listbox" aria-label="Active documents"><div className="sw-h">Active documents</div>{entries.filter((e) => e.document).map(row)}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement the rails and the flyout**

`src/dock/AutoHide.tsx`:

```tsx
import { useEffect, useRef, type ReactNode } from 'react';
import type { Side } from './home';
import { TOOL_TITLES, type ToolId } from './ids';

export type Rail = 'l' | 'r' | 'b';
/** A pane on the top edge hides to the bottom rail, as in the mockup (there is no top rail). */
export const railOf = (side: Side): Rail => (side === 'left' ? 'l' : side === 'right' ? 'r' : 'b');

const OPEN_AFTER_MS = 280; // resting on a side tab slides its pane out
const CLOSE_AFTER_MS = 550; // leaving both tab and pane slides it back

interface Props {
  hidden: readonly ToolId[];
  sideOf: (id: ToolId) => Side;
  flyId: ToolId | null;
  fresh: ReadonlySet<ToolId>;
  onOpen: (id: ToolId) => void;
  onClose: () => void;
  onPin: (id: ToolId) => void;
  renderTool: (id: ToolId) => ReactNode;
}

/**
 * Auto-hide, built in-house (spec §6.2.5; dockview's own is an enterprise module), ported from the
 * mockup: hidden panes become side tabs on the left, right or bottom rail. A click, or resting on
 * a tab, slides the pane out over the dock; leaving both, a press elsewhere or Esc slides it back;
 * Dock pins it back into the layout. A tab marked fresh glows (the Inspector's content changed).
 * Rendered inside `.dockwrap`, whose grid places the rails.
 */
export function AutoHide({ hidden, sideOf, flyId, fresh, onOpen, onClose, onPin, renderTool }: Props) {
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flyRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); }, []);

  useEffect(() => {
    if (flyId === null) return;
    const away = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && (t.closest('.fly') || t.closest('[data-rt]') || t.closest('.dropdown') || t.closest('.picker'))) return;
      onClose();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [flyId, onClose]);

  const closeLater = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      const fly = flyRef.current;
      if (fly && (fly.matches(':hover') || fly.contains(document.activeElement))) return;
      if (document.querySelector('[data-rt]:hover')) return;
      onClose();
    }, CLOSE_AFTER_MS);
  };

  const rail = (edge: Rail) => {
    const ids = hidden.filter((id) => railOf(sideOf(id)) === edge);
    return (
      <div className={ids.length > 0 ? `rail-${edge} on` : `rail-${edge}`} role="tablist" aria-label={`Auto-hidden panes (${edge === 'l' ? 'left' : edge === 'r' ? 'right' : 'bottom'})`}>
        {ids.map((id) => (
          <div
            key={id}
            role="tab"
            aria-selected={flyId === id}
            data-rt={id}
            className={['rt', flyId === id ? 'open' : '', fresh.has(id) ? 'fresh' : ''].filter(Boolean).join(' ')}
            onClick={(e) => { e.stopPropagation(); if (flyId === id) onClose(); else onOpen(id); }}
            onPointerEnter={() => {
              clearTimeout(openTimer.current);
              openTimer.current = setTimeout(() => { if (flyId !== id) onOpen(id); }, OPEN_AFTER_MS);
            }}
            onPointerLeave={() => { clearTimeout(openTimer.current); closeLater(); }}
          >
            <i className="fd" />
            {TOOL_TITLES[id]}
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      {rail('l')}
      {rail('r')}
      {rail('b')}
      {flyId !== null && (
        <div
          ref={flyRef}
          className={`fly ${railOf(sideOf(flyId))}`}
          role="region"
          aria-label={TOOL_TITLES[flyId]}
          onPointerEnter={() => clearTimeout(closeTimer.current)}
          onPointerLeave={closeLater}
        >
          <div className="fly-h">
            <span>{TOOL_TITLES[flyId]}</span>
            <span className="spacer" />
            <button type="button" data-tip="Dock it back into the layout" onClick={() => onPin(flyId)}>⤓ Dock</button>
            <button type="button" aria-label="Hide" data-tip="Hide (Esc)" onClick={onClose}>×</button>
          </div>
          <div className="fly-b">{renderTool(flyId)}</div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 6: Run the tests and the typecheck** (PowerShell)

```powershell
npx vitest run src/dock
npm run typecheck
```

Expected: 5 test files, 48 tests passed (the overlay-token test now also scans `dock.css`); typecheck prints nothing.

- [ ] **Step 7: Commit** (from the repository root)

```bash
git add src/WorkflowStudio/src/dock/dock.css src/WorkflowStudio/src/dock/Menu.tsx src/WorkflowStudio/src/dock/Picker.tsx src/WorkflowStudio/src/dock/Tooltip.tsx src/WorkflowStudio/src/dock/Switcher.tsx src/WorkflowStudio/src/dock/AutoHide.tsx src/WorkflowStudio/src/dock/windowKey.ts src/WorkflowStudio/src/dock/overlays.test.tsx
git commit -m "feat(studio): menus, picker, tooltips, switcher and auto-hide rails" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The dock shell

**Files:**
- Create: `src/dock/parts.tsx`, `src/dock/DockShell.tsx`
- Test: `src/dock/DockShell.test.tsx`

**Interfaces:**
- Consumes: everything in `src/dock/` (Tasks 5 and 6); `DockviewReact`, `themeVisualStudio` and the prop types from `dockview-react`.
- Produces:
  - `parts.tsx`: `interface DockDocument { id; name; version; tooltip }`; `type GroupAction`; `interface ShellApi`; `ShellProvider`; `useShell()`; `DocumentHost`, `ToolHost`, `StudioTab`, `GroupActions`, `Watermark`.
  - `DockShell(props: DockShellProps)` with `documents`, `activeDocumentId`, `onActivateDocument`, `onCloseDocument`, `workflows: PickerItem[]`, `pickerNote?`, `onPickerOpen?`, `onOpenWorkflow`, `renderDocument(id, panel: DockviewPanelApi)`, `renderTool(id: ToolId)`, `inspectorKey`, `onEscape`, `popoutContent?`, `storage?`. Re-exports the `DockDocument` and `PickerItem` types.

How it works, in short:
- **Documents** follow the `documents` prop: a missing panel is added to the document area (`renderer: 'always'`), a panel whose document went is removed. When `activeDocumentId` changes, that tab is focused; when the user activates a document tab, `onActivateDocument` is called. Closing a document (×, middle click, Alt+W, the menu) only asks the page (`onCloseDocument`); the page's new `documents` then remove the panel. Picking a workflow that is already open focuses its tab.
- **Drops**: `onWillShowOverlay` refuses any drop of a document outside the document area (`canDrop`).
- **Tabs** (`StudioTab`): right-click opens the window-position menu; double-click maximizes; Ctrl+double-click floats or docks; middle click and × close. Group header buttons (`GroupActions`, mockup v49): + (documents), ▾ and ⇥ (tool panes), ⧉ float, ⇱ pop out, ▢ maximize; floating or popped out: ▾, ⤓ Dock and (floating) ⇱.
- **Menus**: File (Open workflow… Ctrl+O, Close Alt+W), Edit (Undo, Redo, Select all, all disabled, "Not available yet"), View (the four panes, ✓ when shown), Window (Float, Dock, Switch window… Ctrl+E, Save, Apply and Reset window layout).
- **Keys**, in the main window and every pop-out: Ctrl+E / Ctrl+Shift+E (switcher; release Ctrl to go), Alt+W, Ctrl+O, Esc (switcher, menu, picker, flyout, then `onEscape`), F5 / Shift+F5 (a toast, never a reload).
- **Layout**: at startup the saved layout is applied, else the default; a rejected one falls back to the default with a toast. The open documents are re-synced after every apply or reset.
- **Pop-outs**: `onDidAddPopoutGroup` / `onDidRemovePopoutGroup` keep the list of pop-out windows, which get the keys, their own tooltip layer and `popoutContent`.

- [ ] **Step 1: Write the failing test**

`src/dock/DockShell.test.tsx`:

```tsx
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockShell, type DockDocument, type DockShellProps } from './DockShell';
import { LAYOUT_KEY } from './layoutPersistence';
import { memoryStorage } from '../test/memoryStorage';


const doc = (id: string): DockDocument => ({ id, name: `wf-${id}`, version: '1.0.0', tooltip: `wf-${id}_1.0.0-${id}` });

function setup(over: Partial<DockShellProps> = {}) {
  const props: DockShellProps = {
    documents: [],
    activeDocumentId: null,
    onActivateDocument: vi.fn(),
    onCloseDocument: vi.fn(),
    workflows: [{ id: 'a', label: 'orders_1.0.0-aaaa', open: false }, { id: 'b', label: 'billing_2.0.0-bbbb', open: true }],
    onOpenWorkflow: vi.fn(),
    renderDocument: (id) => <div>canvas of {id}</div>,
    renderTool: (id) => <div>body of {id}</div>,
    inspectorKey: 'k0',
    onEscape: vi.fn(),
    storage: memoryStorage(),
    ...over,
  };
  const view = render(<div style={{ width: 1200, height: 700 }}><DockShell {...props} /></div>);
  const update = (next: Partial<DockShellProps>) => {
    Object.assign(props, next);
    view.rerender(<div style={{ width: 1200, height: 700 }}><DockShell {...props} /></div>);
  };
  return { props, update };
}

const tab = (name: string) => screen.getAllByText(name, { selector: '.doctab .nm' })[0]!.closest('.doctab') as HTMLElement;
const toast = () => document.querySelector('.toast') as HTMLElement;
const railTab = (id: string) => document.querySelector(`[data-rt="${id}"]`) as HTMLElement | null;
const flyout = () => document.querySelector('.fly') as HTMLElement | null;
const openMenu = (name: string) => fireEvent.click(screen.getByRole('menuitem', { name }));
const choose = (label: RegExp | string) => fireEvent.click(screen.getByRole('menuitem', { name: label }));

afterEach(() => { vi.useRealTimers(); });

describe('DockShell', () => {
  it('starts with the default layout: the four panes and an empty document area', () => {
    setup();
    for (const name of ['Inspector', 'Toolbox', 'Problems', 'Output']) expect(tab(name)).toBeInTheDocument();
    expect(screen.getByText('No workflow open')).toBeInTheDocument();
    expect(screen.getByText('body of inspector')).toBeInTheDocument();
  });

  it('opens a tab for each document, renders it, and closes it when the document goes', () => {
    const { update } = setup();
    update({ documents: [doc('a'), doc('b')], activeDocumentId: 'b' });
    expect(tab('wf-a')).toHaveAttribute('data-tip', 'wf-a_1.0.0-a');
    expect(screen.getByText('canvas of a')).toBeInTheDocument();
    expect(screen.getByText('canvas of b')).toBeInTheDocument();

    update({ documents: [doc('b')] });
    expect(screen.queryByText('canvas of a')).toBeNull();
  });

  it('asks the page to close a document from its ×, a middle click and Alt+W', () => {
    const { props, update } = setup();
    update({ documents: [doc('a'), doc('b')], activeDocumentId: 'b' });

    fireEvent.click(within(tab('wf-a')).getByRole('button', { name: 'Close wf-a' }));
    fireEvent(tab('wf-b'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    fireEvent.keyDown(window, { key: 'w', altKey: true });

    expect(vi.mocked(props.onCloseDocument).mock.calls).toEqual([['a'], ['b'], ['b']]);
  });

  it('hides and shows a pane from the View menu', () => {
    setup();
    openMenu('View');
    choose(/Problems/);
    expect(screen.queryByText('body of problems')).toBeNull();
    openMenu('View');
    choose(/Problems/);
    expect(screen.getByText('body of problems')).toBeInTheDocument();
  });

  it('auto-hides a pane from its tab menu, slides it out from the rail, and docks it back', () => {
    setup();
    fireEvent.contextMenu(tab('Inspector'));
    choose(/Auto hide/);
    // hidden in place: dockview keeps the group's slot and size, so pinning back is exact
    const slot = () => tab('Inspector').closest('.dv-view')!;
    expect(slot()).not.toHaveClass('visible');

    fireEvent.click(railTab('inspector')!);
    expect(within(flyout()!).getByText('body of inspector')).toBeInTheDocument();

    fireEvent.click(within(flyout()!).getByRole('button', { name: /Dock/ }));
    expect(flyout()).toBeNull();
    expect(railTab('inspector')).toBeNull();
    expect(slot()).toHaveClass('visible');
  });

  it('makes a hidden Inspector glow when its content changes, until it is opened', () => {
    const { update } = setup();
    fireEvent.contextMenu(tab('Inspector'));
    choose(/Auto hide/);
    expect(railTab('inspector')).not.toHaveClass('fresh');

    update({ inspectorKey: 'k1' });
    expect(railTab('inspector')).toHaveClass('fresh');

    fireEvent.click(railTab('inspector')!);
    expect(railTab('inspector')).not.toHaveClass('fresh');
  });

  it('saves, resets and applies the window layout', () => {
    const storage = memoryStorage();
    setup({ storage });
    fireEvent.contextMenu(tab('Output'));
    choose(/Auto hide/);

    openMenu('Window');
    choose(/Save window layout/);
    expect(toast()).toHaveTextContent('Window layout saved in this browser');
    expect(JSON.parse(storage.getItem(LAYOUT_KEY)!).hidden).toEqual(['problems', 'output']);

    openMenu('Window');
    choose(/Reset window layout/);
    expect(railTab('output')).toBeNull();
    expect(tab('Output')).toBeInTheDocument();

    openMenu('Window');
    choose(/Apply saved layout/);
    expect(railTab('output')).toBeInTheDocument();
    expect(railTab('problems')).toBeInTheDocument();
  });

  it.each([
    ['corrupted', '{"version":1,"dock":'],
    ['from an older version', JSON.stringify({ version: 0, dock: {} })],
    ['rejected by dockview', JSON.stringify({ version: 1, dock: { grid: { root: { type: 'branch', data: [{ type: 'leaf', data: {} }] }, width: 1, height: 1, orientation: 'HORIZONTAL' }, panels: {} }, hidden: [], sides: {}, homes: {}, documentGroupId: null })],
  ])('falls back to the default layout when the saved one is %s (review focus 1)', (_name, text) => {
    setup({ storage: memoryStorage({ [LAYOUT_KEY]: text }) });
    for (const name of ['Inspector', 'Toolbox', 'Problems', 'Output']) expect(tab(name)).toBeInTheDocument();
  });

  it('opens the picker from File, filters it, and opens the first match on Enter', () => {
    const { props } = setup();
    openMenu('File');
    choose(/Open workflow/);
    const search = screen.getByRole('textbox', { name: 'Search workflows' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['orders_1.0.0-aaaa', 'billing_2.0.0-bbbbopen — switch']);

    fireEvent.change(search, { target: { value: 'BILL' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(props.onOpenWorkflow).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('dialog', { name: 'Open workflow' })).toBeNull();
  });

  it('keeps Edit present but disabled, and Start/Stop keys harmless', () => {
    setup();
    openMenu('Edit');
    for (const item of screen.getAllByRole('menuitem').filter((m) => m.classList.contains('mi'))) expect(item).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(window, { key: 'F5' });
    expect(toast()).toHaveTextContent('Start and Stop are not available yet.');
  });

  it('toggles a strip menu with its own button', () => {
    setup();
    openMenu('File');
    expect(screen.getByRole('menu', { name: 'File' })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'File' }));
    openMenu('File');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes an open menu on Esc before it clears the selection', () => {
    const { props } = setup();
    openMenu('View');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(props.onEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onEscape).toHaveBeenCalledTimes(1);
  });

  it('switches windows with Ctrl+E, released on Ctrl', () => {
    const { props, update } = setup();
    update({ documents: [doc('a'), doc('b')], activeDocumentId: 'b' });
    fireEvent.keyDown(window, { key: 'e', ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Switch window' });
    expect(within(dialog).getByRole('listbox', { name: 'Active documents' })).toHaveTextContent('wf-a');

    act(() => { fireEvent.keyUp(window, { key: 'Control' }); });

    expect(screen.queryByRole('dialog', { name: 'Switch window' })).toBeNull();
    expect(props.onActivateDocument).toHaveBeenCalled();
  });

  it('copes with dozens of open documents (review focus 5)', () => {
    const { update } = setup();
    const many = Array.from({ length: 40 }, (_, i) => doc(String(i)));
    update({ documents: many, activeDocumentId: '39' });
    expect(screen.getAllByText(/^canvas of /)).toHaveLength(40);
    update({ documents: many.slice(0, 2), activeDocumentId: '1' });
    expect(screen.getAllByText(/^canvas of /)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/dock/DockShell.test.tsx`
Expected: FAIL, `./DockShell` cannot be resolved.

- [ ] **Step 3: Implement the dock's parts**

`src/dock/parts.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from 'react';
import type { DockviewGroupPanel, DockviewPanelApi, IDockviewHeaderActionsProps, IDockviewPanelHeaderProps, IDockviewPanelProps } from 'dockview-react';
import { documentIdOf, isDocPanelId, isToolId, TOOL_TITLES, type ToolId } from './ids';
import { anchorAt, anchorBelow, type Anchor } from './Menu';

/** One open document, as the dock shows it. */
export interface DockDocument {
  id: string;
  name: string;
  version: string;
  /** The tab's tooltip: the unique entity name (spec §7). */
  tooltip: string;
}

export type GroupAction = 'open' | 'menu' | 'hide' | 'float' | 'popout' | 'maximize' | 'dock';

/** What the dock's parts (tabs, header buttons, hosts) ask of the shell. */
export interface ShellApi {
  documentInfo(id: string): DockDocument | undefined;
  renderDocument(id: string, panel: DockviewPanelApi): ReactNode;
  renderTool(id: ToolId): ReactNode;
  closePanel(panelId: string): void;
  windowMenu(panelId: string, anchor: Anchor): void;
  toggleFloat(panelId: string): void;
  toggleMaximize(panelId: string): void;
  openPicker(anchor: Anchor): void;
  groupAction(group: DockviewGroupPanel, action: GroupAction, anchor: Anchor): void;
}

const ShellContext = createContext<ShellApi | null>(null);
export const ShellProvider = ShellContext.Provider;

/** dockview renders these through React portals, so they read the shell from context. */
export function useShell(): ShellApi {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('A dock part needs the DockShell above it.');
  return shell;
}

/** A document panel's body: whatever the page renders for that document. */
export function DocumentHost({ api }: IDockviewPanelProps) {
  const shell = useShell();
  const id = documentIdOf(api.id);
  return id === null ? null : <>{shell.renderDocument(id, api)}</>;
}

/** A tool pane's body, docked or floating (the flyout renders the same body). */
export function ToolHost({ api }: IDockviewPanelProps) {
  const shell = useShell();
  return isToolId(api.id) ? <>{shell.renderTool(api.id)}</> : null;
}

/**
 * Every tab, documents and tool panes alike (mockup v49 .doctab): right-click opens the
 * window-position menu, double-click maximizes, Ctrl+double-click floats or docks, a middle click
 * or × closes (spec §6.2.1, §6.2.6). A document's tooltip is its unique name.
 */
export function StudioTab({ api }: IDockviewPanelHeaderProps) {
  const shell = useShell();
  const id = api.id;
  const documentId = documentIdOf(id);
  const info = documentId === null ? undefined : shell.documentInfo(documentId);
  const name = info?.name ?? (isToolId(id) ? TOOL_TITLES[id] : id);
  return (
    <div
      className="doctab"
      data-tip={info?.tooltip}
      onContextMenu={(e) => { e.preventDefault(); shell.windowMenu(id, anchorAt(e)); }}
      onDoubleClick={(e) => {
        if ((e.target as Element).closest('.x')) return;
        if (e.ctrlKey || e.metaKey) shell.toggleFloat(id);
        else shell.toggleMaximize(id);
      }}
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); shell.closePanel(id); } }}
    >
      <span className="nm">{name}</span>
      {info && <span className="tv">{info.version}</span>}
      <span
        className="x"
        role="button"
        aria-label={`Close ${name}`}
        data-tip="Close"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); shell.closePanel(id); }}
      >
        ×
      </span>
    </div>
  );
}

/**
 * A group's header buttons (mockup v49 GroupActions). Docked: + (documents), ▾ and ⇥ (tool
 * panes), float, pop out, maximize. Floating or popped out: ▾ (tool panes), Dock, and pop out
 * (floating only). An empty group is the document area waiting for a document.
 */
export function GroupActions({ group, panels, location }: IDockviewHeaderActionsProps) {
  const shell = useShell();
  const where = location?.type ?? group.api.location.type;
  const documents = panels.length === 0 || panels.some((p) => isDocPanelId(p.id));
  const button = (action: GroupAction, glyph: string, tip: string) => (
    <button
      type="button"
      aria-label={tip}
      data-tip={tip}
      onClick={(e) => { e.stopPropagation(); shell.groupAction(group, action, anchorBelow(e.currentTarget)); }}
    >
      {glyph}
    </button>
  );
  return (
    <div className="ghead">
      {where === 'grid' ? (
        <>
          {documents && button('open', '+', 'Open workflow')}
          {!documents && button('menu', '▾', 'Window position')}
          {!documents && button('hide', '⇥', 'Auto-hide to a side tab')}
          {panels.length > 0 && button('float', '⧉', 'Float this group (or Shift+drag a tab)')}
          {panels.length > 0 && button('popout', '⇱', 'Pop out to its own window')}
          {panels.length > 0 && button('maximize', '▢', 'Maximize / restore')}
        </>
      ) : (
        <>
          {!documents && button('menu', '▾', 'Window position')}
          {button('dock', '⤓', 'Dock back into the main layout')}
          {where === 'floating' && button('popout', '⇱', 'Pop out to its own window')}
        </>
      )}
    </div>
  );
}

/** An empty document area (mockup v49 .empty). */
export function Watermark() {
  const shell = useShell();
  return (
    <div className="empty">
      <div>
        <div className="e1">No workflow open</div>
        <div className="e2">File › Open workflow… or Ctrl+O</div>
        <button type="button" className="btn primary" onClick={(e) => shell.openPicker(anchorBelow(e.currentTarget))}>Open workflow…</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement the shell**

`src/dock/DockShell.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DockviewReact, themeVisualStudio, type DockviewApi, type DockviewGroupPanel, type DockviewPanelApi, type DockviewReadyEvent } from 'dockview-react';
import { AutoHide } from './AutoHide';
import { canDrop } from './dropRules';
import type { Rect } from './home';
import { docPanelId, documentIdOf, isDocPanelId, isToolId, TOOL_IDS, TOOL_TITLES, type ToolId } from './ids';
import { keyCommand } from './keys';
import { browserStorage, readLayout, writeLayout } from './layoutPersistence';
import { anchorBelow, Menu, type Anchor, type MenuEntry } from './Menu';
import { DocumentHost, GroupActions, ShellProvider, StudioTab, ToolHost, Watermark, type DockDocument, type GroupAction, type ShellApi } from './parts';
import { Picker, type PickerItem } from './Picker';
import { Switcher, switcherOrder, touch } from './Switcher';
import { Tooltips } from './Tooltip';
import { windowKey } from './windowKey';
import {
  addDocument, applyLayout, autoHide, captureLayout, dockAsDocument, dockBack, documentArea, ensureDocumentArea, floatGroup,
  floatPanel, newMemory, pinBack as pinToolBack, popOut, resetLayout, showTool, toolSide,
} from './windowActions';

export type { DockDocument } from './parts';
export type { PickerItem } from './Picker';

export interface DockShellProps {
  /** The open documents, in the order they were opened. The dock adds and removes their panels to match. */
  documents: readonly DockDocument[];
  /** The document the shared panes follow; when it changes, its tab is focused. */
  activeDocumentId: string | null;
  onActivateDocument: (id: string) => void;
  onCloseDocument: (id: string) => void;
  /** The picker's list (spec §6.1: searchable, by unique name). */
  workflows: readonly PickerItem[];
  /** Shown in the picker when `workflows` is empty, e.g. why the list could not be read. */
  pickerNote?: string;
  /** Called each time the picker opens, so the page can re-read the list. */
  onPickerOpen?: () => void;
  onOpenWorkflow: (id: string) => void;
  renderDocument: (id: string, panel: DockviewPanelApi) => ReactNode;
  renderTool: (id: ToolId) => ReactNode;
  /** Changes when the Inspector's content changes; a hidden Inspector's rail tab then glows (spec §6.2.5). */
  inspectorKey: string;
  /** Esc with no menu, picker, switcher or flyout open: the page clears the selection. */
  onEscape: () => void;
  /** Rendered into every pop-out window's body: what panels there need from the page (SVG definitions). */
  popoutContent?: ReactNode;
  /** Where the window layout is kept; tests pass their own. Default: this browser's localStorage. */
  storage?: Storage | null;
}

const COMPONENTS = { document: DocumentHost, tool: ToolHost };
const TAB_COMPONENTS = { studio: StudioTab };
const TOAST_MS = 2600;
const NOT_YET = 'Not available yet';
const STRIP = ['File', 'Edit', 'View', 'Window'] as const;
type StripMenu = (typeof STRIP)[number];

const NO_RECT: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * The studio's chrome (spec §6): the menu strip, the dockview dock with documents and the four tool
 * panes, in-house auto-hide rails, the window-position menu, the switcher, layout persistence, the
 * studio's keys, toasts and tooltips. It knows documents only by id: what a document or a tool pane
 * shows comes from `renderDocument` and `renderTool`.
 */
export function DockShell(props: DockShellProps) {
  const { documents, activeDocumentId, workflows, inspectorKey } = props;
  const storage = props.storage === undefined ? browserStorage() : props.storage;
  const [api, setApi] = useState<DockviewApi | null>(null);
  const memory = useRef(newMemory()).current;
  const dockRef = useRef<HTMLDivElement>(null);
  const stripRefs = useRef<Partial<Record<StripMenu, HTMLButtonElement | null>>>({});
  const applying = useRef(false);
  const mru = useRef<string[]>([]);

  const [hidden, setHidden] = useState<ToolId[]>([]);
  const [flyId, setFlyId] = useState<ToolId | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<ToolId>>(new Set());
  const [menu, setMenu] = useState<{ label: string; entries: MenuEntry[]; anchor: Anchor; strip?: StripMenu } | null>(null);
  const [picker, setPicker] = useState<Anchor | null>(null);
  const [switcher, setSwitcher] = useState<{ order: string[]; index: number } | null>(null);
  const [toast, setToast] = useState('');
  const [popouts, setPopouts] = useState<Window[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // dockview's events and the key handlers run outside React's render: they read the latest values here.
  const latest = useRef({ props, hidden, flyId, menu, picker, switcher });
  latest.current = { props, hidden, flyId, menu, picker, switcher };

  const dockRect = useCallback((): Rect => dockRef.current?.getBoundingClientRect() ?? NO_RECT, []);
  const showToast = useCallback((text: string) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(''), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /** Makes dockview's document panels match the open documents. */
  const syncDocuments = useCallback((dv: DockviewApi) => {
    const docs = latest.current.props.documents;
    const wanted = new Set(docs.map((d) => docPanelId(d.id)));
    for (const d of docs) if (!dv.getPanel(docPanelId(d.id))) addDocument(dv, memory, d.id, d.name);
    const stale = dv.panels.filter((p) => isDocPanelId(p.id) && !wanted.has(p.id));
    for (const p of stale) dv.removePanel(p);
    if (stale.length > 0 && !dv.panels.some((p) => isDocPanelId(p.id))) ensureDocumentArea(dv, memory);
  }, [memory]);

  const openFly = useCallback((id: ToolId) => {
    setFlyId(id);
    setFresh((f) => { const next = new Set(f); next.delete(id); return next; });
    mru.current = touch(mru.current, id);
  }, []);
  const closeFly = useCallback(() => setFlyId(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closePicker = useCallback(() => setPicker(null), []);

  const hide = useCallback((dv: DockviewApi, panel: Parameters<typeof autoHide>[2]) => {
    const ids = autoHide(dv, memory, panel, dockRect());
    if (ids.length > 0) setHidden((h) => [...h, ...ids.filter((id) => !h.includes(id))]);
  }, [memory, dockRect]);

  const pinBack = useCallback((id: ToolId) => {
    if (!api) return;
    setFlyId(null);
    const back = pinToolBack(api, memory, id);
    setHidden((h) => h.filter((x) => !back.includes(x)));
  }, [api, memory]);

  const toggleTool = useCallback((id: ToolId) => {
    if (!api) return;
    if (latest.current.hidden.includes(id)) {
      if (latest.current.flyId === id) closeFly(); else openFly(id);
      return;
    }
    const panel = api.getPanel(id);
    if (panel) api.removePanel(panel); else showTool(api, memory, id);
  }, [api, memory, openFly, closeFly]);

  const reset = useCallback((dv: DockviewApi) => {
    resetLayout(dv, memory, dockRect().right - dockRect().left || 1200);
    setHidden([]);
    setFlyId(null);
  }, [memory, dockRect]);

  /** Applies the saved layout; at startup, silently, and the default layout when there is none. */
  const apply = useCallback((dv: DockviewApi, atStartup: boolean): void => {
    const saved = readLayout(storage);
    if (!saved) {
      if (atStartup) reset(dv); else showToast('No saved layout yet — Window › Save window layout first');
      return;
    }
    applying.current = true;
    try {
      setHidden(applyLayout(dv, memory, saved));
      setFlyId(null);
      if (!atStartup) showToast('Saved window layout applied');
    } catch {
      reset(dv);
      showToast('The saved window layout could not be applied; the default layout is shown.');
    } finally {
      applying.current = false;
      syncDocuments(dv);
    }
  }, [storage, memory, reset, showToast, syncDocuments]);

  // the dock lives as long as the page, so these subscriptions are never disposed
  const onReady = useCallback((event: DockviewReadyEvent) => {
    const dv = event.api;
    dv.onDidActivePanelChange((e) => {
      const id = e.panel?.id;
      if (!id) return;
      mru.current = touch(mru.current, id);
      const documentId = documentIdOf(id);
      if (documentId !== null && !applying.current) latest.current.props.onActivateDocument(documentId);
    });
    dv.onDidRemovePanel((panel) => {
      const documentId = documentIdOf(panel.id);
      if (documentId !== null && !applying.current && latest.current.props.documents.some((d) => d.id === documentId)) {
        latest.current.props.onCloseDocument(documentId);
      }
    });
    dv.onWillShowOverlay((e) => {
      const data = e.getData();
      const dragged = !data ? [] : data.panelId !== null ? [data.panelId] : (dv.getGroup(data.groupId)?.panels.map((p) => p.id) ?? []);
      const target = e.group ? e.group.panels.map((p) => p.id) : null;
      const emptyArea = !!e.group && e.group.panels.length === 0 && e.group.id === memory.documentGroupId;
      if (!canDrop(dragged, e.kind, target, emptyArea)) e.preventDefault();
    });
    dv.onDidAddPopoutGroup((p) => setPopouts((ws) => (ws.includes(p.window) ? ws : [...ws, p.window])));
    dv.onDidRemovePopoutGroup((p) => setPopouts((ws) => ws.filter((w) => w !== p.window)));
    apply(dv, true);
    syncDocuments(dv);
    setApi(dv);
  }, [apply, memory, syncDocuments]);

  // the open documents decide which document panels exist
  useEffect(() => { if (api) syncDocuments(api); }, [api, documents, syncDocuments]);

  // a newly active document (opened, or the next one after a close) gets its tab focused
  useEffect(() => {
    if (!api || activeDocumentId === null) return;
    const panel = api.getPanel(docPanelId(activeDocumentId));
    if (panel && api.activePanel !== panel) panel.api.setActive();
  }, [api, activeDocumentId]);

  // a hidden Inspector's rail tab glows when what it shows changes
  const lastInspectorKey = useRef(inspectorKey);
  useEffect(() => {
    if (lastInspectorKey.current === inspectorKey) return;
    lastInspectorKey.current = inspectorKey;
    if (hidden.includes('inspector') && flyId !== 'inspector') setFresh((f) => new Set(f).add('inspector'));
  }, [inspectorKey, hidden, flyId]);

  const openPicker = useCallback((anchor: Anchor) => {
    setMenu(null);
    setPicker(anchor);
    latest.current.props.onPickerOpen?.();
  }, []);
  const fileAnchor = useCallback((): Anchor => {
    const file = stripRefs.current.File;
    return file ? anchorBelow(file) : { x: 8, y: 36, doc: document };
  }, []);

  const pick = useCallback((workflowId: string) => {
    const open = api?.getPanel(docPanelId(workflowId));
    if (open) open.api.setActive();
    latest.current.props.onOpenWorkflow(workflowId);
  }, [api]);

  const closePanel = useCallback((panelId: string) => {
    const documentId = documentIdOf(panelId);
    if (documentId !== null) { latest.current.props.onCloseDocument(documentId); return; }
    const panel = api?.getPanel(panelId);
    if (api && panel) api.removePanel(panel);
  }, [api]);

  const toggleMaximize = useCallback((group: DockviewGroupPanel) => {
    if (group.api.location.type !== 'grid') return;
    if (group.api.isMaximized()) group.api.exitMaximized(); else group.api.maximize();
  }, []);

  const windowMenu = useCallback((panelId: string, anchor: Anchor) => {
    const panel = api?.getPanel(panelId);
    if (!api || !panel) return;
    const group = panel.group;
    const docked = group.api.location.type === 'grid';
    const isDoc = isDocPanelId(panelId);
    const entries: MenuEntry[] = [
      docked
        ? { id: 'float', icon: '⧉', label: 'Float', kbd: 'Ctrl+dbl-click', onSelect: () => floatPanel(api, memory, panel, dockRect()) }
        : { id: 'dock', icon: '⤓', label: 'Dock', kbd: 'Ctrl+dbl-click', onSelect: () => dockBack(api, memory, group) },
    ];
    if (isDoc && docked) {
      entries.push({ id: 'max', icon: '▢', label: group.api.isMaximized() ? 'Restore' : 'Maximize', kbd: 'dbl-click', onSelect: () => toggleMaximize(group) });
    }
    if (!isDoc) {
      if (documentArea(api, memory, group)) {
        entries.push({ id: 'tabbed', icon: '▤', label: 'Dock as tabbed document', onSelect: () => dockAsDocument(api, memory, panel, dockRect()) });
      }
      entries.push({ id: 'autohide', icon: '⇥', label: 'Auto hide', onSelect: () => hide(api, panel) });
    }
    entries.push('separator', { id: 'close', icon: '×', label: isDoc ? 'Close document' : 'Close', kbd: isDoc ? 'Alt+W' : '', onSelect: () => closePanel(panelId) });
    setPicker(null);
    setMenu({ label: 'Window position', entries, anchor });
  }, [api, memory, dockRect, hide, closePanel, toggleMaximize]);

  const shell: ShellApi = useMemo(() => ({
    documentInfo: (id) => latest.current.props.documents.find((d) => d.id === id),
    renderDocument: (id, panel) => latest.current.props.renderDocument(id, panel),
    renderTool: (id) => latest.current.props.renderTool(id),
    closePanel,
    windowMenu,
    toggleFloat: (panelId) => {
      const panel = api?.getPanel(panelId);
      if (!api || !panel) return;
      if (panel.group.api.location.type === 'grid') floatPanel(api, memory, panel, dockRect());
      else dockBack(api, memory, panel.group);
    },
    toggleMaximize: (panelId) => { const panel = api?.getPanel(panelId); if (panel) toggleMaximize(panel.group); },
    openPicker,
    groupAction: (group, action: GroupAction, anchor) => {
      if (!api) return;
      switch (action) {
        case 'open': openPicker(anchor); break;
        case 'menu': if (group.activePanel) windowMenu(group.activePanel.id, anchor); break;
        case 'hide': if (group.activePanel) hide(api, group.activePanel); break;
        case 'float': floatGroup(api, memory, group, dockRect()); break;
        case 'popout': popOut(api, memory, group, dockRect()); break;
        case 'maximize': toggleMaximize(group); break;
        case 'dock': dockBack(api, memory, group); break;
      }
    },
  // documents and props are read through `latest`; re-create when the documents change so tabs re-render
  }), [api, memory, dockRect, closePanel, windowMenu, openPicker, hide, toggleMaximize, documents]);

  const stripEntries = (name: StripMenu): MenuEntry[] => {
    const activePanel = api?.activePanel;
    const docked = activePanel?.group.api.location.type === 'grid';
    switch (name) {
      case 'File':
        return [
          { id: 'open', icon: '⌂', label: 'Open workflow…', kbd: 'Ctrl+O', onSelect: () => openPicker(fileAnchor()) },
          'separator',
          { id: 'close', icon: '×', label: 'Close', kbd: 'Alt+W', disabled: activeDocumentId === null, onSelect: () => { if (activeDocumentId) props.onCloseDocument(activeDocumentId); } },
        ];
      case 'Edit':
        return [
          { id: 'undo', icon: '↶', label: 'Undo', kbd: 'Ctrl+Z', disabled: true, tip: NOT_YET, onSelect: () => {} },
          { id: 'redo', icon: '↷', label: 'Redo', kbd: 'Ctrl+Y', disabled: true, tip: NOT_YET, onSelect: () => {} },
          'separator',
          { id: 'all', icon: '⬚', label: 'Select all', kbd: 'Ctrl+A', disabled: true, tip: NOT_YET, onSelect: () => {} },
        ];
      case 'View':
        return TOOL_IDS.map((id) => ({
          id, icon: api?.getPanel(id) || hidden.includes(id) ? '✓' : '', label: TOOL_TITLES[id], onSelect: () => toggleTool(id),
        }));
      case 'Window':
        return [
          { id: 'float', icon: '⧉', label: 'Float', kbd: 'Ctrl+dbl-click', disabled: !activePanel || !docked, onSelect: () => { if (api && activePanel) floatPanel(api, memory, activePanel, dockRect()); } },
          { id: 'dock', icon: '⤓', label: 'Dock', kbd: 'Ctrl+dbl-click', disabled: !activePanel || docked, onSelect: () => { if (api && activePanel) dockBack(api, memory, activePanel.group); } },
          'separator',
          { id: 'switch', icon: '⇄', label: 'Switch window…', kbd: 'Ctrl+E', onSelect: () => advanceSwitcher(1) },
          'separator',
          { id: 'save', icon: '⤓', label: 'Save window layout', onSelect: () => {
            if (!api) return;
            showToast(writeLayout(storage, captureLayout(api, memory, hidden)) ? 'Window layout saved in this browser' : 'This browser would not store the layout');
          } },
          { id: 'apply', icon: '⤒', label: 'Apply saved layout', onSelect: () => { if (api) apply(api, false); } },
          { id: 'reset', icon: '↺', label: 'Reset window layout', onSelect: () => { if (api) { reset(api); syncDocuments(api); showToast('Window layout reset'); } } },
        ];
    }
  };

  const switcherEntries = (order: readonly string[]) => order.map((id) => {
    const documentId = documentIdOf(id);
    const info = documentId === null ? undefined : documents.find((d) => d.id === documentId);
    return info
      ? { id, label: info.name, document: true, hint: info.version }
      : { id, label: isToolId(id) ? TOOL_TITLES[id] : id, document: false, hint: isToolId(id) && hidden.includes(id) ? 'auto-hidden' : undefined };
  });

  function advanceSwitcher(step: 1 | -1) {
    const current = latest.current.switcher;
    if (current) {
      const n = current.order.length;
      setSwitcher({ order: current.order, index: (current.index + step + n) % n });
      return;
    }
    if (!api) return;
    const present = [...new Set([...api.panels.map((p) => p.id), ...latest.current.hidden])];
    const order = switcherOrder(mru.current, present);
    if (order.length === 0) return;
    setMenu(null);
    setPicker(null);
    setSwitcher({ order, index: (step + order.length) % order.length });
  }

  function finishSwitcher(target?: string) {
    const current = latest.current.switcher;
    if (!current) return;
    setSwitcher(null);
    const id = target ?? current.order[current.index];
    if (!id) return;
    if (isToolId(id) && latest.current.hidden.includes(id)) openFly(id);
    else api?.getPanel(id)?.api.setActive();
  }

  // the studio's keys, in the main window and in every pop-out window
  const keyHandlers = useRef({ down: (_e: KeyboardEvent) => {}, up: (_e: KeyboardEvent) => {} });
  keyHandlers.current.down = (e: KeyboardEvent) => {
    const now = latest.current;
    if (now.switcher) {
      if (e.key === 'ArrowDown') { e.preventDefault(); advanceSwitcher(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); advanceSwitcher(-1); return; }
      if (e.key === 'Enter') { e.preventDefault(); finishSwitcher(); return; }
    }
    const command = keyCommand(e);
    if (command === null || e.defaultPrevented) return;
    switch (command) {
      case 'switcher': case 'switcherBack':
        e.preventDefault(); advanceSwitcher(command === 'switcher' ? 1 : -1); break;
      case 'closeDocument':
        e.preventDefault(); if (now.props.activeDocumentId) now.props.onCloseDocument(now.props.activeDocumentId); break;
      case 'open':
        e.preventDefault(); openPicker(fileAnchor()); break;
      case 'start': case 'stop':
        e.preventDefault(); showToast('Start and Stop are not available yet.'); break;
      case 'escape':
        if (now.switcher) setSwitcher(null);
        else if (now.menu) setMenu(null);
        else if (now.picker) setPicker(null);
        else if (now.flyId) closeFly();
        else now.props.onEscape();
        break;
    }
  };
  keyHandlers.current.up = (e: KeyboardEvent) => { if (e.key === 'Control' || e.key === 'Meta') finishSwitcher(); };

  const windows = useMemo(() => [window, ...popouts], [popouts]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyHandlers.current.down(e);
    const up = (e: KeyboardEvent) => keyHandlers.current.up(e);
    for (const w of windows) { w.addEventListener('keydown', down); w.addEventListener('keyup', up); }
    return () => { for (const w of windows) { w.removeEventListener('keydown', down); w.removeEventListener('keyup', up); } };
  }, [windows]);

  return (
    <ShellProvider value={shell}>
      <div className="studio-shell">
        <div className="menubar" role="menubar" aria-label="Main menu">
          <div className="brand">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <defs><radialGradient id="brandSphere" cx="35%" cy="30%"><stop offset="0" stopColor="#7CCBF5" /><stop offset=".5" stopColor="#1B5594" /><stop offset="1" stopColor="#05142D" /></radialGradient></defs>
              <circle cx="8" cy="8" r="7" fill="url(#brandSphere)" stroke="rgba(125,211,252,.6)" />
            </svg>
            SKP Studio
          </div>
          <div className="menus">
            {STRIP.map((name) => (
              <button
                key={name}
                type="button"
                role="menuitem"
                ref={(el) => { stripRefs.current[name] = el; }}
                className={menu?.strip === name ? 'menu open' : 'menu'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (menu?.strip === name) { setMenu(null); return; }
                  setPicker(null);
                  setMenu({ label: name, entries: stripEntries(name), anchor: anchorBelow(e.currentTarget), strip: name });
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <div className="dockwrap">
          <div className="dock" ref={dockRef}>
            <DockviewReact
              components={COMPONENTS}
              tabComponents={TAB_COMPONENTS}
              defaultTabComponent={StudioTab}
              rightHeaderActionsComponent={GroupActions}
              watermarkComponent={Watermark}
              theme={themeVisualStudio}
              proportionalLayout={false}
              onReady={onReady}
            />
          </div>
          <AutoHide
            hidden={hidden}
            sideOf={(id) => toolSide(memory, id)}
            flyId={flyId}
            fresh={fresh}
            onOpen={openFly}
            onClose={closeFly}
            onPin={pinBack}
            renderTool={(id) => props.renderTool(id)}
          />
        </div>
      </div>
      {menu && <Menu label={menu.label} entries={menu.entries} anchor={menu.anchor} onClose={closeMenu} />}
      {picker && (
        <Picker
          anchor={picker}
          items={workflows}
          note={props.pickerNote}
          onPick={pick}
          onClose={closePicker}
        />
      )}
      {switcher && <Switcher entries={switcherEntries(switcher.order)} selected={switcher.order[switcher.index] ?? null} onPick={finishSwitcher} />}
      <div className={toast ? 'toast on' : 'toast'} role="status" aria-live="polite">{toast}</div>
      <Tooltips windows={windows} />
      {props.popoutContent !== undefined && popouts.map((w) => createPortal(props.popoutContent, w.document.body, windowKey(w)))}
    </ShellProvider>
  );
}
```

- [ ] **Step 5: Run the tests and the typecheck** (PowerShell)

```powershell
npx vitest run src/dock
npm run typecheck
```

Expected: 6 test files, 64 tests passed, with no React warning in the output; typecheck prints nothing.

- [ ] **Step 6: Commit** (from the repository root)

```bash
git add src/WorkflowStudio/src/dock/parts.tsx src/WorkflowStudio/src/dock/DockShell.tsx src/WorkflowStudio/src/dock/DockShell.test.tsx
git commit -m "feat(studio): the dock shell on dockview: documents, panes, menus, keys and layouts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `panels/`: a read-only Inspector, Problems, Output and Toolbox

**Files:**
- Create: `src/panels/inspectorView.ts`, `src/panels/Inspector.tsx`, `src/panels/Problems.tsx`, `src/panels/PaneNote.tsx`, `src/panels/panels.css`, `src/app/fixtures.ts` (tests only)
- Test: `src/panels/inspectorView.test.ts`, `src/panels/panes.test.tsx`

**Interfaces:**
- Consumes: the store (Task 3), `problemTarget` (Task 3), the model fields (Task 2), `entityName` (`model/entityNames.ts`), `conditionInfo` (`model/entryConditions.ts`).
- Produces:
  - `inspectorView.ts`: `interface Row { label; value; dot?; empty? }`; `interface InspectorView { kind; uniqueName; title; head; details; fields; note?; slots? }`; `formatInstant(iso)`; `inspectorView(doc, selection): InspectorView | null`.
  - `Inspector()`, `Problems()`, `Output()`, `Toolbox()`, `PaneNote({ pane, children })`; every pane body carries `data-pane="inspector" | "problems" | "output" | "toolbox"`.
  - `app/fixtures.ts`: `loadedDocument(graph?, problems?, parked?)`, a `StudioDocument` loaded through the real loader (tests only).

The Inspector follows the active document's selection wherever the pane is (docked, floating, popped out or in the auto-hide flyout). At the top it shows the entity's unique name (`entityName(name, version, id)`), then Name and Version, then **▸ show all** / **▾ hide details** (Id, Created at/by, Updated at/by; one switch in the store, so it stays as the operator left it), then the entity's fields: Workflow: Description, Cron; Step: Description, Entry condition, Processor (unique name); Processor: Description, Source hash, Instance id, and a Schemas section with In, Out and Config by unique name or ∅; Cache: Description, Root, Items. AssignmentIds are never shown. Every read-only value is one line cut with an ellipsis, carrying `data-tipcut` with its full text, so the tooltip shows only when something was cut (spec §7). Values and layout are the mockup's (`.sec`, `.field`, `.ro`, `.metatog`, `.meta`, `.slot`, `.kindpill`, `.prob`).

- [ ] **Step 1: Write the failing tests**

`src/app/fixtures.ts`:

```ts
import type { StudioApi } from '../api/client';
import { graphDto } from '../api/fixtures';
import type { StepReadDto, WorkflowGraphDto, WorkflowProblemDto } from '../api/types';
import type { StudioDocument } from './document';
import { loadDocument } from './loadDocument';

const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

/**
 * Tests only: a document loaded through the real loader from a graph DTO. `problems` null means
 * validate failed; `parked` are the steps GET /steps/{id} returns (list their ids in the layout).
 */
export async function loadedDocument(
  graph: WorkflowGraphDto = graphDto(), problems: WorkflowProblemDto[] | null = [], parked: StepReadDto[] = [],
): Promise<StudioDocument> {
  const api = {
    getGraph: async () => ({ ok: true, value: graph }),
    validate: async () => (problems === null
      ? { ok: false, error: { kind: 'network', message: 'down' } }
      : { ok: true, value: { valid: problems.length === 0, problems } }),
    getStep: async (id: string) => {
      const step = parked.find((s) => s.id === id);
      return step ? { ok: true, value: step } : notFound;
    },
    getProcessor: async () => notFound,
    getSchema: async () => notFound,
  } as unknown as StudioApi;
  const result = await loadDocument(api, graph.workflow?.id ?? 'wf1');
  if (!result.ok) throw new Error(`fixture failed to load: ${JSON.stringify(result.error)}`);
  return result.value;
}
```

`src/panels/inspectorView.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cacheDto, graphDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { formatInstant, inspectorView } from './inspectorView';

const W = '11111111-2222-3333-4444-555566667777';
const S = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
const P = '99999999-8888-7777-6666-555544443333';
const IN = '12345678-1234-1234-abcd-0000000000aa';

const graph = graphDto({
  workflow: workflowDto({ id: W, name: 'orders', version: '1.2.0', description: 'nightly', cronExpression: '0 * * * * *', entryStepIds: [S], assignmentIds: ['never-shown'] }),
  steps: [stepDto(S, { name: 'fetch', version: '2.0.0', processorId: P, entryCondition: 2, description: null })],
  processors: [processorDto(P, { name: 'file-fetcher', version: '1.0.0', sourceHash: 'f'.repeat(64), instanceId: null, inputSchemaId: IN, outputSchemaId: 'unloaded-id' })],
  schemas: [schemaDto(IN, { name: 'file-locator', version: '1.0.0' })],
  caches: [cacheDto('c1', { name: 'lookups', version: '3.0.0', root: 'lk', items: '{"a":"b"}' })],
} as never);

describe('inspectorView', () => {
  it('shows a workflow: unique name, name, version, details, description and cron, never its assignments', async () => {
    const view = inspectorView(await loadedDocument(graph), { kind: 'workflow' })!;
    expect(view.kind).toBe('WORKFLOW');
    expect(view.uniqueName).toBe('orders_1.2.0-4444-555566667777');
    expect(view.head.map((r) => [r.label, r.value])).toEqual([['Name', 'orders'], ['Version', '1.2.0']]);
    expect(view.fields.map((r) => [r.label, r.value])).toEqual([['Description', 'nightly'], ['Cron', '0 * * * * *']]);
    expect(view.details.map((r) => r.label)).toEqual(['Id', 'Created at', 'Created by', 'Updated at', 'Updated by']);
    expect(view.details[0]!.value).toBe(W);
    expect(JSON.stringify(view)).not.toContain('never-shown');
  });

  it('shows a step with its entry condition and its processor by unique name', async () => {
    const view = inspectorView(await loadedDocument(graph), { kind: 'step', stepId: S })!;
    expect(view.kind).toBe('STEP');
    expect(view.uniqueName).toBe('fetch_2.0.0-dddd-eeeeffff0000');
    expect(view.fields).toEqual([
      { label: 'Description', value: '—' },
      { label: 'Entry condition', value: 'F · Failed', dot: '#FF7A66' },
      { label: 'Processor', value: 'file-fetcher_1.0.0-6666-555544443333' },
    ]);
    expect(view.note).toBeUndefined();
  });

  it('marks a parked step', async () => {
    const parked = graphDto({ ...graph, layout: { parked: ['pk'] } } as never);
    const doc = await loadedDocument(parked, [], [stepDto('pk', { name: 'spare', processorId: P })]);
    const view = inspectorView(doc, { kind: 'step', stepId: 'pk' })!;
    expect(view.kind).toBe('STEP · PARKED');
    expect(view.note).toMatch(/Parked/);
  });

  it('shows a processor with source hash, instance id and the three schema slots', async () => {
    const view = inspectorView(await loadedDocument(graph), { kind: 'processor', processorId: P, stepId: S })!;
    expect(view.fields.map((r) => [r.label, r.value])).toEqual([['Description', '—'], ['Source hash', 'f'.repeat(64)], ['Instance id', '—']]);
    expect(view.slots).toEqual([
      { label: 'In', value: 'file-locator_1.0.0-abcd-0000000000aa' },
      { label: 'Out', value: 'unloaded-id' },
      { label: 'Config', value: '∅', empty: true },
    ]);
  });

  it('shows a cache with root and items', async () => {
    const view = inspectorView(await loadedDocument(graph), { kind: 'cache', cacheId: 'c1' })!;
    expect(view.fields.map((r) => [r.label, r.value])).toEqual([['Description', '—'], ['Root', 'lk'], ['Items', '{"a":"b"}']]);
  });

  it('shows nothing for no selection, or one this document does not hold', async () => {
    const doc = await loadedDocument(graph);
    expect(inspectorView(doc, null)).toBeNull();
    expect(inspectorView(doc, { kind: 'step', stepId: 'gone' })).toBeNull();
    expect(inspectorView(doc, { kind: 'cache', cacheId: 'gone' })).toBeNull();
  });
});

describe('formatInstant', () => {
  it('reads a UTC instant, milliseconds kept, and leaves anything else alone', () => {
    expect(formatInstant('2026-10-05T12:00:00.123456Z')).toBe('2026-10-05 12:00:00.123 UTC');
    expect(formatInstant('2026-10-05T12:00:00Z')).toBe('2026-10-05 12:00:00 UTC');
    expect(formatInstant('yesterday')).toBe('yesterday');
    expect(formatInstant('')).toBe('—');
  });
});
```

`src/panels/panes.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { graphDto, processorDto, stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { createStudioStore, StudioStoreProvider, type StudioStore } from '../store/studioStore';
import { Inspector } from './Inspector';
import { Output, Toolbox } from './PaneNote';
import { Problems } from './Problems';

const graph = graphDto({
  steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1' }), stepDto('s2', { name: 'store', processorId: 'p1' })],
  processors: [processorDto('p1', { name: 'fetcher' })],
} as never);

async function storeWith(problems: Parameters<typeof loadedDocument>[1] = []): Promise<StudioStore> {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph, problems) });
  return store;
}
const wrap = (store: StudioStore, ui: ReactNode) => render(<StudioStoreProvider value={store}>{ui}</StudioStoreProvider>);

describe('Inspector', () => {
  it('asks for a workflow, then for a selection', async () => {
    const empty = createStudioStore();
    const { unmount } = wrap(empty, <Inspector />);
    expect(screen.getByText('Open a workflow to inspect it.')).toBeInTheDocument();
    unmount();

    wrap(await storeWith(), <Inspector />);
    expect(screen.getByText(/Nothing selected/)).toBeInTheDocument();
  });

  it('fills when something is selected, and keeps one show-all switch across entities', async () => {
    const store = await storeWith();
    wrap(store, <Inspector />);
    act(() => store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } }));
    expect(screen.getByText('STEP')).toBeInTheDocument();
    expect(screen.getByLabelText('Unique name')).toHaveTextContent('fetch_1.0.0-s1');
    expect(screen.queryByText('Created at')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '▸ show all' }));
    expect(screen.getByText('Created at')).toBeInTheDocument();

    act(() => store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'workflow' } }));
    expect(screen.getByText('WORKFLOW')).toBeInTheDocument();
    expect(screen.getByText('Created at')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▾ hide details' })).toBeInTheDocument();
  });

  it('marks every read-only value so its full text shows when it is cut', async () => {
    const store = await storeWith();
    store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'processor', processorId: 'p1', stepId: 's1' } });
    const { container } = wrap(store, <Inspector />);
    const values = [...container.querySelectorAll('.ro, .slot .v')];
    expect(values.length).toBeGreaterThan(5);
    for (const v of values) expect(v.getAttribute('data-tipcut')).toBe(v.textContent);
  });
});

describe('Problems', () => {
  it('says when validate failed, and when there are none', async () => {
    const { unmount } = wrap(await storeWith(null), <Problems />);
    expect(screen.getByText('Problems unavailable.')).toBeInTheDocument();
    unmount();
    wrap(await storeWith([]), <Problems />);
    expect(screen.getByText('No problems')).toBeInTheDocument();
  });

  it('lists gate, title and detail, and selects what a problem names when clicked', async () => {
    const store = await storeWith([
      { gate: 'schemaEdge', title: 'Schema-edge mismatch between steps', detail: "on edge 's1' -> 's2'", offending: { parentStepId: 's1', childStepId: 's2' } },
      { gate: 'somethingNew', title: 'A gate this studio does not know', detail: 'd', offending: 42 },
    ]);
    wrap(store, <Problems />);
    const [named, unnamed] = screen.getAllByRole('listitem');
    expect(named).toHaveTextContent('schemaEdgeSchema-edge mismatch between steps');

    fireEvent.click(unnamed!);
    expect(store.getState().docs[0]!.selection).toBeNull();
    fireEvent.click(named!);
    expect(store.getState().docs[0]!.selection).toEqual({ kind: 'step', stepId: 's2' });
  });
});

describe('Output and Toolbox', () => {
  it('are real panes with one line each', () => {
    render(<><Output /><Toolbox /></>);
    expect(screen.getByText('Output will show save and orchestration messages in a later version.')).toBeInTheDocument();
    expect(screen.getByText('The toolbox arrives in a later version.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/panels`
Expected: FAIL, `./inspectorView`, `./Inspector`, `./PaneNote` and `./Problems` cannot be resolved.

- [ ] **Step 3: Implement the view and the panes**

`src/panels/inspectorView.ts`:

```ts
import type { StudioDocument } from '../app/document';
import { entityName } from '../model/entityNames';
import { conditionInfo } from '../model/entryConditions';
import type { Audit, Graph, Id } from '../model/graph';
import type { Selection } from '../store/selection';

/** One read-only line of the Inspector. `value` is always text: an absent value reads "—". */
export interface Row {
  label: string;
  value: string;
  /** The entry condition's colour, drawn as a dot before the value. */
  dot?: string;
  /** An empty schema slot, drawn faint. */
  empty?: boolean;
}

/**
 * What the Inspector shows for a selection (slice 3a, read-only; spec §7): the kind pill, the
 * unique entity name, name and version, the base-entity details behind "▸ show all", then the
 * entity's own fields. AssignmentIds are never shown.
 */
export interface InspectorView {
  kind: string;
  uniqueName: string;
  title: string;
  head: Row[];
  details: Row[];
  fields: Row[];
  note?: string;
  /** A second section: the processor's three schema slots. */
  slots?: Row[];
}

const NONE = '—';
const text = (value: string | null | undefined): string => (value === null || value === undefined || value === '' ? NONE : value);

/** `2026-10-05T12:00:00.123456Z` → `2026-10-05 12:00:00.123 UTC`; anything else is shown as it came. */
export function formatInstant(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(iso);
  if (!m) return text(iso);
  return `${m[1]} ${m[2]}${m[3] ? m[3].slice(0, 4) : ''} UTC`;
}

function details(id: Id, audit: Audit): Row[] {
  return [
    { label: 'Id', value: id },
    { label: 'Created at', value: formatInstant(audit.createdAt) },
    { label: 'Created by', value: text(audit.createdBy) },
    { label: 'Updated at', value: formatInstant(audit.updatedAt) },
    { label: 'Updated by', value: text(audit.updatedBy) },
  ];
}

function schemaSlot(graph: Graph, label: string, id: Id | null): Row {
  if (!id) return { label, value: '∅', empty: true };
  const schema = graph.schemas.get(id);
  return { label, value: schema ? entityName(schema.name, schema.version, schema.id) : id };
}

/** The view for a selection, or null when nothing (or nothing this document holds) is selected. */
export function inspectorView(doc: StudioDocument, selection: Selection | null): InspectorView | null {
  if (selection === null) return null;
  const { graph } = doc;
  switch (selection.kind) {
    case 'workflow': {
      const w = graph.workflow;
      return {
        kind: 'WORKFLOW', uniqueName: entityName(w.name, w.version, w.id), title: 'Workflow',
        head: [{ label: 'Name', value: text(w.name) }, { label: 'Version', value: text(w.version) }],
        details: details(w.id, w.audit),
        fields: [{ label: 'Description', value: text(w.description) }, { label: 'Cron', value: text(w.cronExpression) }],
      };
    }
    case 'step': {
      const s = graph.steps.get(selection.stepId);
      if (!s) return null;
      const parked = doc.parkedIds.includes(s.id);
      const p = graph.processors.get(s.processorId);
      const condition = conditionInfo(s.entryCondition);
      return {
        kind: parked ? 'STEP · PARKED' : 'STEP', uniqueName: entityName(s.name, s.version, s.id), title: 'Step',
        head: [{ label: 'Name', value: text(s.name) }, { label: 'Version', value: text(s.version) }],
        details: details(s.id, s.audit),
        fields: [
          { label: 'Description', value: text(s.description) },
          { label: 'Entry condition', value: `${condition.letter} · ${condition.name}`, dot: condition.colour },
          { label: 'Processor', value: p ? entityName(p.name, p.version, p.id) : `${text(s.processorId)} (not loaded)` },
        ],
        note: parked ? '⚠ Parked: not connected, so not part of this workflow.' : undefined,
      };
    }
    case 'processor': {
      const p = graph.processors.get(selection.processorId);
      if (!p) return null;
      return {
        kind: 'PROCESSOR', uniqueName: entityName(p.name, p.version, p.id), title: 'Processor',
        head: [{ label: 'Name', value: text(p.name) }, { label: 'Version', value: text(p.version) }],
        details: details(p.id, p.audit),
        fields: [
          { label: 'Description', value: text(p.description) },
          { label: 'Source hash', value: text(p.sourceHash) },
          { label: 'Instance id', value: text(p.instanceId) },
        ],
        slots: [schemaSlot(graph, 'In', p.inputSchemaId), schemaSlot(graph, 'Out', p.outputSchemaId), schemaSlot(graph, 'Config', p.configSchemaId)],
      };
    }
    case 'cache': {
      const c = graph.caches.get(selection.cacheId);
      if (!c) return null;
      return {
        kind: 'CACHE', uniqueName: entityName(c.name, c.version, c.id), title: 'Cache',
        head: [{ label: 'Name', value: text(c.name) }, { label: 'Version', value: text(c.version) }],
        details: details(c.id, c.audit),
        fields: [
          { label: 'Description', value: text(c.description) },
          { label: 'Root', value: text(c.root) },
          { label: 'Items', value: text(c.items) },
        ],
      };
    }
  }
}
```

`src/panels/PaneNote.tsx`:

```tsx
import type { ReactNode } from 'react';

/**
 * A pane with one line of text: empty states, and the Output and Toolbox notes of slice 3a.
 * `pane` names the pane it belongs to (data-pane), so tests and styles can find it.
 */
export function PaneNote({ pane, children }: { pane: string; children: ReactNode }) {
  return (
    <div className="paneBody" data-pane={pane}>
      <div className="pbody"><div className="note pane-note">{children}</div></div>
    </div>
  );
}

/** Output, a real pane with nothing to show yet (spec §10, slice 3a). */
export function Output() {
  return <PaneNote pane="output">Output will show save and orchestration messages in a later version.</PaneNote>;
}

/** Toolbox, a real pane with nothing to show yet (spec §10, slice 3a). */
export function Toolbox() {
  return <PaneNote pane="toolbox">The toolbox arrives in a later version.</PaneNote>;
}
```

`src/panels/Inspector.tsx`:

```tsx
import { activeDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { inspectorView, type Row } from './inspectorView';
import { PaneNote } from './PaneNote';

/** Read-only text: one line, cut with an ellipsis, its full text a tooltip only when cut (spec §7). */
function Value({ row }: { row: Row }) {
  return (
    <span className={row.empty ? 'ro null' : 'ro'} data-tipcut={row.value}>
      {row.dot && <span className="dot" style={{ background: row.dot }} />}
      {row.value}
    </span>
  );
}

const field = (row: Row) => (
  <div key={row.label} className="field"><label>{row.label}</label><Value row={row} /></div>
);

/**
 * The shared Inspector, read-only in slice 3a (spec §7; editing is 3b). It follows the active
 * document's selection, whether the pane is docked, floating, popped out or auto-hidden.
 */
export function Inspector() {
  const active = useStudio(activeDocument);
  const showDetails = useStudio((s) => s.showDetails);
  const store = useStudioStore();

  if (active === null) return <PaneNote pane="inspector">Open a workflow to inspect it.</PaneNote>;
  if (active.status.kind === 'loading') return <PaneNote pane="inspector">Loading…</PaneNote>;
  if (active.status.kind === 'failed') return <PaneNote pane="inspector">{active.status.message}</PaneNote>;
  const view = inspectorView(active.status.doc, active.selection);
  if (view === null) return <PaneNote pane="inspector">Nothing selected. Click a step, a processor, a cache or the workflow.</PaneNote>;

  return (
    <div className="paneBody" data-pane="inspector">
      <div className="ph2"><span className="kindpill">{view.kind}</span></div>
      <div className="pbody">
        <div className="sec">
          <div className="uname" aria-label="Unique name"><span className="ro" data-tipcut={view.uniqueName}>{view.uniqueName}</span></div>
          <div className="sec-title">{view.title}</div>
          {view.head.map(field)}
          <div className="metatog">
            <button type="button" className="link" onClick={() => store.dispatch({ type: 'toggleDetails' })}>
              {showDetails ? '▾ hide details' : '▸ show all'}
            </button>
          </div>
          {showDetails && <div className="meta">{view.details.map(field)}</div>}
          {view.fields.map(field)}
          {view.note && <div className="note warn">{view.note}</div>}
        </div>
        {view.slots && (
          <div className="sec">
            <div className="sec-title">Schemas</div>
            {view.slots.map((slot) => (
              <div key={slot.label} className="slot">
                <span className="k">{slot.label}</span>
                <span className={slot.empty ? 'v null' : 'v'} data-tipcut={slot.value}>{slot.value}</span>
                <span />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

`src/panels/Problems.tsx`:

```tsx
import { problemTarget } from '../store/problemTarget';
import { activeDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { PaneNote } from './PaneNote';

/**
 * Problems (spec §7.3, slice 3a): the active document's validate result, gate, title and detail.
 * A problem that names an entity of this document selects it when clicked; the Inspector follows.
 */
export function Problems() {
  const active = useStudio(activeDocument);
  const store = useStudioStore();

  if (active === null) return <PaneNote pane="problems">Open a workflow to see its problems.</PaneNote>;
  if (active.status.kind === 'loading') return <PaneNote pane="problems">Loading…</PaneNote>;
  if (active.status.kind === 'failed') return <PaneNote pane="problems">Problems unavailable.</PaneNote>;
  const { doc } = active.status;
  if (doc.problems === null) return <PaneNote pane="problems">Problems unavailable.</PaneNote>;
  if (doc.problems.length === 0) return <PaneNote pane="problems">No problems</PaneNote>;

  return (
    <div className="paneBody" data-pane="problems">
      <div className="pbody" role="list" aria-label="Problems">
        {doc.problems.map((problem, i) => {
          const target = problemTarget(problem, doc.graph);
          const select = target === null ? undefined
            : () => store.dispatch({ type: 'select', workflowId: active.workflowId, selection: target });
          return (
            <div
              key={i}
              role="listitem"
              className={target === null ? 'prob static' : 'prob'}
              onClick={select}
              data-tip={target === null ? undefined : 'Select it'}
            >
              <span className="gate">{problem.gate}</span>
              <b>{problem.title}</b>
              <div className="pd">{problem.detail}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

`src/panels/panels.css`:

```css
/* Tool pane bodies (mockup v49: .paneBody, the inspector rules, .prob). */
.paneBody { height: 100%; display: flex; flex-direction: column; background: var(--panel); min-height: 0; font-family: var(--sans); color: var(--ink); }
.ph2 { padding: 10px 16px 0; min-height: 10px; }
.pbody { flex: 1; overflow: auto; min-height: 0; scrollbar-width: thin; scrollbar-color: var(--line-2) transparent; }
.kindpill { font-size: 10px; letter-spacing: .1em; padding: 2px 6px; border-radius: 3px; background: var(--panel-2); border: 1px solid var(--line-2); color: var(--accent); }

/* inspector */
.sec { padding: 4px 16px 14px; border-bottom: 1px solid var(--line); }
.sec-title { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 12px 0 8px; display: flex; justify-content: space-between; align-items: center; }
.uname { margin: 10px 0 0; font-family: var(--mono); font-size: 12.5px; }
.uname .ro { color: var(--ink); font-size: 12.5px; }
.field { display: grid; grid-template-columns: 96px minmax(0, 1fr); align-items: center; gap: 8px; margin: 6px 0; font-size: 13px; }
.field label { color: var(--muted); }
.ro { font-family: var(--mono); font-size: 12px; color: var(--muted); display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ro.null { color: var(--faint); }
.ro .dot { display: inline-block; vertical-align: middle; margin-right: 6px; }
.metatog { margin: 2px 0 4px 104px; }
.meta { margin: 4px 0 2px; padding: 4px 0 2px; border-top: 1px dashed var(--line); }
.meta .field { margin: 4px 0; font-size: 12px; }
.dot { width: 9px; height: 9px; border-radius: 50%; }
.slot { display: grid; grid-template-columns: 52px 1fr auto; gap: 8px; align-items: center; margin: 6px 0; font-size: 12.5px; }
.slot .k { color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.slot .v { font-family: var(--mono); font-size: 12px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.slot .v.null { color: var(--faint); }
.link { font-size: 11.5px; color: var(--accent); cursor: pointer; background: none; border: 0; padding: 0; font-family: var(--sans); }
.note { font-size: 11.5px; color: var(--faint); line-height: 1.5; margin-top: 8px; }
.note.warn { color: var(--x); }
.pane-note { padding: 8px 12px; margin: 0; font-size: 12.5px; }

/* problems */
.prob { padding: 7px 12px; border-bottom: 1px solid var(--line); font-size: 12.5px; color: var(--muted); cursor: pointer; }
.prob:hover { background: rgba(125, 211, 252, .06); }
.prob.static { cursor: default; }
.prob.static:hover { background: none; }
.prob b { color: var(--ink); font-weight: 500; }
.prob .gate { font-family: var(--mono); font-size: 10.5px; padding: 1px 6px; margin-right: 8px; border: 1px solid var(--line-2); border-radius: 999px; color: var(--muted); background: var(--panel-2); }
.prob .pd { margin-top: 3px; font-family: var(--mono); font-size: 11.5px; color: var(--muted); white-space: pre-wrap; word-break: break-word; }
```

- [ ] **Step 4: Run the tests and the typecheck** (PowerShell)

```powershell
npx vitest run src/panels
npm run typecheck
```

Expected: 2 test files, 13 tests passed; typecheck prints nothing.

- [ ] **Step 5: Commit** (from the repository root)

```bash
git add src/WorkflowStudio/src/panels src/WorkflowStudio/src/app/fixtures.ts
git commit -m "feat(studio): read-only Inspector with show all, Problems from validate, Output and Toolbox panes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The document panel: canvas, capsule toolbar and live status

**Files:**
- Create: `src/api/liveStatus.ts`, `src/app/panelHooks.ts`, `src/app/CapsuleToolbar.tsx`, `src/app/DocumentPanel.tsx`, `src/app/document.css`
- Test: `src/api/liveStatus.test.ts`, `src/app/DocumentPanel.test.tsx`

**Interfaces:**
- Consumes: `StudioApi.listLive` (Task 2), the store (Task 3), `WorkflowCanvas`, `useFitter`, `ZoomControls` (Task 4), `DockviewPanelApi` (type only, from `dockview-react`).
- Produces:
  - `liveStatus.ts`: `type LiveStatus = 'checking' | 'running' | 'stopped' | 'unknown'`; `liveStatusOf(result, workflowId)`.
  - `panelHooks.ts`: `type PanelLike` (the four members of a dockview panel api the hooks use); `useOwnerDocument(panel)`; `usePanelVisible(panel, doc)`; `LIVE_POLL_MS = 5000`; `useLiveStatus(api, workflowId, visible)`.
  - `CapsuleToolbar({ workflow, status })`; `DocumentPanel({ api, workflowId, panel })`.

The capsule toolbar is the mockup's `.docbar`: the name and `_version` (its tooltip the unique name), `⏱ cron` or "not scheduled", the status pill (`▶ running`, `■ stopped`, `status unknown`, `checking…`), then Save, Start and Stop, disabled (Save: "Nothing to save yet"; Start and Stop: "Not available yet"; a disabled button takes no pointer events so its wrapper's tooltip shows), then the document's own zoom and Fit. The status polls `GET /orchestration/live` every 5 s only while the tab is visible (the panel is the visible tab of its group and its window is not hidden). A click on the canvas activates this document before selecting, so the Inspector follows the document you click in.

- [ ] **Step 1: Write the failing tests**

`src/api/liveStatus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { liveStatusOf } from './liveStatus';

const W = '1A56B3CA-E276-4815-87FA-5C2F48AB6DAD';
const ok = (value: unknown) => ({ ok: true as const, value });

describe('liveStatusOf (review focus 3: a failing or odd live poll)', () => {
  it('is running when the live set holds the id, whatever its case', () => {
    expect(liveStatusOf(ok(['1a56b3ca-e276-4815-87fa-5c2f48ab6dad']), W)).toBe('running');
  });

  it('is stopped when the set does not hold it', () => {
    expect(liveStatusOf(ok([]), W)).toBe('stopped');
    expect(liveStatusOf(ok(['4cd8af45-1295-43db-ab2e-e955dd82b5c5']), W)).toBe('stopped');
  });

  it('skips entries that are not strings or not GUIDs, and still finds the id', () => {
    expect(liveStatusOf(ok([null, 7, { id: W }, 'not-a-guid', W]), W)).toBe('running');
    expect(liveStatusOf(ok([null, 7, 'not-a-guid']), W)).toBe('stopped');
  });

  it('is unknown when the poll fails or the body is not a list, never stopped', () => {
    expect(liveStatusOf({ ok: false, error: { kind: 'http', status: 500, detail: 'Redis down' } }, W)).toBe('unknown');
    expect(liveStatusOf({ ok: false, error: { kind: 'network', message: 'Failed to fetch' } }, W)).toBe('unknown');
    expect(liveStatusOf(ok({ live: [W] }), W)).toBe('unknown');
    expect(liveStatusOf(ok(null), W)).toBe('unknown');
  });
});
```

`src/app/DocumentPanel.test.tsx`:

```tsx
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, stepDto, workflowDto } from '../api/fixtures';
import { createStudioStore, StudioStoreProvider } from '../store/studioStore';
import { DocumentPanel } from './DocumentPanel';
import { loadedDocument } from './fixtures';
import { LIVE_POLL_MS, useLiveStatus, useOwnerDocument, type PanelLike } from './panelHooks';

/** A stand-in for a dockview panel api: visible or not, in a given window, with events we fire. */
function fakePanel(visible = true, win: Window = window) {
  const location = new Set<() => void>(), visibility = new Set<(e: { isVisible: boolean }) => void>();
  let current = win;
  const panel = {
    getWindow: () => current,
    get isVisible() { return visible; },
    onDidLocationChange: (f: () => void) => { location.add(f); return { dispose: () => location.delete(f) }; },
    onDidVisibilityChange: (f: (e: { isVisible: boolean }) => void) => { visibility.add(f); return { dispose: () => visibility.delete(f) }; },
  } as unknown as PanelLike;
  return {
    panel,
    moveTo: (w: Window) => { current = w; location.forEach((f) => f()); },
    show: (v: boolean) => { visible = v; visibility.forEach((f) => f({ isVisible: v })); },
  };
}

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('useLiveStatus', () => {
  it('polls every 5 s while visible, and not at all while hidden', async () => {
    vi.useFakeTimers();
    const listLive = vi.fn().mockResolvedValue({ ok: true, value: ['wf1'] });
    const api = { listLive } as unknown as StudioApi;
    const { result, rerender } = renderHook(({ visible }) => useLiveStatus(api, 'wf1', visible), { initialProps: { visible: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLive).not.toHaveBeenCalled();
    expect(result.current).toBe('checking');

    rerender({ visible: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current).toBe('running');
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * LIVE_POLL_MS); });
    expect(listLive).toHaveBeenCalledTimes(3);

    rerender({ visible: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * LIVE_POLL_MS); });
    expect(listLive).toHaveBeenCalledTimes(3);
  });

  it('says status unknown when the poll fails, even by throwing', async () => {
    const api = { listLive: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as StudioApi;
    const { result } = renderHook(() => useLiveStatus(api, 'wf1', true));
    await waitFor(() => expect(result.current).toBe('unknown'));
  });
});

describe('useOwnerDocument', () => {
  it('follows the panel into a pop-out window', () => {
    const fake = fakePanel();
    const { result } = renderHook(() => useOwnerDocument(fake.panel));
    expect(result.current).toBe(document);
    const popout = document.implementation.createHTMLDocument('popout');
    act(() => fake.moveTo({ document: popout } as unknown as Window));
    expect(result.current).toBe(popout);
  });
});

describe('DocumentPanel', () => {
  async function setup(listLive = vi.fn().mockResolvedValue({ ok: true, value: [] })) {
    const store = createStudioStore();
    store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    const fake = fakePanel();
    const api = { listLive } as unknown as StudioApi;
    render(<StudioStoreProvider value={store}><div style={{ width: 1200, height: 800 }}><DocumentPanel api={api} workflowId="wf1" panel={fake.panel} /></div></StudioStoreProvider>);
    return { store, fake, listLive };
  }

  it('shows Loading…, then the canvas with its toolbar and status', async () => {
    const { store } = await setup(vi.fn().mockResolvedValue({ ok: true, value: ['wf1'] }));
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    const doc = await loadedDocument(graphDto({ workflow: workflowDto({ cronExpression: '0 * * * * *' }), steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));

    expect(await screen.findByText('fetch')).toBeInTheDocument();
    expect(screen.getByText('⏱ 0 * * * * *')).toBeInTheDocument();
    expect(await screen.findByText('▶ running')).toBeInTheDocument();
    for (const name of ['⤓ Save', '▶ Start', '■ Stop']) expect(screen.getByRole('button', { name })).toBeDisabled();
    expect(screen.getByRole('button', { name: '▶ Start' }).parentElement).toHaveAttribute('data-tip', 'Not available yet');
  });

  it('shows why a document could not be opened (review focus 2: a workflow deleted since the list was read)', async () => {
    const { store } = await setup();
    act(() => store.dispatch({ type: 'failed', workflowId: 'wf1', message: 'This workflow no longer exists.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('This workflow no longer exists.');
  });

  it('selects what is clicked and activates this document', async () => {
    const { store } = await setup();
    act(() => store.dispatch({ type: 'open', workflowId: 'other', name: 'x', version: '1' }));
    const doc = await loadedDocument(graphDto({ steps: [stepDto('s1', { name: 'fetch' })] }));
    act(() => store.dispatch({ type: 'loaded', workflowId: 'wf1', doc }));

    fireEvent.click((await screen.findByText('fetch')).closest('.react-flow__node')!);

    expect(store.getState().activeId).toBe('wf1');
    expect(store.getState().docs[0]!.selection).toEqual({ kind: 'step', stepId: 's1' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/api/liveStatus.test.ts src/app/DocumentPanel.test.tsx`
Expected: FAIL, `./liveStatus`, `./DocumentPanel` and `./panelHooks` cannot be resolved.

- [ ] **Step 3: Implement the status read and the panel hooks**

`src/api/liveStatus.ts`:

```ts
import type { ApiResult } from './client';

/** A document's run status as its toolbar shows it (spec §6.1). */
export type LiveStatus = 'checking' | 'running' | 'stopped' | 'unknown';

/**
 * Reads `GET /orchestration/live` defensively. A failed call or a body that is not an array is
 * "status unknown", never "stopped" (a Redis fault is a 500, spec §4.4). Entries that are not
 * strings, or strings that are not this workflow's id, are skipped; ids compare without case.
 */
export function liveStatusOf(result: ApiResult<unknown>, workflowId: string): LiveStatus {
  if (!result.ok || !Array.isArray(result.value)) return 'unknown';
  const id = workflowId.toLowerCase();
  return result.value.some((entry) => typeof entry === 'string' && entry.toLowerCase() === id) ? 'running' : 'stopped';
}
```

`src/app/panelHooks.ts`:

```ts
import { useEffect, useState } from 'react';
import type { DockviewPanelApi } from 'dockview-react';
import type { StudioApi } from '../api/client';
import { liveStatusOf, type LiveStatus } from '../api/liveStatus';

/** The part of a dockview panel's api these hooks use (tests pass a stand-in). */
export type PanelLike = Pick<DockviewPanelApi, 'getWindow' | 'onDidLocationChange' | 'isVisible' | 'onDidVisibilityChange'>;

/**
 * The document a panel is drawn in: the main page, or its pop-out window once popped out (spec
 * §6.3: code inside a panel uses its own document, never the global one).
 */
export function useOwnerDocument(panel: PanelLike): Document {
  const [doc, setDoc] = useState<Document>(() => panel.getWindow().document);
  useEffect(() => {
    setDoc(panel.getWindow().document);
    const sub = panel.onDidLocationChange(() => setDoc(panel.getWindow().document));
    return () => sub.dispose();
  }, [panel]);
  return doc;
}

/** True while the panel's tab is the visible one and its window is not hidden (a background browser tab). */
export function usePanelVisible(panel: PanelLike, doc: Document): boolean {
  const [shown, setShown] = useState(panel.isVisible);
  const [pageVisible, setPageVisible] = useState(doc.visibilityState !== 'hidden');
  useEffect(() => {
    setShown(panel.isVisible);
    const sub = panel.onDidVisibilityChange((e) => setShown(e.isVisible));
    return () => sub.dispose();
  }, [panel]);
  useEffect(() => {
    const update = () => setPageVisible(doc.visibilityState !== 'hidden');
    update();
    doc.addEventListener('visibilitychange', update);
    return () => doc.removeEventListener('visibilitychange', update);
  }, [doc]);
  return shown && pageVisible;
}

export const LIVE_POLL_MS = 5000;

/** Polls `GET /orchestration/live` every 5 s, only while `visible` (spec §6.1). Starts as "checking". */
export function useLiveStatus(api: StudioApi, workflowId: string, visible: boolean): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('checking');
  useEffect(() => {
    if (!visible) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await api.listLive().catch((e: unknown) => ({ ok: false as const, error: { kind: 'network' as const, message: String(e) } }));
      if (!live) return;
      setStatus(liveStatusOf(result, workflowId));
      timer = setTimeout(() => void poll(), LIVE_POLL_MS);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [api, workflowId, visible]);
  return status;
}
```

- [ ] **Step 4: Implement the toolbar and the panel**

`src/app/CapsuleToolbar.tsx`:

```tsx
import type { LiveStatus } from '../api/liveStatus';
import { ZoomControls } from '../canvas/ZoomControls';
import { entityName } from '../model/entityNames';
import type { Workflow } from '../model/graph';

const NOT_YET = 'Not available yet';

function StatusPill({ status }: { status: LiveStatus }) {
  switch (status) {
    case 'running': return <span className="run-chip">▶ running</span>;
    case 'stopped': return <span className="stopped">■ stopped</span>;
    case 'unknown': return <span className="unknown" data-tip="BaseApi could not say whether it runs">status unknown</span>;
    case 'checking': return <span className="unknown">checking…</span>;
  }
}

/**
 * A document's capsule toolbar (spec §6.1, mockup v49 .docbar): its name, cron, run status, Save,
 * Start and Stop, and its own zoom and Fit. Slice 3a writes nothing: Save, Start and Stop are
 * disabled. It must be rendered inside the document's WorkflowCanvas, for ZoomControls.
 */
export function CapsuleToolbar({ workflow, status }: { workflow: Workflow; status: LiveStatus }) {
  return (
    <div className="docbar" role="toolbar" aria-label="Workflow">
      <div className="cap-b crumb" data-tip={entityName(workflow.name, workflow.version, workflow.id)}>
        <b>{workflow.name}</b><span className="ver">_{workflow.version}</span>
      </div>
      <span className="cap-b chip">⏱ {workflow.cronExpression || 'not scheduled'}</span>
      <div className="cap-b stat" aria-label="Status"><StatusPill status={status} /></div>
      <span className="spacer" />
      <div className="docact">
        <span data-tip="Nothing to save yet"><button type="button" className="qb" disabled>⤓ Save</button></span>
        <span className="qsep" />
        <span data-tip={NOT_YET}><button type="button" className="qb run" disabled>▶ Start</button></span>
        <span data-tip={NOT_YET}><button type="button" className="qb stop" disabled>■ Stop</button></span>
      </div>
      <ZoomControls />
    </div>
  );
}
```

`src/app/DocumentPanel.tsx`:

```tsx
import type { StudioApi } from '../api/client';
import { useFitter } from '../canvas/useFitter';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas';
import { useStudio, useStudioStore } from '../store/studioStore';
import { CapsuleToolbar } from './CapsuleToolbar';
import { useLiveStatus, useOwnerDocument, usePanelVisible, type PanelLike } from './panelHooks';

/**
 * One workflow document in its dock tab: its own React Flow canvas and viewport (the panel uses
 * `renderer: 'always'`, so both survive tab switches), its toolbar and its run status. Labels
 * are measured in the document the panel is drawn in, so a pop-out keeps its fonts (spec §6.3).
 */
export function DocumentPanel({ api, workflowId, panel }: { api: StudioApi; workflowId: string; panel: PanelLike }) {
  const open = useStudio((s) => s.docs.find((d) => d.workflowId === workflowId) ?? null);
  const store = useStudioStore();
  const ownerDocument = useOwnerDocument(panel);
  const fitter = useFitter(ownerDocument);
  const status = useLiveStatus(api, workflowId, usePanelVisible(panel, ownerDocument));

  if (open === null) return null;
  if (open.status.kind === 'failed') return <div className="docpanel"><div className="doc-msg error" role="alert">{open.status.message}</div></div>;
  if (open.status.kind === 'loading' || fitter === null) return <div className="docpanel"><div className="doc-msg">Loading…</div></div>;

  return (
    <div className="docpanel">
      <WorkflowCanvas
        doc={open.status.doc}
        fitter={fitter}
        selection={open.selection}
        onSelect={(selection) => {
          store.dispatch({ type: 'activate', workflowId });
          store.dispatch({ type: 'select', workflowId, selection });
        }}
      >
        <CapsuleToolbar workflow={open.status.doc.graph.workflow} status={status} />
      </WorkflowCanvas>
    </div>
  );
}
```

`src/app/document.css`:

```css
/* A document panel and its capsule toolbar (mockup v49 .docpanel, .docbar, .cap-b, .docact, .qb). */
.docpanel { position: relative; height: 100%; background: var(--ground); }
.doc-msg { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: 13px; }
.doc-msg.error { color: var(--f); }
.docbar { position: absolute; left: 12px; right: 24px; top: 10px; display: flex; align-items: center; gap: 8px; z-index: 7; pointer-events: none; font-family: var(--sans); }
.docbar > * { pointer-events: auto; flex: none; }
.docbar .spacer { flex: 1 1 0; min-width: 0; }
.cap-b { white-space: nowrap; background: rgba(14, 24, 40, .86); backdrop-filter: blur(6px); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; font-size: 12.5px; color: var(--muted); }
.docbar .crumb { flex: 0 1 auto; min-width: 80px; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
.crumb b { color: var(--ink); font-weight: 600; font-size: 15px; }
.crumb .ver { font-family: var(--mono); color: var(--muted); font-size: 12px; }
.docbar .chip { font-family: var(--mono); font-size: 11.5px; max-width: 170px; overflow: hidden; text-overflow: ellipsis; }
.stat { display: flex; gap: 8px; align-items: center; }
.run-chip { font-size: 11.5px; color: var(--c); border: 1px solid rgba(45, 212, 191, .4); border-radius: 999px; padding: 2px 8px; }
.stat .stopped { font-size: 11.5px; color: var(--muted); }
.stat .unknown { font-size: 11.5px; color: var(--faint); }
.docact { display: flex; align-items: center; gap: 2px; padding: 2px 4px; border-radius: 7px; border: 1px solid var(--line-2); background: rgba(14, 24, 40, .86); backdrop-filter: blur(6px); }
.qb { font-family: var(--sans); font-size: 12.5px; padding: 3px 9px; white-space: nowrap; border-radius: 5px; border: 1px solid transparent; background: none; color: var(--muted); cursor: pointer; }
.qb:hover { background: var(--panel-2); border-color: var(--line-2); color: var(--ink); }
.qb.run { color: var(--c); }
.qb.stop { color: var(--f); }
/* a disabled button takes no pointer events, so its wrapper's tooltip still shows */
.qb:disabled { opacity: .35; cursor: default; background: none; border-color: transparent; pointer-events: none; }
.qsep { width: 1px; height: 18px; background: var(--line); margin: 0 4px; }
```

- [ ] **Step 5: Run the tests and the typecheck** (PowerShell)

```powershell
npx vitest run src/api/liveStatus.test.ts src/app/DocumentPanel.test.tsx
npm run typecheck
```

Expected: 2 test files, 10 tests passed; typecheck prints nothing.

- [ ] **Step 6: Commit** (from the repository root)

```bash
git add src/WorkflowStudio/src/api/liveStatus.ts src/WorkflowStudio/src/api/liveStatus.test.ts src/WorkflowStudio/src/app/panelHooks.ts src/WorkflowStudio/src/app/CapsuleToolbar.tsx src/WorkflowStudio/src/app/DocumentPanel.tsx src/WorkflowStudio/src/app/DocumentPanel.test.tsx src/WorkflowStudio/src/app/document.css
git commit -m "feat(studio): document panel with capsule toolbar, its own zoom and the live status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The page: store, loader and dock wired together

**Files:**
- Modify: `src/App.tsx` (replace), `src/main.tsx` (replace), `src/app.css` (replace)
- Test: `src/App.test.tsx` (replace), `src/App.fonts.test.tsx` (new)

**Interfaces:**
- Consumes: everything above.
- Produces: `App({ api?, storage? })`, the studio page; `describeError(error)` (`notFound` reads "This workflow no longer exists.").

`App` makes one store and starts loading the page's fonts at once (plan 2's preload, now through `fitterFor(document)`). `Studio` reads the workflow list (again each time the picker opens), opens a workflow by dispatching `open` and loading it (`loaded` or `failed`), and hands the dock its documents, the picker items (unique names, sorted), the pane bodies, the Inspector key, Esc (clear the active selection) and `<SvgDefs />` for pop-outs. The dock's document list is memoised on each document's id, name and version only, so a selection change does not re-render every tab. The plan-2 picker, status line and `?workflow=` parameter go.

- [ ] **Step 1: Write the failing tests**

Replace `src/App.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from './api/client';
import { graphDto, stepDto, workflowDto } from './api/fixtures';
import { App } from './App';
import { memoryStorage } from './test/memoryStorage';

const ZETA = '11111111-2222-3333-4444-555555555555';
const ALPHA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

function fakeApi(over: Partial<StudioApi> = {}): StudioApi {
  return {
    listWorkflows: vi.fn().mockResolvedValue({ ok: true, value: [workflowDto({ id: ZETA, name: 'zeta' }), workflowDto({ id: ALPHA, name: 'alpha' })] }),
    getGraph: vi.fn().mockImplementation(async (id: string) => ({
      ok: true, value: graphDto({ workflow: workflowDto({ id, name: id === ALPHA ? 'alpha' : 'zeta' }), steps: [stepDto('s1', { name: 'fetch' })] }),
    })),
    getStep: vi.fn().mockResolvedValue(notFound),
    getProcessor: vi.fn().mockResolvedValue(notFound),
    getSchema: vi.fn().mockResolvedValue(notFound),
    listLive: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    validate: vi.fn().mockResolvedValue({ ok: true, value: { valid: true, problems: [] } }),
    ...over,
  };
}


const openPicker = () => {
  fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Open workflow/ }));
};
const pickWorkflow = async (label: string) => {
  openPicker();
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(label) }));
};
const inspector = () => screen.getByText(/Open a workflow to inspect it|Nothing selected|STEP|WORKFLOW|Loading/, { selector: '.paneBody *' }).closest('.paneBody') as HTMLElement;

beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null); });
afterEach(() => { vi.restoreAllMocks(); });

describe('App', () => {
  it('lists the workflows in the picker by unique name, sorted', async () => {
    render(<App api={fakeApi()} storage={memoryStorage()} />);
    openPicker();
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent))
      .toEqual(['alpha_1.0.0-dddd-eeeeeeeeeeee', 'zeta_1.0.0-4444-555555555555']));
  });

  it('says in the picker why the list could not be read', async () => {
    render(<App api={fakeApi({ listWorkflows: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'network', message: 'Failed to fetch' } }) })} storage={memoryStorage()} />);
    openPicker();
    expect(await screen.findByText('Workflows could not be listed. Network error: Failed to fetch')).toBeInTheDocument();
  });

  it('opens a workflow as a tab, fills the Inspector on a click, and clears it on Esc', async () => {
    render(<App api={fakeApi()} storage={memoryStorage()} />);
    await pickWorkflow('alpha');

    const step = await screen.findByText('fetch');
    expect(within(inspector()).getByText('Nothing selected. Click a step, a processor, a cache or the workflow.')).toBeInTheDocument();
    expect(screen.getByText('No problems')).toBeInTheDocument();

    fireEvent.click(step.closest('.react-flow__node')!);
    expect(within(inspector()).getByText('STEP')).toBeInTheDocument();
    expect(within(inspector()).getByLabelText('Unique name')).toHaveTextContent('fetch_1.0.0-s1');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(within(inspector()).getByText(/Nothing selected/)).toBeInTheDocument();
  });

  it('focuses the tab of a workflow that is already open instead of loading it again', async () => {
    const api = fakeApi();
    render(<App api={api} storage={memoryStorage()} />);
    await pickWorkflow('alpha');
    await screen.findByText('fetch');
    await pickWorkflow('zeta');
    await waitFor(() => expect(screen.getAllByText('fetch')).toHaveLength(2));

    openPicker();
    expect(await screen.findByRole('option', { name: /alpha.*open — switch/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /alpha/ }));

    expect(api.getGraph).toHaveBeenCalledTimes(2);
  });

  it('shows in its tab that a workflow no longer exists (review focus 2)', async () => {
    render(<App api={fakeApi({ getGraph: vi.fn().mockResolvedValue(notFound) })} storage={memoryStorage()} />);
    await pickWorkflow('zeta');
    expect(await screen.findByText('This workflow no longer exists.', { selector: '.doc-msg' })).toHaveAttribute('role', 'alert');
  });
});
```

`src/App.fonts.test.tsx` (its own file, because the fitter is made once per document per module):

```tsx
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioApi } from './api/client';
import { App } from './App';
import * as fitText from './canvas/fitText';

// Its own file: the fitter is made once per document per module, and this test must see it made.
vi.mock('./canvas/fitText', async (original) => {
  const actual = await original<typeof import('./canvas/fitText')>();
  return { ...actual, createTextFitter: vi.fn(actual.createTextFitter) };
});

afterEach(() => { delete (document as { fonts?: unknown }).fonts; });

describe('App fonts (plan 2 preload, kept)', () => {
  it('starts loading every measured face as the page opens, before any fitter is made', async () => {
    const load = vi.fn().mockResolvedValue([]);
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load, ready: Promise.resolve() } });
    const api = { listWorkflows: vi.fn().mockResolvedValue({ ok: true, value: [] }) } as unknown as StudioApi;

    render(<App api={api} storage={null} />);

    await waitFor(() => expect(fitText.createTextFitter).toHaveBeenCalled());
    expect(load.mock.calls.map((c) => c[0]).sort()).toEqual([...fitText.MEASURED_FONTS].sort());
    expect(Math.max(...load.mock.invocationCallOrder)).toBeLessThan(vi.mocked(fitText.createTextFitter).mock.invocationCallOrder[0]!);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/App.test.tsx src/App.fonts.test.tsx`
Expected: `App.test.tsx` FAILS (plan 2's page has no File menu, no tabs and no Inspector); `App.fonts.test.tsx` already passes, because plan 2's page preloads the fonts the same way: it is the guard that the new page keeps doing so.

- [ ] **Step 3: Replace the page**

`src/App.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createApi, type ApiError, type StudioApi } from './api/client';
import type { WorkflowReadDto } from './api/types';
import { DocumentPanel } from './app/DocumentPanel';
import { loadDocument } from './app/loadDocument';
import { SvgDefs } from './canvas/SvgDefs';
import { fitterFor } from './canvas/useFitter';
import { DockShell, type DockDocument, type PickerItem } from './dock/DockShell';
import type { ToolId } from './dock/ids';
import { entityName } from './model/entityNames';
import { Inspector } from './panels/Inspector';
import { Output, Toolbox } from './panels/PaneNote';
import { Problems } from './panels/Problems';
import { inspectorKey } from './store/studioState';
import { createStudioStore, StudioStoreProvider, useStudio, useStudioStore } from './store/studioStore';

export function describeError(error: ApiError): string {
  switch (error.kind) {
    case 'notFound': return 'This workflow no longer exists.';
    case 'network': return `Network error: ${error.message}`;
    default: return error.status === 0 ? error.detail : `${error.status}: ${error.detail}`;
  }
}

const uniqueName = (w: WorkflowReadDto) => entityName(w.name ?? '', w.version ?? '', w.id ?? '');

function renderTool(id: ToolId) {
  switch (id) {
    case 'inspector': return <Inspector />;
    case 'problems': return <Problems />;
    case 'output': return <Output />;
    case 'toolbox': return <Toolbox />;
  }
}

/** The studio page (slice 3a): one store, the dock, and what goes in its documents and panes. */
export function App({ api: injected, storage }: { api?: StudioApi; storage?: Storage | null }) {
  const api = useMemo(() => injected ?? createApi(), [injected]);
  const store = useMemo(() => createStudioStore(), []);
  // the page's fonts start loading at once, so the first document opens with its fitter ready
  useEffect(() => { void fitterFor(document); }, []);
  return (
    <StudioStoreProvider value={store}>
      <SvgDefs />
      <Studio api={api} storage={storage} />
    </StudioStoreProvider>
  );
}

function Studio({ api, storage }: { api: StudioApi; storage?: Storage | null }) {
  const store = useStudioStore();
  const docs = useStudio((s) => s.docs);
  const activeId = useStudio((s) => s.activeId);
  const inspector = useStudio(inspectorKey);
  const [workflows, setWorkflows] = useState<WorkflowReadDto[]>([]);
  const [listError, setListError] = useState<string | undefined>(undefined);

  const readList = useCallback(() => {
    void api.listWorkflows().then((r) => {
      if (r.ok) {
        setWorkflows([...r.value].sort((a, b) => uniqueName(a).localeCompare(uniqueName(b))));
        setListError(undefined);
      } else {
        setListError(`Workflows could not be listed. ${describeError(r.error)}`);
      }
    });
  }, [api]);
  useEffect(readList, [readList]);

  const openWorkflow = useCallback((id: string) => {
    const known = workflows.find((w) => w.id === id);
    const alreadyOpen = store.getState().docs.some((d) => d.workflowId === id);
    store.dispatch({ type: 'open', workflowId: id, name: known?.name ?? id, version: known?.version ?? '' });
    if (alreadyOpen) return;
    void loadDocument(api, id).then((r) => store.dispatch(r.ok
      ? { type: 'loaded', workflowId: id, doc: r.value }
      : { type: 'failed', workflowId: id, message: describeError(r.error) }));
  }, [api, store, workflows]);

  // the dock only needs each document's identity and names; a selection change must not re-render every tab
  const identity = docs.map((d) => `${d.workflowId}\u0000${d.name}\u0000${d.version}`).join('\u0001');
  const documents: DockDocument[] = useMemo(
    () => docs.map((d) => ({ id: d.workflowId, name: d.name, version: d.version, tooltip: entityName(d.name, d.version, d.workflowId) })),
    [identity], // the part of `docs` the dock shows; `docs` itself changes on every selection

  );
  const items: PickerItem[] = useMemo(
    () => workflows.filter((w) => w.id).map((w) => ({ id: w.id!, label: uniqueName(w), open: documents.some((d) => d.id === w.id) })),
    [workflows, documents],
  );

  return (
    <DockShell
      documents={documents}
      activeDocumentId={activeId}
      onActivateDocument={(id) => store.dispatch({ type: 'activate', workflowId: id })}
      onCloseDocument={(id) => store.dispatch({ type: 'close', workflowId: id })}
      workflows={items}
      pickerNote={listError}
      onPickerOpen={readList}
      onOpenWorkflow={openWorkflow}
      renderDocument={(id, panel) => <DocumentPanel api={api} workflowId={id} panel={panel} />}
      renderTool={renderTool}
      inspectorKey={inspector}
      onEscape={() => {
        const id = store.getState().activeId;
        if (id !== null) store.dispatch({ type: 'select', workflowId: id, selection: null });
      }}
      popoutContent={<SvgDefs />}
      storage={storage}
    />
  );
}
```

`src/main.tsx` (dockview's stylesheet before ours, so the theme overrides win):

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans-condensed/400.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@xyflow/react/dist/style.css';
import 'dockview-react/dist/styles/dockview.css';
import './canvas/tokens.css';
import './canvas/canvas.css';
import './dock/dock.css';
import './panels/panels.css';
import './app/document.css';
import './app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`src/app.css`:

```css
/* The page itself; the chrome is dock/dock.css, the panes panels/panels.css, a document app/document.css. */
*, *::before, *::after { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--ground); color: var(--ink); font-family: var(--sans); overflow: hidden; }
```

- [ ] **Step 4: Run the whole suite, the typecheck and the build** (PowerShell)

```powershell
npm test
npm run typecheck
npm run build
```

Expected: `npm test` passes 35 test files, 278 tests, with no React or React Flow warning in the output; typecheck prints nothing; the build writes `dist/index.html` and `dist/popout.html` (Vite's "chunks larger than 500 kB" note is expected, as in plan 2).

- [ ] **Step 5: Look at it against the live BaseApi** (PowerShell; the port-forward must be running)

```powershell
npm run dev
```

Open `http://localhost:5173` and check by eye against the mockup: the menu strip, the empty document area ("No workflow open"), Inspector and Toolbox on the right, Problems and Output under the documents. Open a workflow with File › Open workflow…: its tab, its toolbar (status pill within 5 s), the canvas. Click a step, a die, a cache and the sphere: the highlight and the Inspector follow; ▸ show all; Esc clears. Right-click a pane's tab: Float, Auto hide, Dock. Report what you saw, including anything that does not match.

- [ ] **Step 6: Commit** (from the repository root)

```bash
git add src/WorkflowStudio/src/App.tsx src/WorkflowStudio/src/App.test.tsx src/WorkflowStudio/src/App.fonts.test.tsx src/WorkflowStudio/src/main.tsx src/WorkflowStudio/src/app.css
git commit -m "feat(studio): the dock replaces the plan-2 page: documents, panes and selection wired" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End-to-end tests (spec §9, slice 3a)

**Files:**
- Create: `e2e/studio.ts`, `e2e/dock.spec.ts`

**Interfaces:**
- Consumes: the page (Task 10), the live BaseApi on `localhost:18080` (read-only), the Playwright harness (Task 1).
- Produces: `liveWorkflows(request, count)`, `openWorkflow(page, workflow)`, `tab(page, name)`, `documentPanel(page, workflow)`, `inspector(page)`, `groupOf(page, name)`, `box(locator)`; eleven tests.

Every test starts from the default layout (it clears `localStorage` and reloads). The tests choose their workflows from the live list (the first ones with steps), so they do not depend on particular data, and they never write: GETs and the validate dry run only.

| Spec §9 item (3a) | Test |
|---|---|
| open a workflow, select an entity and see the Inspector fill | `opens a workflow, selects an entity and the Inspector fills` |
| auto-hide a pane and pin it back | `auto-hides a pane and pins it back` (also: a hidden Inspector still fills and its rail tab glows) |
| float and re-dock to the exact spot | `floats the Toolbox / Inspector / Problems and docks it back to the exact spot` (three cases: a far pane, a middle pane, a tab out of a tab group) |
| switch document tabs and come back: viewport and selection kept | `switches document tabs and comes back with the viewport and selection kept` |
| menus, pickers and the tooltip open above a floating group | `menus, the picker and the tooltip open above a floating group` |
| pop out a document, zoom in the new window | `pops a document out, and it keeps its fonts, its drawing and its zoom` (review focus 4) |
| documents drop only into or beside the document area, with a real mouse drag | `a document drops only into or beside the document area` |
| (§6.2.6, §6.1) | `Ctrl+E switches windows and Alt+W closes the active document`; `a saved window layout comes back after a reload, without the documents` |

Dragging a block in a pop-out is plan 4's (nothing is draggable in 3a); this plan's pop-out test zooms with the button and with Ctrl+wheel instead.

- [ ] **Step 1: Write the helpers and the tests**

`e2e/studio.ts`:

```ts
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

export interface LiveWorkflow { id: string; name: string; version: string; label: string }

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The entity-name rule (model/entityNames.ts), so a test can find a workflow in the picker. */
const label = (name: string, version: string, id: string) => `${name}_${version}-${GUID.test(id) ? id.slice(19).toLowerCase() : id}`;

/** `count` workflows from the live BaseApi that have at least one step. Read-only. */
export async function liveWorkflows(request: APIRequestContext, count: number): Promise<LiveWorkflow[]> {
  const list = await request.get('/api/v1/workflows');
  expect(list.ok()).toBe(true);
  const found: LiveWorkflow[] = [];
  for (const w of (await list.json()) as { id: string; name: string; version: string }[]) {
    const graph = await request.get(`/api/v1/workflows/${w.id}/graph`);
    if (graph.ok() && ((await graph.json()) as { steps?: unknown[] }).steps?.length) {
      found.push({ id: w.id, name: w.name, version: w.version, label: label(w.name, w.version, w.id) });
    }
    if (found.length === count) return found;
  }
  throw new Error(`BaseApi has fewer than ${count} workflows with steps`);
}

/** File › Open workflow…, search by unique name, Enter; waits until the canvas has drawn. */
export async function openWorkflow(page: Page, workflow: LiveWorkflow): Promise<void> {
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Open workflow/ }).click();
  await page.getByRole('textbox', { name: 'Search workflows' }).fill(workflow.label);
  await page.keyboard.press('Enter');
  await expect(documentPanel(page, workflow).locator('.react-flow__node').first()).toBeVisible();
}

/** A tab by the text it shows (a document's name, or a pane's title). */
export const tab = (page: Page, name: string): Locator => page.locator('.dv-tab .doctab').filter({ has: page.locator('.nm', { hasText: new RegExp(`^${name}$`) }) });

/** A document's panel, found by the unique name its toolbar carries. */
export const documentPanel = (page: Page, workflow: LiveWorkflow): Locator =>
  page.locator('.docpanel').filter({ has: page.locator(`.crumb[data-tip="${workflow.label}"]`) });

/** The Inspector's body wherever it is (docked, floating or in the flyout). */
export const inspector = (page: Page): Locator => page.locator('[data-pane="inspector"]');

/** The group (dockview's `.dv-groupview`) that holds a tab. */
export const groupOf = (page: Page, name: string): Locator => page.locator('.dv-groupview').filter({ has: tab(page, name) });

export async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not laid out');
  return b;
}
```

`e2e/dock.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { box, documentPanel, groupOf, inspector, liveWorkflows, openWorkflow, tab, type LiveWorkflow } from './studio';

// Spec §9, slice 3a. Read-only against the live BaseApi: GETs and the validate dry run only.
let workflows: LiveWorkflow[];

test.beforeAll(async ({ request }) => { workflows = await liveWorkflows(request, 2); });

test.beforeEach(async ({ page }) => {
  // every test starts from the default layout: no saved window layout in this browser
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(tab(page, 'Inspector')).toBeVisible();
});

test('opens a workflow, selects an entity and the Inspector fills', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  await expect(inspector(page)).toContainText('Nothing selected');

  await documentPanel(page, wf!).locator('.react-flow__node-step').first().click({ position: { x: 20, y: 12 } });

  await expect(inspector(page).locator('.kindpill')).toHaveText(/STEP/);
  await expect(inspector(page).getByLabel('Unique name')).toHaveText(/_\d+\.\d+\.\d+-/);
  await expect(documentPanel(page, wf!).locator('.react-flow__node-step.studio-sel')).toHaveCount(1);

  await documentPanel(page, wf!).locator('.react-flow__node-step .chipg').first().click();
  await expect(inspector(page).locator('.kindpill')).toHaveText('PROCESSOR');
  await expect(inspector(page).locator('.slot')).toHaveCount(3);

  await page.keyboard.press('Escape');
  await expect(inspector(page)).toContainText('Nothing selected');
});

test('auto-hides a pane and pins it back', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  const before = await box(groupOf(page, 'Inspector'));

  await tab(page, 'Inspector').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Auto hide/ }).click();
  await expect(tab(page, 'Inspector')).toBeHidden();
  const rail = page.locator('[data-rt="inspector"]');
  await expect(rail).toBeVisible();

  // a hidden Inspector still fills, and its rail tab glows
  await documentPanel(page, wf!).locator('.react-flow__node-workflow').click();
  await expect(rail).toHaveClass(/fresh/);
  await rail.hover();
  await expect(page.locator('.fly')).toBeVisible();
  await expect(page.locator('.fly [data-pane="inspector"] .kindpill')).toHaveText('WORKFLOW');

  await page.locator('.fly').getByRole('button', { name: /Dock/ }).click();
  await expect(rail).toHaveCount(0);
  const after = await box(groupOf(page, 'Inspector'));
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(2);
});

for (const pane of ['Toolbox', 'Inspector', 'Problems']) {
  test(`floats the ${pane} and docks it back to the exact spot`, async ({ page }) => {
    await openWorkflow(page, workflows[0]!);
    const before = await box(groupOf(page, pane));

    await tab(page, pane).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^⧉\s*Float/ }).click();
    await expect(page.locator('.dv-resize-container').filter({ has: tab(page, pane) })).toBeVisible();

    await tab(page, pane).dblclick({ modifiers: ['Control'] });
    await expect(page.locator('.dv-resize-container').filter({ has: tab(page, pane) })).toHaveCount(0);
    const after = await box(groupOf(page, pane));
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(2);
  });
}

test('switches document tabs and comes back with the viewport and selection kept', async ({ page }) => {
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  const panelA = documentPanel(page, a!);
  await panelA.locator('.react-flow__node-workflow').click();
  await panelA.getByRole('button', { name: 'Zoom in' }).click();
  await panelA.getByRole('button', { name: 'Zoom in' }).click();
  const zoom = await panelA.getByLabel('Zoom level').textContent();
  const transform = await panelA.locator('.react-flow__viewport').getAttribute('style');

  await openWorkflow(page, b!);
  await expect(inspector(page)).toContainText('Nothing selected');
  await tab(page, a!.name).click();

  await expect(panelA.getByLabel('Zoom level')).toHaveText(zoom!);
  expect(await panelA.locator('.react-flow__viewport').getAttribute('style')).toBe(transform);
  await expect(panelA.locator('.react-flow__node-workflow.studio-sel')).toHaveCount(1);
  await expect(inspector(page).locator('.kindpill')).toHaveText('WORKFLOW');
});

test('menus, the picker and the tooltip open above a floating group', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  await tab(page, 'Inspector').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^⧉\s*Float/ }).click();
  const floating = page.locator('.dv-resize-container').filter({ has: tab(page, 'Inspector') });
  await expect(floating).toBeVisible();
  const f = await box(floating);

  // a menu opened at a point inside the floating group is the topmost thing there
  await tab(page, 'Inspector').click({ button: 'right' });
  const menu = page.getByRole('menu');
  const m = await box(menu);
  const topmost = await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.dropdown'), [m.x + 20, m.y + 10]);
  expect(topmost).toBe(true);
  expect(m.x).toBeGreaterThanOrEqual(f.x - 1);
  await page.keyboard.press('Escape');

  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Open workflow/ }).click();
  const pickerZ = await page.locator('.picker').evaluate((el) => getComputedStyle(el).zIndex);
  const floatZ = await floating.evaluate((el) => getComputedStyle(el).zIndex);
  expect(Number(pickerZ)).toBeGreaterThan(Number(floatZ));
  await page.keyboard.press('Escape');

  await documentPanel(page, wf!).locator('[data-tip="Not available yet"]').first().hover();
  const tip = page.getByRole('tooltip').filter({ hasText: 'Not available yet' });
  await expect(tip).toHaveClass(/on/);
  expect(Number(await tip.evaluate((el) => getComputedStyle(el).zIndex))).toBeGreaterThan(Number(floatZ));
});

test('pops a document out, and it keeps its fonts, its drawing and its zoom', async ({ page }) => {
  const [wf] = workflows;
  await openWorkflow(page, wf!);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    groupOf(page, wf!.name).getByRole('button', { name: 'Pop out to its own window' }).click(),
  ]);
  await popup.waitForLoadState();
  const panel = popup.locator('.docpanel');
  await expect(panel.locator('.react-flow__node-step').first()).toBeVisible();

  // review focus 4: the pop-out has the fonts, the measure canvas and the SVG definitions it needs
  expect(await popup.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('600 14.5px "IBM Plex Sans Condensed"') && !!document.getElementById('glow') && !!document.getElementById('capfill');
  })).toBe(true);

  // selecting in the pop-out fills the Inspector in the main window
  await panel.locator('.react-flow__node-workflow').click();
  await expect(inspector(page).locator('.kindpill')).toHaveText('WORKFLOW');

  const level = async () => Number((await panel.getByLabel('Zoom level').textContent())!.replace('%', ''));
  const start = await level();
  await panel.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(level).toBeGreaterThan(start);

  const pane = await box(panel.locator('.react-flow__pane'));
  const zoomed = await level();
  await popup.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await popup.keyboard.down('Control');
  await popup.mouse.wheel(0, -300);
  await popup.keyboard.up('Control');
  await expect.poll(level).toBeGreaterThan(zoomed);
});

test('a document drops only into or beside the document area', async ({ page }) => {
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  await openWorkflow(page, b!);
  const documentGroup = await box(groupOf(page, a!.name));

  // onto the Toolbox: refused, the tab stays where it was
  const toolbox = await box(page.locator('[data-pane="toolbox"]'));
  await tab(page, b!.name).hover();
  await page.mouse.down();
  await page.mouse.move(toolbox.x + toolbox.width / 2, toolbox.y + toolbox.height / 2, { steps: 12 });
  await page.mouse.up();
  expect(await box(groupOf(page, b!.name))).toEqual(await box(groupOf(page, a!.name)));

  // beside the other document: allowed, a new document group to its right
  await tab(page, b!.name).hover();
  await page.mouse.down();
  await page.mouse.move(documentGroup.x + documentGroup.width - 30, documentGroup.y + documentGroup.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await box(groupOf(page, b!.name))).x).toBeGreaterThan(documentGroup.x + 40);
});

test('Ctrl+E switches windows and Alt+W closes the active document', async ({ page }) => {
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  await openWorkflow(page, b!);

  await page.keyboard.down('Control');
  await page.keyboard.press('e');
  await expect(page.getByRole('dialog', { name: 'Switch window' })).toBeVisible();
  await page.keyboard.up('Control');
  await expect(page.getByRole('dialog', { name: 'Switch window' })).toHaveCount(0);
  await expect(page.locator('.dv-tab.dv-active-tab .doctab .nm').filter({ hasText: a!.name })).toHaveCount(1);

  await page.keyboard.press('Alt+w');
  await expect(tab(page, a!.name)).toHaveCount(0);
  await expect(tab(page, b!.name)).toHaveCount(1);
});

test('a saved window layout comes back after a reload, without the documents', async ({ page }) => {
  await openWorkflow(page, workflows[0]!);
  await tab(page, 'Output').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Auto hide/ }).click();
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Save window layout/ }).click();
  await expect(page.locator('.toast')).toHaveText('Window layout saved in this browser');

  await page.reload();

  await expect(page.locator('[data-rt="output"]')).toBeVisible();
  await expect(tab(page, 'Inspector')).toBeVisible();
  await expect(page.locator('.docpanel')).toHaveCount(0);
  await expect(page.getByText('No workflow open')).toBeVisible();
});
```

- [ ] **Step 2: Run them** (PowerShell; the port-forward must be running)

```powershell
npm run typecheck
npm run e2e
```

Expected: typecheck prints nothing; `12 passed` (the smoke test and these eleven) in about a minute. Vite may log `[vite] (client) [Unhandled error] Error: ResizeObserver loop completed with undelivered notifications.` during the pop-out test: that is Chromium reporting a resize loop in the pop-out window, harmless, and the test still passes. Any failing test is a defect in the app or the test: read the trace (`npx playwright show-trace test-results/…/trace.zip`) before changing anything.

- [ ] **Step 3: Commit** (from the repository root)

```bash
git add src/WorkflowStudio/e2e/studio.ts src/WorkflowStudio/e2e/dock.spec.ts
git commit -m "test(studio): end-to-end tests for the dock, selection, pop-out and drop rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Build the image, deploy and check it live

**Files:** none (the Dockerfile copies `src/WorkflowStudio/` whole, so `public/popout.html` reaches `dist/`, and nginx's `try_files $uri /index.html` serves it as a file).

- [ ] **Step 1: Build the image** (from the repository root)

```bash
docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
```

Expected: the build ends with `naming to docker.io/library/workflow-studio:local`.

- [ ] **Step 2: Deploy (ask the user first: this replaces the studio running in the shared dev cluster)**

```bash
kind load docker-image workflow-studio:local --name desktop
kubectl -n skp rollout restart deploy/workflow-studio
kubectl -n skp rollout status deploy/workflow-studio --timeout=120s
```

Expected: `deployment "workflow-studio" successfully rolled out`.

- [ ] **Step 3: Check it live** (the port-forward supervisor already forwards `localhost:18081`)

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:18081/
curl -s http://localhost:18081/popout.html
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:18081/api/v1/orchestration/live
```

Expected: `200`; the pop-out page's own HTML (`<body></body>`, not the app's `<div id="root">`); `200`. Then open `http://localhost:18081` for the user (`Start-Process "http://localhost:18081"` in PowerShell) and ask them to try it: open two workflows, select things, hide and float panes, pop a document out, save the window layout and reload. They approve visual work by using it.

---

## Self-review notes

- **Spec coverage.**
  - §6.1 Shell: menu strip File · Edit · View · Window, no Run menu (Task 7); dock on dockview 8.4 (Tasks 1, 7); documents opened from a searchable picker by unique name, an open one focused (Tasks 6, 7, 10); shared panes Inspector, Toolbox, Problems, Output (Tasks 7, 8); capsule toolbar with name, cron, status from `GET /orchestration/live` every 5 s while visible, "status unknown" on failure, Save/Start/Stop disabled with "Not available yet", per-document zoom and Fit (Tasks 4, 9); selection of a step (parked included), a die, a cache, the sphere, filling the Inspector shown or hidden, cleared by Esc or an empty-canvas click, nothing moved (Tasks 3, 4, 7, 9, 10); layout persists, documents not restored (Tasks 5, 7, 11). The Save / Discard / Cancel prompt is not needed in 3a (nothing is dirty) and comes with editing.
  - §6.2: (1) window-position menu from ▾ and a tab's right-click, Ctrl+double-click float/dock (Task 7); (2) Save, Apply, Reset window layout in `localStorage` (Tasks 5, 7); (3) exact re-dock memory (Task 5, E2E Task 11); (4) documents only into or beside the document area (Tasks 5, 7, E2E Task 11); (5) in-house auto-hide rails left, right, bottom, hover or click to slide out, Dock pins back, a hidden Inspector glows (Tasks 5, 6, 7); (6) Ctrl+E switcher, double-click maximize, middle-click close, Alt+W (Tasks 5, 6, 7, 11).
  - §6.3: `renderer: 'always'` (Task 5 `addDocument`, tested); `ownerDocument` for the measure canvas, fonts, overlays, tooltips and keys (Tasks 4, 6, 7, 9; E2E pop-out); overlay tokens defined once and enforced (Task 5 `overlayTokens.test.ts`).
  - §7 shared rules: read-only text cut with an ellipsis and a tooltip only when cut (Tasks 6, 8); the unique name at the top (Task 8); ▸ show all / ▾ hide details, one switch (Tasks 3, 8). §7.1's editing is plan 3b.
  - §7.3: validate result with gate, title, detail; "Problems unavailable."; "No problems"; a click selects the named entity, with each gate's `offending` read defensively (Tasks 3, 8).
  - §8 (3a's share): a failed read shows its reason in the document tab and the picker; nothing is ever saved, so no save row applies yet.
  - §9 (3a): the end-to-end items in the Task 11 table, plus Vitest units for every pure part.
- **Deliberately not here:** editing anything (3b: Inspector; 4: canvas), Output messages, the toolbox's content, Start/Stop, the Save / Discard / Cancel prompt, junctions.
- **Type consistency checked:** `Selection`, `selectionKey`, `OpenDocument`, `DocStatus`, `StudioState`, `StudioAction`, `inspectorKey`, `StudioStore`, `ToolId`, `TOOL_IDS`, `TOOL_TITLES`, `docPanelId`/`documentIdOf`, `Side`, `Direction`, `Position`, `Rect`, `GroupBox`, `Home`, `DockMemory`, `SavedLayout`, `LAYOUT_KEY`, `Anchor`, `MenuEntry`, `PickerItem`, `DockDocument`, `ShellApi`, `GroupAction`, `InspectorView`, `Row`, `LiveStatus`, `PanelLike`, `LIVE_POLL_MS`, `FIT_VIEW_OPTIONS`, `SELECTED_CLASS`/`DIE_SELECTED_CLASS` are each defined once and used with the same names and fields everywhere. Every file in this plan was compiled (`tsc --noEmit`) and tested in task order before the plan was written: after each task the whole suite passes, and the end-to-end suite passed against the live BaseApi.
- **dockview API facts verified** in the installed packages (`dockview-react`, `dockview`, `dockview-core`, all 8.4.1; paths under `src/WorkflowStudio/node_modules/`):
  - The React binding is `dockview-react`: `dockview/dist/cjs/index.d.ts:1` is `export * from 'dockview-core'` (no React); `dockview-react/dist/cjs/index.d.ts:1-10` exports `DockviewReact` and re-exports `dockview`.
  - `DockviewReact` props: `components`, `tabComponents`, `watermarkComponent`, `defaultTabComponent`, `rightHeaderActionsComponent`, `onReady` (`dockview-react/dist/cjs/dockview/dockview.d.ts:8-33`), plus every `DockviewOptions` field, among them `proportionalLayout` (`dockview-core/dist/cjs/dockview/options.d.ts:308`), `popoutUrl` (:349) and `theme` (:395). `themeVisualStudio` (`dockview-core/dist/cjs/dockview/theme.d.ts:71`) has the class `dockview-theme-vs` (`dockview-core/dist/package/main.esm.mjs:11975`).
  - `renderer: 'always'`: `AddPanelOptions.renderer` (`options.d.ts:766`), `DockviewPanelRenderer = 'onlyWhenVisible' | 'always'` (`overlay/overlayRenderContainer.d.ts:5`); `inactive` and `initialWidth` (`options.d.ts:772-773`). Checked in jsdom: two `always` panels in one group are both mounted, one with `isVisible` false.
  - Floating groups at z-index 999: `.dv-resize-container { --dv-overlay-z-index: var(--dv-overlay-z-index, 999); z-index: calc(var(--dv-overlay-z-index) - 2) }` (`dockview-react/dist/styles/dockview.css:1043-1046`), and `.dockview-theme-vs { --dv-overlay-z-index: 999 }` (:1656). Every overlay token (1000–1050) is above it; checked in the browser by Task 11.
  - Layout persistence: `toJSON(): SerializedDockview` and `fromJSON(data, { reuseExistingPanels })` (`dockview-core/dist/cjs/api/component.api.d.ts:592-598`); `SerializedDockview { grid, panels, activeGroup?, floatingGroups?, popoutGroups?, edgeGroups? }` (`dockview/dockviewComponent.d.ts:102-114`); `GroupviewPanelState` (`dockview/types.d.ts:39`). `fromJSON` throws for a non-object or a root that is not a branch (`main.esm.mjs:17450-17451`) and skips a group's views whose panel state is missing (:17591), so a layout stripped of documents loads with an empty document group; `reuseExistingPanels` moves existing panels instead of re-creating them (checked in jsdom: the panel objects are the same after `fromJSON`).
  - Pop-outs: `addPopoutGroup(item, options?): Promise<boolean>` (`component.api.d.ts:671`); the URL defaults to `/popout.html` (`dockviewComponent.d.ts:43`, `main.esm.mjs:16538`); the pop-out gets copies of the page's stylesheets (`main.esm.mjs:960`); `onDidAddPopoutGroup` / `onDidRemovePopoutGroup` give `PopoutGroup { id, group, window }` (`component.api.d.ts:468, 474`; `dockviewComponent.d.ts:224-228`); a panel's `getWindow()` and `onDidLocationChange` (`api/dockviewPanelApi.d.ts:65, 49`) and `DockviewGroupLocation` `{ type: 'popout'; getWindow }` (`dockview/dockviewGroupPanelModel.d.ts:163-174`) give a panel its own document.
  - Drop restrictions: `onWillShowOverlay` (`component.api.d.ts:439`) gives `kind` (`'tab' | 'header_space' | 'content' | 'edge'`, `dockview/events.d.ts:8, 27`), `group` (:40), `preventDefault()` (:41) and `getData(): PanelTransfer` (:42) with `{ viewId, groupId, panelId: string | null }` (`dnd/dataTransfer.d.ts:4-10`).
  - Group and panel events: `onDidActivePanelChange` with `{ panel, origin }` (`component.api.d.ts:390`; `dockviewComponent.d.ts:195`), `onDidRemovePanel` (:403); `getPanel` (:556), `addPanel` (:564), `removePanel` (:568, which removes a group left empty: `main.esm.mjs:17980`), `addGroup` (:572), `getGroup` (:584), `addFloatingGroup` (:588), `panels` (:521), `groups` (:525), `activePanel` (:537).
  - Group api: `location` (`api/dockviewGroupPanelApi.d.ts:61`), `maximize` / `isMaximized` / `exitMaximized` (:76-78), `setSize` (:86), `setVisible` and `isVisible` from `PanelApi` (`api/panelApi.d.ts:24, 45`; a group's visibility hides its grid view and keeps its size, `main.esm.mjs:11668, 18957`); panel api `moveTo` (`api/dockviewPanelApi.d.ts:58`); a group's `element` (`gridview/basePanelView.d.ts:29`); header-actions props `{ api, containerApi, panels, activePanel, isGroupActive, group, headerPosition, location? }` (`dockview/framework.d.ts:25-34`), updated when the location changes; panel and tab props `{ api, containerApi, params }` (`framework.d.ts:10-24`).
  - `createDockview(element, options)` (`api/entryPoints.d.ts:6`) runs in jsdom, which is what lets Task 5 and Task 7 test the dock without a browser.

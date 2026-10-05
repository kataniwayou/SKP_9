# SKP Studio, Plan 2 of 7: Read-only Canvas -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `src/WorkflowStudio` web app, served by nginx in the kind cluster, opens any workflow from a picker and draws it read-only on the blueprint canvas: the lit sphere, glass-cap steps with their processor dies, caches, and lit cables routed straight / Z / U, laid out from the stored `Layout` or by elkjs when a block has no position.

**Architecture:** Vite + React + TypeScript. Four units with hard boundaries: `api/` (typed fetch client over types generated from BaseApi's OpenAPI document, plus DTO → model conversion), `model/` (pure graph rules mirroring the backend: reachability, start checks, schema edges, assignment choice, entry conditions), `layout/` (pure geometry: the `Layout` document, elkjs placement, ports, landings, the router), and `canvas/` (React Flow nodes and edges that only *draw* what `layout/` computed). `model/` and `layout/` import no React and do no I/O. Routing is global (it needs every block's box), so wires are computed once in `layout/` and handed to a custom edge as points; React Flow's own handle geometry is not used for drawing.

**Tech Stack:** Node ≥ 22.12, Vite 8.3.2, React 19.3.0, TypeScript 5.9.3, @xyflow/react 12.12.0, elkjs 0.12.0, Vitest 5.0.3 + jsdom 30.1.2 + Testing Library, openapi-typescript 7.13.0, Swashbuckle.AspNetCore.Cli 6.9.0 (a local dotnet tool), nginx 1.29-alpine.

**Spec:** `docs/superpowers/specs/2026-10-05-skp-studio-design.md` (sections 1, 2, 3.1, 4.3, 5.1–5.3, 5.4 pan/zoom and label shortening, 8 "stale ids", 9 `model/` and `layout/`, 10 slice 2). The visual reference is the mockup `.superpowers/brainstorm/385-1791189446/content/skp-studio-dock-v49.html` (gitignored); every visual value below was copied from it.

## Global Constraints

- **Location and runtime.** The app lives in `src/WorkflowStudio`. Node ≥ 22.12 (Vite 8's floor). Every command below runs **from `src/WorkflowStudio`** unless it says otherwise.
- **Pinned versions, exactly as listed in Task 1.** `package-lock.json` is committed; the container builds with `npm ci`.
- **Same origin only** (spec §2: BaseApi has no CORS). The browser calls relative URLs under `/api/v1/`. In dev, Vite proxies `/api` to `http://localhost:18080` (the RealStack port-forward). In the cluster, nginx proxies `/api/` to `http://baseapi-service:8080`.
- **Read-only slice.** This plan sends only `GET` requests. Blocks are not draggable, not connectable, not selectable. Editing is plan 3.
- **`model/` and `layout/` hold no React and no I/O** (spec §3.1). They import nothing from `canvas/`, `api/client.ts` or `app/`.
- **Geometry (spec §5.1, values verbatim):** grid step 8, cell 32; step 224 × 160; title cap 40 high; processor middle `PMID = 96`; ports 16 apart; processor substrate at (24, 56) size 176 × 80; straight-landing band step-local y 62..130; sphere radius 96; cache 192 × 64; column pitch 288. Every block coordinate is a multiple of 8; after an elkjs layout every step border is a multiple of 32; every wire point is a multiple of 8.
- **Colours (spec §5.3, mockup tokens):** Completed `#2DD4BF` (C), Failed `#FF7A66` (F), Cancelled `#F5B841` (X), Always `#B392F0` (A), Never `#F472B6` (N). Ground `#0A1220`. Accent `#7DD3FC`.
- **Entry conditions are integers on the wire:** 0 PreviousProcessing (invalid), 1 Completed, 2 Failed, 3 Cancelled, 4 Always, 5 Never. A wire's colour is its **target** step's condition.
- **Fonts:** IBM Plex Sans **Condensed** (400/500/600) and IBM Plex Mono (400/500), self-hosted through `@fontsource` (no Google CDN: the cluster may be offline). Label widths are measured with these fonts after `document.fonts.ready`.
- **Stale `Layout` ids are ignored silently** (spec §8). Any malformed part of a layout is ignored, never an error.
- **Test commands.** Unit tests: `npm test` (runs `vitest run`). Types: `npm run typecheck`. Production build: `npm run build`. A focused run: `npx vitest run src/layout/router.test.ts`. Vitest prints each failing test's name; a run that collects 0 tests is a failure, not a pass.
- **No backend code changes.** The only file outside `src/WorkflowStudio` and `k8s/` this plan adds is the dotnet tool manifest `.config/dotnet-tools.json`, plus one-line additions to `.gitignore`, `.dockerignore`, `k8s/kustomization.yaml`, `k8s/port-forward-realstack.ps1` and `k8s/README.md`.
- **Machine notes.** Windows; the Bash tool is Git Bash. Bash heredocs that contain apostrophes or backticks fail on this machine: write files with the Write tool. Stage only the files a task names (never `git add -A`). Untracked files that must not be touched: `.wf-restore.json`, `tools/simulate-approved-feed.py`, `tools/simulate-unapproved-feed.py`, `.playwright-mcp/`, `docs/HANDOVER-*.md`.

## Decisions taken while writing this plan (the user is told in the hand-off)

- **Font cut.** The spec says "IBM Plex Sans"; the approved mockup uses IBM Plex Sans **Condensed**, and every text width in it is tuned to the condensed cut. This plan uses Condensed.
- **Assignment badge.** The spec says the cap holds "the assignment keys"; the mockup shows a count, `◆ 3 keys` (or `◇ {}` for an empty object), because 224 px cannot hold key names. This plan follows the mockup. Key names are the Inspector's job (plan 4).
- **Junctions are plan 7.** Until then a step with ≥ 4 incoming wires draws them as separate arrows, still 16 px apart.
- **OpenAPI document.** BaseApi serves Swagger only in Development, and the cluster runs Production. The document is therefore produced offline from the built DLL with the Swashbuckle CLI and committed with the generated types.

## Review Focus

1. **A layout that names steps that no longer exist, or is not the shape we wrote** (an array, string coordinates, a parked id that 404s). Expected: the bad parts are ignored, the rest of the layout is used, and missing blocks get an elkjs position. Tests in Task 4 (`layoutDoc`) and Task 8 (`loadDocument`).
2. **A next-step id that points at no step** (a dangling wire, which the start gate reports as `missingStep`). Expected: that wire is not drawn and nothing throws. Test in Task 5.
3. **A back edge or a self-loop** (target left of, or equal to, the source). Expected: a U route around the blocks, orthogonal and on the 8 px grid, computed in bounded time. Test in Task 5.
4. **More wires into one step than its band holds** (fan-in of 8). Expected: landing search terminates, every arrival is ≥ 16 px from the others. Test in Task 5.
5. **Very long workflow, step, processor or schema names.** Expected: cut with an ellipsis to fit the shape, the full text in a tooltip, never overflowing. Tests in Task 7.

---

## File Structure

**New: `src/WorkflowStudio/`**

| File | Responsibility |
|---|---|
| `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `index.html` | Build, dev proxy, test runner |
| `scripts/gen-api.mjs` | Builds BaseApi, writes the OpenAPI document, generates TypeScript types |
| `openapi/baseapi.v1.json` | The committed OpenAPI snapshot |
| `src/main.tsx`, `src/App.tsx`, `src/app.css` | Entry, page shell (picker + status line + canvas) |
| `src/test/setup.ts` | jsdom shims React Flow needs |
| `src/api/schema.d.ts` | Generated by openapi-typescript (do not edit) |
| `src/api/types.ts` | Names for the generated DTO types |
| `src/api/client.ts` | `createApi()`: typed GETs and the error mapping |
| `src/api/toModel.ts` | DTO → `model/graph.ts` types |
| `src/model/graph.ts` | The domain types |
| `src/model/entryConditions.ts` | Names, letters, colours |
| `src/model/reachability.ts` | Steps reachable from the entry steps |
| `src/model/startChecks.ts` | First cycle / missing step, as the start gate finds it |
| `src/model/schemaEdges.ts` | The broken-wire rule |
| `src/model/assignments.ts` | One assignment per step, key count |
| `src/layout/geometry.ts` | Constants and snapping |
| `src/layout/layoutDoc.ts` | The `Layout` JSON document: parse leniently |
| `src/layout/placement.ts` | Stored positions, elkjs for the rest, parked row, caches |
| `src/layout/ports.ts` | Departures (fan-out) and landings |
| `src/layout/router.ts` | Straight / Z / U, cheapest wins |
| `src/layout/wires.ts` | Which wires exist, their points, colour, broken flag; cache tethers |
| `src/canvas/tokens.css`, `src/canvas/canvas.css` | Colour tokens, block and wire styles |
| `src/canvas/SvgDefs.tsx` | Every gradient and filter, defined once |
| `src/canvas/GridBackground.tsx` | The lit two-tier grid that follows the viewport |
| `src/canvas/fitText.ts` | Ellipsis fitting with a real-font measurer |
| `src/canvas/edges/CableEdge.tsx`, `src/canvas/edges/TetherEdge.tsx` | Wire drawing |
| `src/canvas/nodes/WorkflowNode.tsx`, `StepNode.tsx`, `Chip.tsx`, `CacheNode.tsx` | Block drawing |
| `src/canvas/toFlow.ts` | Document → React Flow nodes and edges (pure) |
| `src/canvas/WorkflowCanvas.tsx`, `src/canvas/Legend.tsx` | The React Flow surface and the legend |
| `src/app/loadDocument.ts` | Graph + parked steps + placement + wires |
| `Dockerfile`, `nginx.conf` | The container |

**New elsewhere:** `.config/dotnet-tools.json`, `k8s/31-workflow-studio.yaml`.

---

### Task 1: Scaffold `src/WorkflowStudio`

**Files:**
- Create: `src/WorkflowStudio/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/test/setup.ts`, `src/smoke.test.ts`
- Modify: `.gitignore` (root), `.dockerignore` (root)

**Interfaces:**
- Produces: `npm test`, `npm run typecheck`, `npm run build`, `npm run dev` (port 5173, `/api` proxied to `http://localhost:18080`); the jsdom shims in `src/test/setup.ts`.

- [ ] **Step 1: Create `package.json`**

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
    "gen:api": "node scripts/gen-api.mjs"
  },
  "dependencies": {
    "@fontsource/ibm-plex-mono": "5.3.0",
    "@fontsource/ibm-plex-sans-condensed": "5.3.0",
    "@xyflow/react": "12.12.0",
    "elkjs": "0.12.0",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "devDependencies": {
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

- [ ] **Step 2: Create `tsconfig.json`, `vite.config.ts` and `index.html`**

`tsconfig.json`:

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
  "include": ["src", "vite.config.ts"]
}
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The studio is same-origin with BaseApi (BaseApi has no CORS policy). In dev the proxy points at
// the RealStack port-forward; in the cluster nginx does the same job (nginx.conf).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:18080' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SKP Studio</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create the entry, a placeholder App and the test setup**

`src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`src/App.tsx` (Task 8 replaces it):

```tsx
export function App() {
  return <h1>SKP Studio</h1>;
}
```

`src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';

// React Flow measures with ResizeObserver, reads transforms through DOMMatrixReadOnly and sizes
// nodes from offsetWidth/offsetHeight. jsdom has none of them; these shims are the ones React
// Flow's own testing guide uses. Nodes in this app always carry explicit width and height, so the
// style-based sizes below are the real ones.
class ResizeObserverShim {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

class DOMMatrixReadOnlyShim {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}

globalThis.ResizeObserver = ResizeObserverShim as unknown as typeof ResizeObserver;
globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyShim as unknown as typeof DOMMatrixReadOnly;

Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { get() { return parseFloat((this as HTMLElement).style.height) || 1; } },
  offsetWidth: { get() { return parseFloat((this as HTMLElement).style.width) || 1; } },
});

(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
  ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
```

`src/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('test runner', () => {
  it('runs in jsdom with the React Flow shims', () => {
    expect(typeof window).toBe('object');
    expect(typeof ResizeObserver).toBe('function');
  });
});
```

- [ ] **Step 4: Ignore build output**

Append to the root `.gitignore`:

```
# SKP Studio build output
src/WorkflowStudio/dist/
```

Append to the root `.dockerignore`:

```
**/node_modules/
**/dist/
```

- [ ] **Step 5: Install and verify**

```bash
cd src/WorkflowStudio
npm install
npm test
npm run typecheck
npm run build
```

Expected: `npm install` writes `package-lock.json`; the smoke test reports 1 passed; typecheck prints nothing; the build writes `dist/index.html`.

- [ ] **Step 6: Commit**

```bash
git add .gitignore .dockerignore src/WorkflowStudio/package.json src/WorkflowStudio/package-lock.json src/WorkflowStudio/tsconfig.json src/WorkflowStudio/vite.config.ts src/WorkflowStudio/index.html src/WorkflowStudio/src
git commit -m "feat(studio): scaffold the WorkflowStudio app (Vite, React, TypeScript, Vitest)"
```

---

### Task 2: OpenAPI types, the API client and the domain model types

**Files:**
- Create: `.config/dotnet-tools.json`, `src/WorkflowStudio/scripts/gen-api.mjs`, `src/WorkflowStudio/openapi/baseapi.v1.json` (generated), `src/WorkflowStudio/src/api/schema.d.ts` (generated), `src/api/types.ts`, `src/api/client.ts`, `src/api/toModel.ts`, `src/model/graph.ts`
- Test: `src/api/client.test.ts`, `src/api/toModel.test.ts`, `src/api/fixtures.ts`

**Interfaces:**
- Consumes: Task 1's scaffold.
- Produces:
  - `model/graph.ts`: `type Id = string`; interfaces `Workflow`, `Step`, `Processor`, `Schema`, `Assignment`, `Cache`, `Graph` (exact fields below).
  - `api/types.ts`: `WorkflowGraphDto`, `WorkflowReadDto`, `StepReadDto`, `ProcessorReadDto`.
  - `api/client.ts`: `type ApiError`, `type ApiResult<T>`, `interface StudioApi { listWorkflows(); getGraph(id); getStep(id); getProcessor(id) }`, `createApi(base?: string, fetchImpl?: typeof fetch): StudioApi`.
  - `api/toModel.ts`: `graphFromDto(dto): Graph`, `stepFromDto(dto): Step`, `processorFromDto(dto): Processor`.
  - `api/fixtures.ts` (tests only): `graphDto(...)`, `stepDto(...)`, `processorDto(...)` builders, reused by later tasks' tests.

- [ ] **Step 1: Add the Swashbuckle CLI as a local dotnet tool**

Create `.config/dotnet-tools.json` (repo root):

```json
{
  "version": 1,
  "isRoot": true,
  "tools": {
    "swashbuckle.aspnetcore.cli": {
      "version": "6.9.0",
      "commands": ["swagger"]
    }
  }
}
```

The CLI version must equal the `Swashbuckle.AspNetCore` version in `Directory.Packages.props` (6.9.0).

- [ ] **Step 2: Write the generator script**

`src/WorkflowStudio/scripts/gen-api.mjs`:

```js
// Regenerates the BaseApi OpenAPI snapshot and the TypeScript types the studio compiles against.
//
// Why offline: BaseApi serves /swagger only in Development, and the cluster runs Production. The
// Swashbuckle CLI loads the built assembly, builds the host's service provider without starting
// it, and writes the same document Swagger would serve.
//
// Run from src/WorkflowStudio: npm run gen:api
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = path.resolve(here, '..');
const repo = path.resolve(studio, '..', '..');
const project = path.join(repo, 'src', 'BaseApi.Service', 'BaseApi.Service.csproj');
const dll = path.join(repo, 'src', 'BaseApi.Service', 'bin', 'Debug', 'net8.0', 'BaseApi.Service.dll');
const doc = path.join(studio, 'openapi', 'baseapi.v1.json');
const types = path.join(studio, 'src', 'api', 'schema.d.ts');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

run('dotnet', ['tool', 'restore'], repo);
run('dotnet', ['build', project, '-c', 'Debug', '--nologo'], repo);
run('dotnet', ['swagger', 'tofile', '--output', doc, dll, 'v1'], repo);
run('npx', ['openapi-typescript', doc, '-o', types], studio);
```

- [ ] **Step 3: Generate**

```bash
cd src/WorkflowStudio
npm run gen:api
```

Expected: `openapi/baseapi.v1.json` and `src/api/schema.d.ts` exist. Open the JSON and confirm it contains `"/api/v1/workflows/{id}/graph"` and a component schema named `WorkflowGraphDto`. Swashbuckle names component schemas after the C# class; if the names differ (for example a namespace prefix), use the generated names in Step 4 and say so in the report.

If `swagger tofile` fails because the host cannot be built outside the cluster (a missing configuration value thrown at service registration), set `ASPNETCORE_ENVIRONMENT=Development` for the command and retry. If it still fails, stop and report BLOCKED with the error: do not hand-write the OpenAPI document.

- [ ] **Step 4: Name the DTO types and define the domain model**

`src/api/types.ts`:

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
```

`src/model/graph.ts`:

```ts
/**
 * The graph as the studio reasons about it. Plain data: no React, no I/O.
 *
 * Steps belong to no workflow (spec §2): a workflow names its entry steps, and its step set is
 * whatever is reachable over `nextStepIds`. A wire is a `nextStepIds` entry on its source step.
 */
export type Id = string;

export interface Workflow {
  id: Id;
  name: string;
  version: string;
  cronExpression: string | null;
  entryStepIds: Id[];
  assignmentIds: Id[];
  cacheIds: Id[];
  updatedAt: string;
}

export interface Step {
  id: Id;
  name: string;
  version: string;
  processorId: Id;
  nextStepIds: Id[];
  /** 0..5 on the wire; see model/entryConditions.ts. 0 is invalid but can still arrive. */
  entryCondition: number;
  updatedAt: string;
}

export interface Processor {
  id: Id;
  name: string;
  version: string;
  inputSchemaId: Id | null;
  outputSchemaId: Id | null;
  configSchemaId: Id | null;
}

export interface Schema {
  id: Id;
  name: string;
  version: string;
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
  root: string;
  /** JSON text of an object of string items. */
  items: string;
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

- [ ] **Step 5: Write the test fixtures and the failing tests**

`src/api/fixtures.ts`:

```ts
import type { ProcessorReadDto, StepReadDto, WorkflowGraphDto, WorkflowReadDto } from './types';

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

`src/api/toModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { graphDto, processorDto, stepDto, workflowDto } from './fixtures';
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

describe('stepFromDto', () => {
  it('rejects a DTO without an id, because nothing downstream can key it', () => {
    expect(() => stepFromDto(stepDto('', { id: undefined } as never))).toThrow(/id/);
  });
});
```

`src/api/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createApi } from './client';

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

describe('createApi', () => {
  it('GETs the graph from the same origin and returns it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, { workflow: { id: 'wf1' } }));
    const api = createApi('/api/v1', fetchImpl);

    const result = await api.getGraph('wf1');

    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/workflows/wf1/graph', expect.objectContaining({ method: 'GET' }));
    expect(result).toEqual({ ok: true, value: { workflow: { id: 'wf1' } } });
  });

  it('lists workflows from the bare array the server returns', async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(respond(200, [{ id: 'wf1' }])));
    expect(await api.listWorkflows()).toEqual({ ok: true, value: [{ id: 'wf1' }] });
  });

  it('maps 404 to notFound', async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(respond(404, { title: 'Not Found' })));
    expect(await api.getStep('s1')).toEqual({ ok: false, error: { kind: 'notFound', status: 404 } });
  });

  it('maps a stale-graph 409 and keeps the entity it names', async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(
      respond(409, { title: 'Graph is stale', detail: 'The step was changed.', kind: 'step', id: 's9' })));

    expect(await api.getGraph('wf1')).toEqual({
      ok: false,
      error: { kind: 'conflict', status: 409, detail: 'The step was changed.', entity: { kind: 'step', id: 's9' } },
    });
  });

  it('maps 422 and other statuses with the problem detail, falling back to the title', async () => {
    const api422 = createApi('/api/v1', vi.fn().mockResolvedValue(respond(422, { title: 'Unprocessable Entity' })));
    const api500 = createApi('/api/v1', vi.fn().mockResolvedValue(respond(500, { title: 'Boom', detail: 'db down' })));

    expect(await api422.getGraph('wf1')).toEqual({ ok: false, error: { kind: 'unprocessable', status: 422, detail: 'Unprocessable Entity' } });
    expect(await api500.getGraph('wf1')).toEqual({ ok: false, error: { kind: 'http', status: 500, detail: 'db down' } });
  });

  it('maps a thrown fetch to a network error', async () => {
    const api = createApi('/api/v1', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await api.getGraph('wf1')).toEqual({ ok: false, error: { kind: 'network', message: 'Failed to fetch' } });
  });

  it('escapes the id in the path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, {}));
    await createApi('/api/v1', fetchImpl).getProcessor('a/b');
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/processors/a%2Fb', expect.anything());
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run src/api`
Expected: FAIL, `Failed to resolve import "./toModel"` and `"./client"`.

- [ ] **Step 7: Implement the client and the conversion**

`src/api/client.ts`:

```ts
import type { ProcessorReadDto, StepReadDto, WorkflowGraphDto, WorkflowReadDto } from './types';

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
  async function get<T>(path: string): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, { method: 'GET', headers: { Accept: 'application/json' } });
    } catch (e) {
      return { ok: false, error: { kind: 'network', message: e instanceof Error ? e.message : String(e) } };
    }
    if (!response.ok) return { ok: false, error: await toError(response) };
    return { ok: true, value: (await response.json()) as T };
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    listWorkflows: () => get<WorkflowReadDto[]>('/workflows'),
    getGraph: (workflowId) => get<WorkflowGraphDto>(`/workflows/${id(workflowId)}/graph`),
    getStep: (stepId) => get<StepReadDto>(`/steps/${id(stepId)}`),
    getProcessor: (processorId) => get<ProcessorReadDto>(`/processors/${id(processorId)}`),
  };
}
```

`src/api/toModel.ts`:

```ts
import type { Assignment, Cache, Graph, Processor, Schema, Step, Workflow } from '../model/graph';
import type { ProcessorReadDto, StepReadDto, WorkflowGraphDto, WorkflowReadDto } from './types';

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

export function workflowFromDto(dto: WorkflowReadDto): Workflow {
  return {
    id: required(dto.id, 'workflow id'),
    name: text(dto.name),
    version: text(dto.version),
    cronExpression: optional(dto.cronExpression),
    entryStepIds: list(dto.entryStepIds),
    assignmentIds: list(dto.assignmentIds),
    cacheIds: list(dto.cacheIds),
    updatedAt: text(dto.updatedAt),
  };
}

export function stepFromDto(dto: StepReadDto): Step {
  return {
    id: required(dto.id, 'step id'),
    name: text(dto.name),
    version: text(dto.version),
    processorId: text(dto.processorId),
    nextStepIds: list(dto.nextStepIds),
    entryCondition: typeof dto.entryCondition === 'number' ? dto.entryCondition : 0,
    updatedAt: text(dto.updatedAt),
  };
}

export function processorFromDto(dto: ProcessorReadDto): Processor {
  return {
    id: required(dto.id, 'processor id'),
    name: text(dto.name),
    version: text(dto.version),
    inputSchemaId: optional(dto.inputSchemaId),
    outputSchemaId: optional(dto.outputSchemaId),
    configSchemaId: optional(dto.configSchemaId),
  };
}

export function graphFromDto(dto: WorkflowGraphDto): Graph {
  const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((item) => [item.id, item]));

  const schemas: Schema[] = (dto.schemas ?? []).map((s) => ({
    id: required(s.id, 'schema id'), name: text(s.name), version: text(s.version),
  }));
  const assignments: Assignment[] = (dto.assignments ?? []).map((a) => ({
    id: required(a.id, 'assignment id'), stepId: text(a.stepId), payload: text(a.payload),
  }));
  const caches: Cache[] = (dto.caches ?? []).map((c) => ({
    id: required(c.id, 'cache id'), name: text(c.name), root: text(c.root), items: text(c.items),
  }));

  if (!dto.workflow) throw new Error('The server sent no workflow.');

  return {
    workflow: workflowFromDto(dto.workflow),
    steps: byId((dto.steps ?? []).map(stepFromDto)),
    processors: byId((dto.processors ?? []).map(processorFromDto)),
    schemas: byId(schemas),
    assignments,
    caches: byId(caches),
    layout: dto.layout ?? null,
  };
}
```

If the generated types make a field this file reads unknown to TypeScript (for example `entryCondition` typed as a string union), adjust only the reading expression and keep the model types unchanged; note it in the report.

- [ ] **Step 8: Run the tests and the typecheck**

```bash
npx vitest run src/api
npm run typecheck
```

Expected: 11 passed (4 conversion + 7 client); typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add .config/dotnet-tools.json src/WorkflowStudio/scripts src/WorkflowStudio/openapi src/WorkflowStudio/src/api src/WorkflowStudio/src/model/graph.ts
git commit -m "feat(studio): generated BaseApi types, typed GET client and the graph model"
```

---

### Task 3: `model/` rules mirroring the backend

**Files:**
- Create: `src/model/entryConditions.ts`, `src/model/reachability.ts`, `src/model/startChecks.ts`, `src/model/schemaEdges.ts`, `src/model/assignments.ts`
- Test: one `*.test.ts` beside each

**Interfaces:**
- Consumes: `Id`, `Step`, `Processor`, `Assignment` (Task 2).
- Produces:
  - `entryConditions.ts`: `interface ConditionInfo { name: string; letter: string; colour: string }`, `conditionInfo(condition: number): ConditionInfo`, `CONDITIONS: ReadonlyArray<{ value: number } & ConditionInfo>` (1..5 in order).
  - `reachability.ts`: `reachableStepIds(entryStepIds: Id[], steps: ReadonlyMap<Id, Pick<Step, 'nextStepIds'>>): Id[]`.
  - `startChecks.ts`: `type StartProblem`, `findStartProblem(entryStepIds, steps): StartProblem | null`.
  - `schemaEdges.ts`: `isBrokenEdge(parent: Processor | undefined, child: Processor | undefined): boolean`.
  - `assignments.ts`: `assignmentByStep(assignments: Assignment[]): Map<Id, Assignment>`, `payloadKeyCount(payload: string): number | null`.

The backend has no unit tests for `CycleDetector` or `SchemaEdgeValidator`; the cases below are derived from their code (`src/BaseApi.Service/Features/Orchestration/Validation/CycleDetector.cs`, `SchemaEdgeValidator.cs`) and from `WorkflowGraphLoader`'s BFS.

- [ ] **Step 1: Write the failing tests**

`src/model/entryConditions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CONDITIONS, conditionInfo } from './entryConditions';

describe('entry conditions', () => {
  it.each([
    [1, 'Completed', 'C', '#2DD4BF'],
    [2, 'Failed', 'F', '#FF7A66'],
    [3, 'Cancelled', 'X', '#F5B841'],
    [4, 'Always', 'A', '#B392F0'],
    [5, 'Never', 'N', '#F472B6'],
  ])('%i is %s, letter %s, colour %s', (value, name, letter, colour) => {
    expect(conditionInfo(value)).toEqual({ name, letter, colour });
  });

  it('shows 0 (rejected by the validators) and unknown values as invalid rather than throwing', () => {
    expect(conditionInfo(0).name).toBe('Invalid');
    expect(conditionInfo(99).letter).toBe('?');
  });

  it('lists the five valid conditions in wire order for the legend', () => {
    expect(CONDITIONS.map((c) => c.value)).toEqual([1, 2, 3, 4, 5]);
  });
});
```

`src/model/reachability.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { reachableStepIds } from './reachability';

const steps = (edges: Record<string, string[]>) =>
  new Map(Object.entries(edges).map(([id, next]) => [id, { nextStepIds: next }]));

describe('reachableStepIds (WorkflowGraphLoader BFS)', () => {
  it('walks breadth first from the entry steps', () => {
    expect(reachableStepIds(['a'], steps({ a: ['b', 'c'], b: ['d'], c: [], d: [] }))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('visits a step reached twice once (diamond, fan-in)', () => {
    expect(reachableStepIds(['a'], steps({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] }))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('terminates on a cycle and includes the steps on it', () => {
    expect(reachableStepIds(['a'], steps({ a: ['b'], b: ['a'] }))).toEqual(['a', 'b']);
  });

  it('skips ids that name no step, and leaves out steps nothing reaches', () => {
    expect(reachableStepIds(['a', 'ghost'], steps({ a: ['missing'], parked: [] }))).toEqual(['a']);
  });

  it('dedupes repeated entry ids', () => {
    expect(reachableStepIds(['a', 'a'], steps({ a: [] }))).toEqual(['a']);
  });
});
```

`src/model/startChecks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findStartProblem } from './startChecks';

const steps = (edges: Record<string, string[]>) =>
  new Map(Object.entries(edges).map(([id, next]) => [id, { nextStepIds: next }]));

describe('findStartProblem (CycleDetector)', () => {
  it('passes a chain, a diamond and a fan-in', () => {
    expect(findStartProblem(['a'], steps({ a: ['b'], b: ['c'], c: [] }))).toBeNull();
    expect(findStartProblem(['a'], steps({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] }))).toBeNull();
    expect(findStartProblem(['a', 'b'], steps({ a: ['c'], b: ['c'], c: [] }))).toBeNull();
  });

  it('reports a self-loop as the chain [A, A]', () => {
    expect(findStartProblem(['a'], steps({ a: ['a'] }))).toEqual({ gate: 'cycle', stepChain: ['a', 'a'] });
  });

  it('reports a cycle as the path from the repeated step back to itself', () => {
    expect(findStartProblem(['a'], steps({ a: ['b'], b: ['c'], c: ['b'] }))).toEqual({ gate: 'cycle', stepChain: ['b', 'c', 'b'] });
  });

  it('reports a missing child with its parent', () => {
    expect(findStartProblem(['a'], steps({ a: ['ghost'] }))).toEqual({ gate: 'missingStep', parentStepId: 'a', missingChildId: 'ghost' });
  });

  it('reports a missing entry step with no parent', () => {
    expect(findStartProblem(['ghost'], steps({}))).toEqual({ gate: 'missingStep', parentStepId: null, missingChildId: 'ghost' });
  });

  it('finds problems in DFS order: children in nextStepIds order, first found wins', () => {
    const graph = steps({ a: ['b', 'c'], b: ['ghost'], c: ['c'] });
    expect(findStartProblem(['a'], graph)).toEqual({ gate: 'missingStep', parentStepId: 'b', missingChildId: 'ghost' });
  });

  it('does not visit steps nothing reaches from an entry', () => {
    expect(findStartProblem(['a'], steps({ a: [], orphan: ['orphan'] }))).toBeNull();
  });
});
```

`src/model/schemaEdges.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Processor } from './graph';
import { isBrokenEdge } from './schemaEdges';

const proc = (inputSchemaId: string | null, outputSchemaId: string | null): Processor => ({
  id: 'p', name: 'p', version: '1.0.0', inputSchemaId, outputSchemaId, configSchemaId: null,
});

describe('isBrokenEdge (SchemaEdgeValidator)', () => {
  it('passes when the parent Out schema id equals the child In schema id', () => {
    expect(isBrokenEdge(proc(null, 's1'), proc('s1', null))).toBe(false);
  });

  it('breaks when both are set and differ, compared by id', () => {
    expect(isBrokenEdge(proc(null, 's1'), proc('s2', null))).toBe(true);
  });

  it('passes when either side is null', () => {
    expect(isBrokenEdge(proc(null, null), proc('s2', null))).toBe(false);
    expect(isBrokenEdge(proc(null, 's1'), proc(null, null))).toBe(false);
  });

  it('passes when a processor is unknown (the validator reads its schema as null)', () => {
    expect(isBrokenEdge(undefined, proc('s2', null))).toBe(false);
  });
});
```

`src/model/assignments.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assignmentByStep, payloadKeyCount } from './assignments';

describe('assignmentByStep', () => {
  it('keeps one assignment per step: the smallest id, as the graph saver does', () => {
    const map = assignmentByStep([
      { id: 'bbbb', stepId: 's1', payload: '{}' },
      { id: 'aaaa', stepId: 's1', payload: '{"k":1}' },
      { id: 'cccc', stepId: 's2', payload: '{}' },
    ]);
    expect(map.get('s1')!.id).toBe('aaaa');
    expect(map.get('s2')!.id).toBe('cccc');
  });

  it('compares ids case-insensitively, as Postgres compares uuids', () => {
    const map = assignmentByStep([
      { id: 'B000', stepId: 's1', payload: '{}' },
      { id: 'a000', stepId: 's1', payload: '{}' },
    ]);
    expect(map.get('s1')!.id).toBe('a000');
  });
});

describe('payloadKeyCount', () => {
  it('counts the top-level keys of an object payload', () => {
    expect(payloadKeyCount('{"a":1,"b":{"c":2}}')).toBe(2);
    expect(payloadKeyCount('{}')).toBe(0);
  });

  it('returns null for invalid JSON or a payload that is not an object', () => {
    expect(payloadKeyCount('{nope')).toBeNull();
    expect(payloadKeyCount('[1,2]')).toBeNull();
    expect(payloadKeyCount('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/model`
Expected: FAIL, the five modules cannot be resolved.

- [ ] **Step 3: Implement the five modules**

`src/model/entryConditions.ts`:

```ts
/** A step's entry condition, as drawn: the wire colour into it and the letter on its pill. */
export interface ConditionInfo {
  name: string;
  letter: string;
  colour: string;
}

// Values are the stored wire integers (StepEntryCondition.cs) and must not change.
const TABLE: Record<number, ConditionInfo> = {
  1: { name: 'Completed', letter: 'C', colour: '#2DD4BF' },
  2: { name: 'Failed', letter: 'F', colour: '#FF7A66' },
  3: { name: 'Cancelled', letter: 'X', colour: '#F5B841' },
  4: { name: 'Always', letter: 'A', colour: '#B392F0' },
  5: { name: 'Never', letter: 'N', colour: '#F472B6' },
};

// 0 (PreviousProcessing) is rejected by both step validators, but the editor never blocks a
// design, so it is drawn as invalid instead of throwing.
const INVALID: ConditionInfo = { name: 'Invalid', letter: '?', colour: '#5A6B86' };

export function conditionInfo(condition: number): ConditionInfo {
  return TABLE[condition] ?? INVALID;
}

export const CONDITIONS: ReadonlyArray<{ value: number } & ConditionInfo> =
  [1, 2, 3, 4, 5].map((value) => ({ value, ...TABLE[value]! }));
```

`src/model/reachability.ts`:

```ts
import type { Id, Step } from './graph';

/**
 * The step set a workflow start sees: breadth first from the entry steps over nextStepIds, each
 * step once, ids that name no step skipped. Mirrors WorkflowGraphLoader.LoadL1Async, so the order
 * is BFS wave order.
 */
export function reachableStepIds(entryStepIds: Id[], steps: ReadonlyMap<Id, Pick<Step, 'nextStepIds'>>): Id[] {
  const seen = new Set<Id>();
  const order: Id[] = [];
  let wave = entryStepIds.filter((id) => steps.has(id));

  while (wave.length > 0) {
    const next: Id[] = [];
    for (const id of wave) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      for (const child of steps.get(id)!.nextStepIds) {
        if (steps.has(child) && !seen.has(child)) next.push(child);
      }
    }
    wave = next;
  }

  return order;
}
```

`src/model/startChecks.ts`:

```ts
import type { Id, Step } from './graph';

/**
 * The first structural problem the start gate would refuse, found in the gate's own order
 * (CycleDetector.cs): depth first from each entry step, children in nextStepIds order. The backend
 * uses Guid.Empty for "no parent" on a missing entry step; here it is null.
 */
export type StartProblem =
  | { gate: 'cycle'; stepChain: Id[] }
  | { gate: 'missingStep'; parentStepId: Id | null; missingChildId: Id };

export function findStartProblem(
  entryStepIds: Id[],
  steps: ReadonlyMap<Id, Pick<Step, 'nextStepIds'>>,
): StartProblem | null {
  const done = new Set<Id>();
  const onPath = new Set<Id>();
  const path: Id[] = [];

  const visit = (id: Id): StartProblem | null => {
    onPath.add(id);
    path.push(id);
    for (const child of steps.get(id)!.nextStepIds) {
      if (!steps.has(child)) return { gate: 'missingStep', parentStepId: id, missingChildId: child };
      if (onPath.has(child)) return { gate: 'cycle', stepChain: [...path.slice(path.indexOf(child)), child] };
      if (done.has(child)) continue; // a diamond or a fan-in is legal
      const problem = visit(child);
      if (problem) return problem;
    }
    onPath.delete(id);
    path.pop();
    done.add(id);
    return null;
  };

  for (const entry of entryStepIds) {
    if (!steps.has(entry)) return { gate: 'missingStep', parentStepId: null, missingChildId: entry };
    if (done.has(entry)) continue;
    const problem = visit(entry);
    if (problem) return problem;
  }
  return null;
}
```

`src/model/schemaEdges.ts`:

```ts
import type { Processor } from './graph';

/**
 * The start gate's SchemaEdgeValidator rule: the parent processor's Out schema must be the child
 * processor's In schema, compared by id. A null on either side passes, and so does an unknown
 * processor (the validator reads its schema as null). A broken wire is drawn dashed with a "!".
 */
export function isBrokenEdge(parent: Processor | undefined, child: Processor | undefined): boolean {
  const out = parent?.outputSchemaId ?? null;
  const input = child?.inputSchemaId ?? null;
  return out !== null && input !== null && out !== input;
}
```

`src/model/assignments.ts`:

```ts
import type { Assignment, Id } from './graph';

/**
 * At most one assignment applies per (workflow, step) (spec §2). Legacy data can hold more; the
 * graph saver keeps the smallest id, so the studio shows that one. Postgres orders uuids by their
 * bytes, which is the order of their lower-case hex text.
 */
export function assignmentByStep(assignments: Assignment[]): Map<Id, Assignment> {
  const byStep = new Map<Id, Assignment>();
  for (const a of assignments) {
    const current = byStep.get(a.stepId);
    if (!current || a.id.toLowerCase() < current.id.toLowerCase()) byStep.set(a.stepId, a);
  }
  return byStep;
}

/** The number of top-level keys in an object payload, or null when it is not a JSON object. */
export function payloadKeyCount(payload: string): number | null {
  try {
    const value: unknown = JSON.parse(payload);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/model
npm run typecheck
```

Expected: 27 passed (entryConditions 7, the `it.each` counting 5; reachability 5; startChecks 7; schemaEdges 4; assignments 4); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/WorkflowStudio/src/model
git commit -m "feat(studio): model rules mirroring reachability, start checks, schema edges and assignment choice"
```

---

### Task 4: `layout/`: geometry, the `Layout` document and placement

**Files:**
- Create: `src/layout/geometry.ts`, `src/layout/layoutDoc.ts`, `src/layout/placement.ts`
- Test: `src/layout/layoutDoc.test.ts`, `src/layout/placement.test.ts`

**Interfaces:**
- Consumes: `Id` (Task 2).
- Produces:
  - `geometry.ts`: constants `GRID = 8`, `CELL = 32`, `STEP_W = 224`, `STEP_H = 160`, `CAP_H = 40`, `PMID = 96`, `PORT_GAP = 16`, `CHIP = { x: 24, y: 56, w: 176, h: 80 }`, `BAND_TOP = 62`, `BAND_BOTTOM = 130`, `SPHERE_R = 96`, `CACHE_W = 192`, `CACHE_H = 64`, `COLUMN_PITCH = 288`; `snap(v: number, step = GRID): number`; `offset(k: number, n: number, gap: number): number`; `interface Point { x: number; y: number }`.
  - `layoutDoc.ts`: `interface LayoutDoc { sphere: Point | null; steps: Record<Id, Point>; caches: Record<Id, Point>; parked: Id[] }`, `parseLayout(raw: unknown): LayoutDoc`, `EMPTY_LAYOUT`.
  - `placement.ts`: `interface Sphere { cx: number; cy: number }`, `interface Placement { sphere: Sphere; steps: Map<Id, Point>; caches: Map<Id, Point> }`, `interface PlacementInput { entryStepIds: Id[]; reachable: { id: Id; nextStepIds: Id[] }[]; parkedIds: Id[]; cacheIds: Id[]; layout: LayoutDoc }`, `place(input: PlacementInput): Promise<Placement>`.

**The `Layout` document (version 1).** Positions only, never graph facts (spec §4.3). Plan 3 adds `wires`, plan 7 adds `junctions`; both are optional keys, so a version-1 reader ignores them.

```json
{
  "v": 1,
  "sphere": { "x": 128, "y": 128 },
  "steps":  { "<stepId>": { "x": 288, "y": 32 } },
  "caches": { "<cacheId>": { "x": 32, "y": 288 } },
  "parked": ["<stepId>"]
}
```

`sphere` is the sphere's **centre**; `steps` and `caches` are top-left corners; `parked` lists steps placed on the canvas but not wired in (their positions are in `steps`).

- [ ] **Step 1: Write the failing tests**

`src/layout/layoutDoc.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_LAYOUT, parseLayout } from './layoutDoc';

describe('parseLayout', () => {
  it('reads a version-1 document', () => {
    expect(parseLayout({
      v: 1, sphere: { x: 128, y: 128 }, steps: { s1: { x: 288, y: 32 } }, caches: { c1: { x: 32, y: 288 } }, parked: ['s2'],
    })).toEqual({ sphere: { x: 128, y: 128 }, steps: { s1: { x: 288, y: 32 } }, caches: { c1: { x: 32, y: 288 } }, parked: ['s2'] });
  });

  it.each([null, undefined, 42, 'text', [1, 2], true])('treats %j as an empty layout', (raw) => {
    expect(parseLayout(raw)).toEqual(EMPTY_LAYOUT);
  });

  it('ignores entries whose coordinates are not finite numbers, keeping the rest', () => {
    const doc = parseLayout({
      sphere: { x: '1', y: 2 },
      steps: { ok: { x: 8, y: 16 }, str: { x: '8', y: 16 }, nan: { x: Number.NaN, y: 0 }, inf: { x: Infinity, y: 0 }, arr: [1, 2], nul: null },
    });
    expect(doc.sphere).toBeNull();
    expect(doc.steps).toEqual({ ok: { x: 8, y: 16 } });
  });

  it('keeps unknown keys out and ignores parked entries that are not non-empty strings, deduped', () => {
    const doc = parseLayout({ parked: ['a', 7, '', 'a', null, 'b'], wires: { x: 1 } });
    expect(doc.parked).toEqual(['a', 'b']);
    expect(Object.keys(doc)).toEqual(['sphere', 'steps', 'caches', 'parked']);
  });
});
```

`src/layout/placement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CELL, GRID, STEP_H, STEP_W } from './geometry';
import { EMPTY_LAYOUT, type LayoutDoc } from './layoutDoc';
import { place, type PlacementInput } from './placement';

const input = (over: Partial<PlacementInput> = {}): PlacementInput => ({
  entryStepIds: ['a'],
  reachable: [{ id: 'a', nextStepIds: ['b'] }, { id: 'b', nextStepIds: [] }],
  parkedIds: [],
  cacheIds: [],
  layout: EMPTY_LAYOUT,
  ...over,
});

const layout = (over: Partial<LayoutDoc>): LayoutDoc => ({ ...EMPTY_LAYOUT, ...over });

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x < b.x + STEP_W && b.x < a.x + STEP_W && a.y < b.y + STEP_H && b.y < a.y + STEP_H;
}

describe('place', () => {
  it('lays out a never-laid-out chain in columns 288 apart with the sphere one column left', async () => {
    const p = await place(input());

    expect(p.steps.get('a')!.x).toBe(288);
    expect(p.steps.get('b')!.x).toBe(576);
    expect(p.sphere.cx).toBe(128);
    // spec §9: after layout every step border lies on a 32 px line
    for (const pos of p.steps.values()) {
      expect(pos.x % CELL).toBe(0);
      expect(pos.y % CELL).toBe(0);
    }
  });

  it('centres the sphere on its entry steps, so a single entry wire runs straight', async () => {
    const p = await place(input());
    expect(p.sphere.cy).toBe(p.steps.get('a')!.y + 96);
  });

  it('keeps stored positions, snapped to the 8 px grid', async () => {
    const p = await place(input({
      layout: layout({ sphere: { x: 131, y: 125 }, steps: { a: { x: 291, y: 37 }, b: { x: 600, y: 300 } } }),
    }));

    expect(p.steps.get('a')).toEqual({ x: 288, y: 40 });
    expect(p.steps.get('b')).toEqual({ x: 600, y: 304 }); // 300 / 8 = 37.5 rounds up
    expect(p.sphere).toEqual({ cx: 128, cy: 128 });
  });

  it('places a block with no stored position below the stored ones, without overlap', async () => {
    const p = await place(input({ layout: layout({ sphere: { x: 128, y: 128 }, steps: { a: { x: 288, y: 32 } } }) }));

    const a = p.steps.get('a')!, b = p.steps.get('b')!;
    expect(a).toEqual({ x: 288, y: 32 });
    expect(b.y).toBeGreaterThanOrEqual(a.y + STEP_H + 64);
    expect(b.x % GRID).toBe(0);
  });

  it('puts parked steps without a position in a row below everything', async () => {
    const p = await place(input({ parkedIds: ['p1', 'p2'] }));

    const all = [...p.steps.entries()];
    const p1 = p.steps.get('p1')!, p2 = p.steps.get('p2')!;
    const lowestWired = Math.max(p.steps.get('a')!.y, p.steps.get('b')!.y);
    expect(p1.y).toBeGreaterThan(lowestWired);
    expect(p1.y).toBe(p2.y);
    for (const [i, pi] of all) for (const [j, pj] of all) if (i < j) expect(overlaps(pi, pj)).toBe(false);
  });

  it('stacks caches under the sphere unless they have a stored position', async () => {
    const p = await place(input({
      cacheIds: ['c1', 'c2', 'c3'],
      layout: layout({ caches: { c3: { x: 1000, y: 1000 } } }),
    }));
    const { cx, cy } = p.sphere;

    expect(p.caches.get('c1')).toEqual({ x: cx - 96, y: cy + 96 + 64 });
    expect(p.caches.get('c2')).toEqual({ x: cx - 96, y: cy + 96 + 64 + 96 });
    expect(p.caches.get('c3')).toEqual({ x: 1000, y: 1000 });
  });

  it('ignores stored positions of steps that are not on the canvas', async () => {
    const p = await place(input({ layout: layout({ steps: { gone: { x: 8, y: 8 } } }) }));
    expect(p.steps.has('gone')).toBe(false);
  });

  it('handles a workflow whose only entry id names no step', async () => {
    const p = await place(input({ entryStepIds: ['ghost'], reachable: [] }));
    expect(p.steps.size).toBe(0);
    expect(p.sphere).toEqual({ cx: 128, cy: 128 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/layout`
Expected: FAIL, the modules cannot be resolved.

- [ ] **Step 3: Implement geometry and the document parser**

`src/layout/geometry.ts`:

```ts
/**
 * The grid geometry of spec §5.1. Everything sits on the 8 px grid; a step is 7 × 5 cells of 32 px;
 * its processor middle is 96 (3 cells down), so ports and arrows run along a 32 px line.
 */
export const GRID = 8;
export const CELL = 32;

export const STEP_W = 224;
export const STEP_H = 160;
export const CAP_H = 40;

/** The processor middle, step-local: every port is anchored here, not on the step's middle. */
export const PMID = 96;
export const PORT_GAP = 16;

/** The processor substrate inside a step, step-local. */
export const CHIP = { x: 24, y: 56, w: 176, h: 80 } as const;

/** A wire may land straight anywhere in this band (step-local y, inclusive). */
export const BAND_TOP = 62;
export const BAND_BOTTOM = 130;

export const SPHERE_R = 96;
export const CACHE_W = 192;
export const CACHE_H = 64;
export const COLUMN_PITCH = 288;

export interface Point {
  x: number;
  y: number;
}

export const snap = (v: number, step: number = GRID): number => Math.round(v / step) * step;

/** The k-th of n evenly spaced offsets `gap` apart, centred on zero. */
export const offset = (k: number, n: number, gap: number): number => (k - (n - 1) / 2) * gap;
```

`src/layout/layoutDoc.ts`:

```ts
import type { Id } from '../model/graph';
import type { Point } from './geometry';

/**
 * The workflow's stored canvas layout (the `Layout` column), version 1: positions only, never graph
 * facts (spec §4.3). The tables decide what exists; an id in here that no longer exists is ignored by
 * the caller, and any part that is not the shape below is ignored here. Nothing in a layout is ever
 * an error.
 */
export interface LayoutDoc {
  /** The sphere's centre. */
  sphere: Point | null;
  /** Top-left corners of steps, parked ones included. */
  steps: Record<Id, Point>;
  /** Top-left corners of cache tags. */
  caches: Record<Id, Point>;
  /** Steps placed on the canvas but not wired in. */
  parked: Id[];
}

export const EMPTY_LAYOUT: LayoutDoc = Object.freeze({ sphere: null, steps: {}, caches: {}, parked: [] }) as LayoutDoc;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function toPoint(v: unknown): Point | null {
  if (!isRecord(v)) return null;
  const { x, y } = v;
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) ? { x, y } : null;
}

function toPoints(v: unknown): Record<Id, Point> {
  const out: Record<Id, Point> = {};
  if (!isRecord(v)) return out;
  for (const [id, raw] of Object.entries(v)) {
    const point = toPoint(raw);
    if (point) out[id] = point;
  }
  return out;
}

export function parseLayout(raw: unknown): LayoutDoc {
  if (!isRecord(raw)) return EMPTY_LAYOUT;
  const parked = Array.isArray(raw.parked)
    ? [...new Set(raw.parked.filter((id): id is string => typeof id === 'string' && id !== ''))]
    : [];
  return { sphere: toPoint(raw.sphere), steps: toPoints(raw.steps), caches: toPoints(raw.caches), parked };
}
```

- [ ] **Step 4: Implement placement**

`src/layout/placement.ts`:

```ts
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Id } from '../model/graph';
import { CACHE_H, CELL, COLUMN_PITCH, PMID, SPHERE_R, STEP_H, STEP_W, snap, type Point } from './geometry';
import type { LayoutDoc } from './layoutDoc';

export interface Sphere {
  cx: number;
  cy: number;
}

export interface Placement {
  sphere: Sphere;
  /** Top-left corners of every step on the canvas, parked ones included. */
  steps: Map<Id, Point>;
  /** Top-left corners of cache tags. */
  caches: Map<Id, Point>;
}

export interface PlacementInput {
  entryStepIds: Id[];
  /** The workflow's steps (reachable from the entry steps), with their wires. */
  reachable: { id: Id; nextStepIds: Id[] }[];
  /** Parked steps the layout lists and the server still has. */
  parkedIds: Id[];
  cacheIds: Id[];
  layout: LayoutDoc;
}

const elk = new ELK();
const SPHERE_NODE = '__sphere__';
const MARGIN = 32;                 // the canvas origin is a whole cell; blocks start one cell in
const FIRST_COLUMN_X = 288;        // the sphere spans 32..224, one column pitch left of the steps
const GAP = 64;                    // two cells between blocks
const DEFAULT_SPHERE: Sphere = { cx: MARGIN + SPHERE_R, cy: MARGIN + SPHERE_R };

/**
 * Where every block sits. Stored positions win (snapped to 8 px). Wired steps with no stored position
 * are laid out by elkjs (layered, left to right) and then put on the cell grid: elk's layers become
 * columns 288 apart and its y values are snapped to 32, so every step border lies on a 32 px line
 * (spec §9). When some blocks are stored, the newly placed group goes below them so nothing overlaps.
 * Parked steps with no position go in a row below everything; caches stack under the sphere.
 */
export async function place(input: PlacementInput): Promise<Placement> {
  const onCanvas = new Set([...input.reachable.map((s) => s.id), ...input.parkedIds]);
  const steps = new Map<Id, Point>();
  for (const [id, p] of Object.entries(input.layout.steps)) {
    if (onCanvas.has(id)) steps.set(id, { x: snap(p.x), y: snap(p.y) });
  }

  let sphere: Sphere | null = input.layout.sphere
    ? { cx: snap(input.layout.sphere.x), cy: snap(input.layout.sphere.y) }
    : null;

  const missingWired = input.reachable.filter((s) => !steps.has(s.id));
  if (missingWired.length > 0) {
    const placed = await layoutWithElk(input.entryStepIds, missingWired, sphere === null);
    const storedBottom = maxBottom(steps.values());
    const dy = storedBottom === null ? 0 : snap(storedBottom + GAP - placed.minY, CELL);
    for (const [id, p] of placed.steps) steps.set(id, { x: p.x, y: p.y + dy });
    if (sphere === null && placed.sphereTop !== null) {
      sphere = { cx: MARGIN + SPHERE_R, cy: placed.sphereTop + dy + SPHERE_R };
    }
  }

  if (sphere === null) sphere = sphereFor(input.entryStepIds, steps);
  else if (!input.layout.sphere) sphere = sphereFor(input.entryStepIds, steps, sphere);

  const missingParked = input.parkedIds.filter((id) => !steps.has(id));
  if (missingParked.length > 0) {
    const bottom = Math.max(maxBottom(steps.values()) ?? 0, sphere.cy + SPHERE_R);
    const y = snap(bottom + GAP, CELL);
    missingParked.forEach((id, k) => steps.set(id, { x: FIRST_COLUMN_X + k * COLUMN_PITCH, y }));
  }

  const caches = new Map<Id, Point>();
  let k = 0;
  for (const id of input.cacheIds) {
    const stored = input.layout.caches[id];
    if (stored) caches.set(id, { x: snap(stored.x), y: snap(stored.y) });
    else caches.set(id, { x: sphere.cx - SPHERE_R, y: sphere.cy + SPHERE_R + GAP + k++ * (CACHE_H + 32) });
  }

  return { sphere, steps, caches };
}

/** Centre the sphere on its entry steps' processor middles, so one entry wire runs straight. */
function sphereFor(entryStepIds: Id[], steps: Map<Id, Point>, fallback: Sphere = DEFAULT_SPHERE): Sphere {
  const middles = entryStepIds.map((id) => steps.get(id)).filter((p): p is Point => !!p).map((p) => p.y + PMID);
  if (middles.length === 0) return fallback;
  const firstColumn = Math.min(...[...steps.values()].map((p) => p.x));
  return {
    cx: Math.min(MARGIN + SPHERE_R, snap(firstColumn - COLUMN_PITCH + SPHERE_R + MARGIN)),
    cy: snap(middles.reduce((a, b) => a + b, 0) / middles.length),
  };
}

function maxBottom(points: Iterable<Point>): number | null {
  let bottom: number | null = null;
  for (const p of points) bottom = Math.max(bottom ?? -Infinity, p.y + STEP_H);
  return bottom;
}

interface ElkPlaced {
  steps: Map<Id, Point>;
  sphereTop: number | null;
  minY: number;
}

async function layoutWithElk(entryStepIds: Id[], wired: { id: Id; nextStepIds: Id[] }[], withSphere: boolean): Promise<ElkPlaced> {
  const ids = new Set(wired.map((s) => s.id));
  const edges: { id: string; sources: string[]; targets: string[] }[] = [];
  for (const s of wired) {
    for (const t of s.nextStepIds) if (ids.has(t) && t !== s.id) edges.push({ id: `${s.id}->${t}`, sources: [s.id], targets: [t] });
  }
  const children = wired.map((s) => ({ id: s.id, width: STEP_W, height: STEP_H }));
  if (withSphere) {
    children.unshift({ id: SPHERE_NODE, width: 2 * SPHERE_R, height: 2 * SPHERE_R });
    for (const e of entryStepIds) if (ids.has(e)) edges.push({ id: `${SPHERE_NODE}->${e}`, sources: [SPHERE_NODE], targets: [e] });
  }

  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': String(GAP),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(GAP),
      'elk.layered.spacing.edgeNodeBetweenLayers': String(GAP),
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children,
    edges,
  });

  // elk's x values become column indices: a new column starts where x jumps by more than half a step.
  const laid = (result.children ?? []).map((c) => ({ id: c.id, x: c.x ?? 0, y: c.y ?? 0 }));
  const stepNodes = laid.filter((c) => c.id !== SPHERE_NODE).sort((a, b) => a.x - b.x);
  const column = new Map<string, number>();
  let index = -1, columnStart = -Infinity;
  for (const n of stepNodes) {
    if (n.x - columnStart > STEP_W / 2) { index++; columnStart = n.x; }
    column.set(n.id, index);
  }

  const minY = Math.min(...laid.map((c) => c.y));
  const steps = new Map<Id, Point>();
  for (const n of stepNodes) {
    steps.set(n.id, { x: FIRST_COLUMN_X + column.get(n.id)! * COLUMN_PITCH, y: MARGIN + snap(n.y - minY, CELL) });
  }
  const sphereNode = laid.find((c) => c.id === SPHERE_NODE);
  return {
    steps,
    sphereTop: sphereNode ? MARGIN + snap(sphereNode.y - minY, CELL) : null,
    minY: Math.min(...[...steps.values()].map((p) => p.y)),
  };
}
```

Note on the sphere: when elk placed it, `place` still re-centres it on the entry steps (`sphereFor` with the elk position as fallback), so a single entry wire runs straight; the elk position is only used when no entry step is on the canvas.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run src/layout
npm run typecheck
```

Expected: 17 passed (`layoutDoc` 9, its `it.each` counting 6; `placement` 8); 0 failed; typecheck clean. If `elkjs/lib/elk.bundled.js` has no type declarations under this TypeScript, add `src/types/elkjs.d.ts` with `declare module 'elkjs/lib/elk.bundled.js' { import ELK from 'elkjs'; export default ELK; }` and say so in the report.

- [ ] **Step 6: Commit**

```bash
git add src/WorkflowStudio/src/layout
git commit -m "feat(studio): layout document, grid geometry and elkjs placement on the cell grid"
```

---

### Task 5: `layout/`: ports, landings, the router and wires

**Files:**
- Create: `src/layout/ports.ts`, `src/layout/router.ts`, `src/layout/wires.ts`
- Test: `src/layout/ports.test.ts`, `src/layout/router.test.ts`, `src/layout/wires.test.ts`

**Interfaces:**
- Consumes: `geometry.ts`, `Placement`, `Sphere` (Task 4); `isBrokenEdge` (Task 3); `Step`, `Processor`, `Id` (Task 2).
- Produces:
  - `ports.ts`: `WORKFLOW_SOURCE = 'wf'`, `type SourceId = string`, `interface WireEnd { source: SourceId; target: Id }`, `departureX(source, placement): number`, `computeDepartures(wires, placement): Map<SourceId, Map<Id, number>>`, `computeLandings(wires, placement, departures): Map<Id, Map<SourceId, number>>`.
  - `router.ts`: `type Pt = readonly [number, number]`, `interface Box { id: string; x: number; y: number; w: number; h: number }`, `route(sx, sy, tx, ty, srcId, tgtId, nudge, boxes): Pt[]`, `simplify(pts: Pt[]): Pt[]`.
  - `wires.ts`: `interface WireRoute { id: string; source: SourceId; target: Id; points: Pt[]; condition: number; broken: boolean }`, `interface WiringInput { entryStepIds: Id[]; steps: ReadonlyMap<Id, Step>; processors: ReadonlyMap<Id, Processor> }`, `collectWires(input, placement): WireEnd[]`, `routeWires(input, placement): WireRoute[]`, `blockBoxes(placement): Box[]`, `tetherPoints(sphere, cache: Point): Pt[]`, `stepBoxId(id)`, `cacheBoxId(id)`, `SPHERE_BOX_ID`.

Ported from the mockup's `computePorts`, `computeLand` and `route`, with two fixes: the straight-landing search can no longer oscillate when the band is full (it searches outward and gives up to the bent rule), and collinear points are removed so a straight run is never counted as a bend.

- [ ] **Step 1: Write the failing tests**

`src/layout/router.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { route, simplify, type Box, type Pt } from './router';

const box = (id: string, x: number, y: number, w = 224, h = 160): Box => ({ id, x, y, w, h });

const orthogonal = (pts: Pt[]) => pts.every((p, i) => i === 0 || p[0] === pts[i - 1]![0] || p[1] === pts[i - 1]![1]);
const onGrid = (pts: Pt[]) => pts.every(([x, y]) => x % 8 === 0 && y % 8 === 0);

describe('route', () => {
  it('runs straight when the ends are level and far enough apart', () => {
    expect(route(512, 128, 576, 128, 'a', 'b', 0, [box('a', 288, 32), box('b', 576, 32)])).toEqual([[512, 128], [576, 128]]);
  });

  it('bends once each way (Z) with the elbow half way, snapped to 8', () => {
    const pts = route(512, 128, 576, 416, 'a', 'b', 0, [box('a', 288, 32), box('b', 576, 320)]);
    expect(pts).toEqual([[512, 128], [544, 128], [544, 416], [576, 416]]);
  });

  it('shifts the elbow by the fan-out nudge so sibling wires do not share a vertical run', () => {
    const pts = route(512, 120, 800, 416, 'a', 'b', -8, [box('a', 288, 32), box('b', 800, 320)]);
    expect(pts[1]![0]).toBe(648);
  });

  it('goes round a block that sits on the straight path', () => {
    const boxes = [box('a', 288, 32), box('mid', 576, 32), box('c', 864, 32)];
    const pts = route(512, 128, 864, 128, 'a', 'c', 0, boxes);
    expect(pts.length).toBeGreaterThan(2);
    expect(orthogonal(pts)).toBe(true);
  });

  it('makes a U for a back edge, entering the target from the left', () => {
    const boxes = [box('a', 288, 32), box('b', 576, 32)];
    const pts = route(800, 128, 288, 128, 'b', 'a', 0, boxes);
    expect(pts[0]).toEqual([800, 128]);
    expect(pts.at(-1)).toEqual([288, 128]);
    expect(pts.at(-2)![0]).toBeLessThan(288);
    expect(orthogonal(pts)).toBe(true);
    expect(onGrid(pts)).toBe(true);
  });

  it('makes a U for a self-loop', () => {
    const pts = route(512, 128, 288, 128, 'a', 'a', 0, [box('a', 288, 32)]);
    expect(orthogonal(pts)).toBe(true);
    expect(onGrid(pts)).toBe(true);
    expect(pts.length).toBe(6);
  });

  it('still returns a route when there are no boxes at all', () => {
    const pts = route(512, 128, 288, 200, 'x', 'y', 0, []);
    expect(pts[0]).toEqual([512, 128]);
    expect(pts.at(-1)).toEqual([288, 200]);
    expect(orthogonal(pts)).toBe(true);
  });
});

describe('simplify', () => {
  it('drops repeated and collinear points', () => {
    expect(simplify([[0, 0], [0, 0], [8, 0], [16, 0], [16, 8]])).toEqual([[0, 0], [16, 0], [16, 8]]);
  });
});
```

`src/layout/ports.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Placement } from './placement';
import { computeDepartures, computeLandings, WORKFLOW_SOURCE, type WireEnd } from './ports';

const placement = (steps: Record<string, [number, number]>): Placement => ({
  sphere: { cx: 128, cy: 128 },
  steps: new Map(Object.entries(steps).map(([id, [x, y]]) => [id, { x, y }])),
  caches: new Map(),
});

describe('computeDepartures', () => {
  it('centres a fan-out group 16 apart on the source processor middle, ordered by target height', () => {
    const p = placement({ a: [288, 32], low: [576, 320], high: [576, 32] });
    const wires: WireEnd[] = [{ source: 'a', target: 'low' }, { source: 'a', target: 'high' }];

    const out = computeDepartures(wires, p).get('a')!;

    expect(out.get('high')).toBe(32 + 96 - 8);
    expect(out.get('low')).toBe(32 + 96 + 8);
  });

  it('starts entry wires at the sphere centre height', () => {
    const p = placement({ a: [288, 32] });
    expect(computeDepartures([{ source: WORKFLOW_SOURCE, target: 'a' }], p).get(WORKFLOW_SOURCE)!.get('a')).toBe(128);
  });
});

describe('computeLandings', () => {
  const land = (p: Placement, wires: WireEnd[]) => computeLandings(wires, p, computeDepartures(wires, p));

  it('keeps the departure height when it falls in the target band and the source is to the left', () => {
    const p = placement({ a: [288, 32], b: [576, 64] });
    // departure 128; b's band is 64+62 .. 64+130 = 126..194
    expect(land(p, [{ source: 'a', target: 'b' }]).get('b')!.get('a')).toBe(128);
  });

  it('lands a wire that must bend at the processor middle', () => {
    const p = placement({ a: [288, 32], b: [576, 320] });
    expect(land(p, [{ source: 'a', target: 'b' }]).get('b')!.get('a')).toBe(320 + 96);
  });

  it('treats a source that is not far enough left as bending', () => {
    const p = placement({ a: [288, 32], b: [400, 32] });
    expect(land(p, [{ source: 'a', target: 'b' }]).get('b')!.get('a')).toBe(32 + 96);
  });

  it('keeps every arrival into one step at least 16 apart, even for a fan-in of 8', () => {
    const steps: Record<string, [number, number]> = { t: [864, 320] };
    const wires: WireEnd[] = [];
    for (let k = 0; k < 8; k++) { steps[`s${k}`] = [288, 32 + k * 192]; wires.push({ source: `s${k}`, target: 't' }); }
    const ys = [...land(placement(steps), wires).get('t')!.values()].sort((a, b) => a - b);

    expect(ys).toHaveLength(8);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(16);
    for (const y of ys) expect(y % 8).toBe(0);
  });
});
```

`src/layout/wires.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Processor, Step } from '../model/graph';
import type { Placement } from './placement';
import { routeWires, tetherPoints, type WiringInput } from './wires';

const step = (id: string, next: string[], over: Partial<Step> = {}): Step => ({
  id, name: id, version: '1.0.0', processorId: 'p', nextStepIds: next, entryCondition: 1, updatedAt: '', ...over,
});
const proc = (id: string, inputSchemaId: string | null, outputSchemaId: string | null): Processor => ({
  id, name: id, version: '1.0.0', inputSchemaId, outputSchemaId, configSchemaId: null,
});

function setup(steps: Step[], positions: Record<string, [number, number]>, processors: Processor[] = [proc('p', null, null)]) {
  const input: WiringInput = {
    entryStepIds: ['a'],
    steps: new Map(steps.map((s) => [s.id, s])),
    processors: new Map(processors.map((p) => [p.id, p])),
  };
  const placement: Placement = {
    sphere: { cx: 128, cy: 128 },
    steps: new Map(Object.entries(positions).map(([id, [x, y]]) => [id, { x, y }])),
    caches: new Map(),
  };
  return routeWires(input, placement);
}

describe('routeWires', () => {
  it('draws the entry wire and a step wire straight when they line up', () => {
    const wires = setup([step('a', ['b']), step('b', [])], { a: [288, 32], b: [576, 32] });

    expect(wires.find((w) => w.id === 'wf->a')!.points).toEqual([[224, 128], [288, 128]]);
    expect(wires.find((w) => w.id === 'a->b')!.points).toEqual([[512, 128], [576, 128]]);
  });

  it('colours a wire by its target step entry condition', () => {
    const wires = setup([step('a', ['b']), step('b', [], { entryCondition: 2 })], { a: [288, 32], b: [576, 32] });
    expect(wires.find((w) => w.id === 'a->b')!.condition).toBe(2);
  });

  it('marks a wire broken when the parent Out schema differs from the child In schema', () => {
    const wires = setup(
      [step('a', ['b'], { processorId: 'pa' }), step('b', [], { processorId: 'pb' })],
      { a: [288, 32], b: [576, 32] },
      [proc('pa', null, 's1'), proc('pb', 's2', null)],
    );
    expect(wires.find((w) => w.id === 'a->b')!.broken).toBe(true);
    expect(wires.find((w) => w.id === 'wf->a')!.broken).toBe(false);
  });

  it('does not draw a wire to a step that is not on the canvas (a dangling next-step id)', () => {
    const wires = setup([step('a', ['ghost'])], { a: [288, 32] });
    expect(wires.map((w) => w.id)).toEqual(['wf->a']);
  });

  it('routes a back edge and a self-loop orthogonally, every point on the 8 px grid', () => {
    const wires = setup([step('a', ['b', 'a']), step('b', ['a'])], { a: [288, 32], b: [576, 32] });

    for (const w of wires) {
      for (let i = 1; i < w.points.length; i++) {
        const [x0, y0] = w.points[i - 1]!, [x1, y1] = w.points[i]!;
        expect(x0 === x1 || y0 === y1).toBe(true);
      }
      for (const [x, y] of w.points) { expect(x % 8).toBe(0); expect(y % 8).toBe(0); }
    }
    expect(wires.map((w) => w.id).sort()).toEqual(['a->a', 'a->b', 'b->a', 'wf->a']);
  });

  it('ends every wire on the target step left edge at its landing height', () => {
    const wires = setup([step('a', ['b']), step('b', [])], { a: [288, 32], b: [576, 320] });
    expect(wires.find((w) => w.id === 'a->b')!.points.at(-1)).toEqual([576, 416]);
  });
});

describe('tetherPoints', () => {
  it('drops straight from the sphere bottom to a cache centred under it', () => {
    expect(tetherPoints({ cx: 128, cy: 128 }, { x: 32, y: 288 })).toEqual([[128, 224], [128, 288]]);
  });

  it('bends at right angles to a cache that was moved aside', () => {
    expect(tetherPoints({ cx: 128, cy: 128 }, { x: 320, y: 400 })).toEqual([[128, 224], [128, 312], [416, 312], [416, 400]]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/layout/ports.test.ts src/layout/router.test.ts src/layout/wires.test.ts`
Expected: FAIL, the three modules cannot be resolved.

- [ ] **Step 3: Implement the router**

`src/layout/router.ts`:

```ts
import { snap } from './geometry';

export type Pt = readonly [number, number];

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const BEND_COST = 24;
const HIT_COST = 5000;
const HIT_MARGIN = 3;
const CLEARANCE = 24;

function segmentHits(a: Pt, b: Pt, box: Box): boolean {
  const x1 = Math.min(a[0], b[0]), x2 = Math.max(a[0], b[0]);
  const y1 = Math.min(a[1], b[1]), y2 = Math.max(a[1], b[1]);
  return x2 > box.x - HIT_MARGIN && x1 < box.x + box.w + HIT_MARGIN && y2 > box.y - HIT_MARGIN && y1 < box.y + box.h + HIT_MARGIN;
}

/** Length + 24 per bend + 5000 per block a segment crosses (the source's own box is allowed for the
 *  first segment, the target's for the last). */
function cost(pts: Pt[], srcId: string, tgtId: string, boxes: Box[]): number {
  let length = 0, hits = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    length += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    for (const box of boxes) {
      if ((box.id === srcId && i === 0) || (box.id === tgtId && i === pts.length - 2)) continue;
      if (segmentHits(a, b, box)) hits++;
    }
  }
  return length + (pts.length - 2) * BEND_COST + hits * HIT_COST;
}

/** Drops repeated points and points that lie on the line between their neighbours. */
export function simplify(pts: Pt[]): Pt[] {
  const unique = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1]);
  return unique.filter((p, i) => {
    if (i === 0 || i === unique.length - 1) return true;
    const a = unique[i - 1]!, b = unique[i + 1]!;
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
  });
}

/**
 * An orthogonal route from a source port (sx, sy) to a landing (tx, ty), the cheapest of: straight;
 * Z with its elbow at 50 / 30 / 70 % of the gap or 16 px from either end; and U shapes over or under
 * the blocks in the way. `nudge` is the wire's fan-out offset, so sibling wires keep distinct
 * vertical runs. Every candidate point is on the 8 px grid when its inputs are.
 */
export function route(sx: number, sy: number, tx: number, ty: number, srcId: string, tgtId: string, nudge: number, boxes: Box[]): Pt[] {
  const candidates: Pt[][] = [];

  if (tx - sx >= CLEARANCE) {
    if (sy === ty) candidates.push([[sx, sy], [tx, ty]]);
    for (const f of [0.5, 0.3, 0.7]) {
      const mx = snap(sx + (tx - sx) * f) + nudge;
      candidates.push([[sx, sy], [mx, sy], [mx, ty], [tx, ty]]);
    }
    candidates.push(
      [[sx, sy], [sx + 16 + nudge, sy], [sx + 16 + nudge, ty], [tx, ty]],
      [[sx, sy], [tx - 16, sy], [tx - 16, ty], [tx, ty]],
    );
  }

  const x1 = sx + CLEARANCE + nudge, x2 = tx - CLEARANCE;
  const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
  const span = boxes.filter((b) => b.x < hi + 20 && b.x + b.w > lo - 20);
  const levels = new Set<number>();
  if (span.length > 0) {
    levels.add(Math.min(...span.map((b) => b.y)) - CLEARANCE);
    levels.add(Math.max(...span.map((b) => b.y + b.h)) + CLEARANCE);
  }
  for (const id of [srcId, tgtId]) {
    const b = boxes.find((x) => x.id === id);
    if (b) { levels.add(b.y - CLEARANCE); levels.add(b.y + b.h + CLEARANCE); }
  }
  if (levels.size === 0) levels.add(Math.max(sy, ty) + CLEARANCE);
  for (const ly of levels) candidates.push([[sx, sy], [x1, sy], [x1, ly], [x2, ly], [x2, ty], [tx, ty]]);

  let best: Pt[] = candidates[0]!, bestCost = Infinity;
  for (const candidate of candidates) {
    const pts = simplify(candidate);
    const c = cost(pts, srcId, tgtId, boxes);
    if (c < bestCost) { bestCost = c; best = pts; }
  }
  return best;
}
```

- [ ] **Step 4: Implement ports and landings**

`src/layout/ports.ts`:

```ts
import type { Id } from '../model/graph';
import { BAND_BOTTOM, BAND_TOP, PMID, PORT_GAP, SPHERE_R, STEP_W, offset } from './geometry';
import type { Placement } from './placement';

/** The sphere as a wire source. */
export const WORKFLOW_SOURCE = 'wf';
export type SourceId = string;

export interface WireEnd {
  source: SourceId;
  target: Id;
}

export function departureX(source: SourceId, placement: Placement): number {
  return source === WORKFLOW_SOURCE ? placement.sphere.cx + SPHERE_R : placement.steps.get(source)!.x + STEP_W;
}

/**
 * Fan-out (spec §5.2): a source's wires leave as one group 16 apart, centred on its processor
 * middle (the sphere's centre for entry wires), ordered by where their targets sit so neighbouring
 * wires never cross on the way out.
 */
export function computeDepartures(wires: WireEnd[], placement: Placement): Map<SourceId, Map<Id, number>> {
  const bySource = new Map<SourceId, Id[]>();
  for (const w of wires) bySource.set(w.source, [...(bySource.get(w.source) ?? []), w.target]);

  const out = new Map<SourceId, Map<Id, number>>();
  for (const [source, targets] of bySource) {
    const at = (id: Id) => placement.steps.get(id)!;
    const ordered = [...targets].sort((a, b) => at(a).y - at(b).y || at(a).x - at(b).x);
    const base = source === WORKFLOW_SOURCE ? placement.sphere.cy : placement.steps.get(source)!.y + PMID;
    out.set(source, new Map(ordered.map((t, k) => [t, base + offset(k, ordered.length, PORT_GAP)])));
  }
  return out;
}

/**
 * The landing rule (spec §5.2). A wire keeps the height it left at when that height is inside the
 * target processor's band and the source sits at least 16 px to the left, so it runs straight. Any
 * other wire bends and lands at the processor middle, stepping 16 toward the side it comes from
 * while that slot is taken. Arrivals into one step stay at least 16 apart.
 */
export function computeLandings(
  wires: WireEnd[],
  placement: Placement,
  departures: Map<SourceId, Map<Id, number>>,
): Map<Id, Map<SourceId, number>> {
  const byTarget = new Map<Id, SourceId[]>();
  for (const w of wires) byTarget.set(w.target, [...(byTarget.get(w.target) ?? []), w.source]);

  const result = new Map<Id, Map<SourceId, number>>();
  for (const [target, sources] of byTarget) {
    const p = placement.steps.get(target)!;
    const top = p.y + BAND_TOP, bottom = p.y + BAND_BOTTOM, middle = p.y + PMID;
    const used: number[] = [];
    const free = (y: number) => !used.some((u) => Math.abs(u - y) < PORT_GAP);
    const landed = new Map<SourceId, number>();
    const departure = (s: SourceId) => departures.get(s)!.get(target)!;

    for (const s of sources) {
      const d = departure(s);
      if (d < top || d > bottom || departureX(s, placement) > p.x - 16) continue;
      const y = nearestFreeInBand(d, top, bottom, free);
      if (y === null) continue;
      used.push(y);
      landed.set(s, y);
    }

    for (const s of sources) {
      if (landed.has(s)) continue;
      const direction = departure(s) < middle ? -1 : 1;
      let y = middle;
      while (!free(y)) y += direction * PORT_GAP;
      used.push(y);
      landed.set(s, y);
    }

    result.set(target, landed);
  }
  return result;
}

/** The free slot nearest `d` in steps of 16 inside the band, or null when the band is full. */
function nearestFreeInBand(d: number, top: number, bottom: number, free: (y: number) => boolean): number | null {
  for (let k = 0; ; k++) {
    const down = d + k * PORT_GAP, up = d - k * PORT_GAP;
    const downIn = down <= bottom, upIn = up >= top;
    if (!downIn && !upIn) return null;
    if (downIn && free(down)) return down;
    if (upIn && free(up)) return up;
  }
}
```

- [ ] **Step 5: Implement wires**

`src/layout/wires.ts`:

```ts
import { isBrokenEdge } from '../model/schemaEdges';
import type { Id, Processor, Step } from '../model/graph';
import { CACHE_H, CACHE_W, PORT_GAP, SPHERE_R, STEP_H, STEP_W, offset, type Point } from './geometry';
import type { Placement, Sphere } from './placement';
import { computeDepartures, computeLandings, departureX, WORKFLOW_SOURCE, type SourceId, type WireEnd } from './ports';
import { route, type Box, type Pt } from './router';

export interface WireRoute {
  /** `${source}->${target}`; unique because a step's nextStepIds are unique. */
  id: string;
  source: SourceId;
  target: Id;
  points: Pt[];
  /** The target step's entry condition: the wire's colour. */
  condition: number;
  broken: boolean;
}

export interface WiringInput {
  entryStepIds: Id[];
  /** Every step on the canvas, parked ones included. */
  steps: ReadonlyMap<Id, Step>;
  processors: ReadonlyMap<Id, Processor>;
}

export const SPHERE_BOX_ID = 'wf';
export const stepBoxId = (id: Id) => `step:${id}`;
export const cacheBoxId = (id: Id) => `cache:${id}`;
const boxIdOf = (source: SourceId) => (source === WORKFLOW_SOURCE ? SPHERE_BOX_ID : stepBoxId(source));

/** Every wire whose two ends are on the canvas: entry wires from the sphere, then step wires. */
export function collectWires(input: WiringInput, placement: Placement): WireEnd[] {
  const placed = (id: Id) => placement.steps.has(id) && input.steps.has(id);
  const wires: WireEnd[] = [];
  for (const id of new Set(input.entryStepIds)) if (placed(id)) wires.push({ source: WORKFLOW_SOURCE, target: id });
  for (const [id, step] of input.steps) {
    if (!placed(id)) continue;
    for (const next of step.nextStepIds) if (placed(next)) wires.push({ source: id, target: next });
  }
  return wires;
}

export function blockBoxes(placement: Placement): Box[] {
  const boxes: Box[] = [];
  for (const [id, p] of placement.steps) boxes.push({ id: stepBoxId(id), x: p.x, y: p.y, w: STEP_W, h: STEP_H });
  const { cx, cy } = placement.sphere;
  boxes.push({ id: SPHERE_BOX_ID, x: cx - SPHERE_R, y: cy - SPHERE_R, w: 2 * SPHERE_R, h: 2 * SPHERE_R });
  for (const [id, p] of placement.caches) boxes.push({ id: cacheBoxId(id), x: p.x, y: p.y, w: CACHE_W, h: CACHE_H });
  return boxes;
}

export function routeWires(input: WiringInput, placement: Placement): WireRoute[] {
  const wires = collectWires(input, placement);
  const departures = computeDepartures(wires, placement);
  const landings = computeLandings(wires, placement, departures);
  const boxes = blockBoxes(placement);

  return wires.map((w) => {
    const targets = [...departures.get(w.source)!.keys()];
    const nudge = offset(targets.indexOf(w.target), targets.length, PORT_GAP);
    const sx = departureX(w.source, placement), sy = departures.get(w.source)!.get(w.target)!;
    const tx = placement.steps.get(w.target)!.x, ty = landings.get(w.target)!.get(w.source)!;
    const target = input.steps.get(w.target)!;
    const parent = w.source === WORKFLOW_SOURCE ? undefined : input.processors.get(input.steps.get(w.source)!.processorId);
    return {
      id: `${w.source}->${w.target}`,
      source: w.source,
      target: w.target,
      points: route(sx, sy, tx, ty, boxIdOf(w.source), stepBoxId(w.target), nudge, boxes),
      condition: target.entryCondition,
      broken: w.source !== WORKFLOW_SOURCE && isBrokenEdge(parent, input.processors.get(target.processorId)),
    };
  });
}

/** The dashed tether from the sphere's bottom to a cache's top centre, right-angled. */
export function tetherPoints(sphere: Sphere, cache: Point): Pt[] {
  const from: Pt = [sphere.cx, sphere.cy + SPHERE_R];
  const to: Pt = [cache.x + CACHE_W / 2, cache.y];
  if (from[0] === to[0]) return [from, to];
  const midY = Math.round((from[1] + to[1]) / 2 / 8) * 8;
  return [from, [from[0], midY], [to[0], midY], to];
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run src/layout
npm run typecheck
```

Expected: every `src/layout` test passes (router 8, ports 6, wires 8 here, plus Task 4's); 0 failed; typecheck clean. If the Z-elbow test computes a different elbow because of a tie between equal-cost candidates, the first candidate in `route`'s order wins: keep that order, do not change the test.

- [ ] **Step 7: Commit**

```bash
git add src/WorkflowStudio/src/layout
git commit -m "feat(studio): ports, landing bands and the straight/Z/U router"
```

---

### Task 6: Canvas primitives: tokens, SVG definitions, the grid, text fitting and wire edges

**Files:**
- Create: `src/canvas/tokens.css`, `src/canvas/canvas.css`, `src/canvas/SvgDefs.tsx`, `src/canvas/GridBackground.tsx`, `src/canvas/fitText.ts`, `src/canvas/edges/CableEdge.tsx`, `src/canvas/edges/TetherEdge.tsx`, `src/canvas/svgPath.ts`
- Test: `src/canvas/fitText.test.ts`, `src/canvas/edges/CableEdge.test.tsx`

**Interfaces:**
- Consumes: `Pt` (Task 5), `conditionInfo` (Task 3).
- Produces:
  - `fitText.ts`: `interface FittedText { text: string; full: string; cut: boolean }`, `type Measure = (text: string, font: string) => number`, `interface TextFitter { width(text, font): number; fit(text, maxWidth, font): FittedText }`, `createTextFitter(measure: Measure): TextFitter`, `canvasMeasure(): Measure`, `SANS`, `MONO` font family strings.
  - `svgPath.ts`: `pathOf(points: Pt[]): string`, `longestSegmentMiddle(points: Pt[]): Pt`.
  - `edges/CableEdge.tsx`: `type CableEdgeData = { points: Pt[]; colour: string; broken: boolean }`, `CableEdge` component; `edges/TetherEdge.tsx`: `type TetherEdgeData = { points: Pt[] }`, `TetherEdge`.
  - `SvgDefs` component (renders a hidden `<svg>` with every shared gradient and filter id), `GridBackground` component.

- [ ] **Step 1: Write the failing tests**

`src/canvas/fitText.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTextFitter } from './fitText';

// A deterministic measurer: every character is 7 px wide whatever the font.
const fitter = createTextFitter((text) => text.length * 7);

describe('createTextFitter', () => {
  it('keeps text that fits', () => {
    expect(fitter.fit('fetch', 100, 'f')).toEqual({ text: 'fetch', full: 'fetch', cut: false });
  });

  it('cuts with an ellipsis to the longest prefix that fits, and keeps the full text for the tooltip', () => {
    // 10 chars max: 9 + the ellipsis
    expect(fitter.fit('a-very-long-step-name', 70, 'f')).toEqual({ text: 'a-very-lo…', full: 'a-very-long-step-name', cut: true });
  });

  it('returns a bare ellipsis when nothing fits', () => {
    expect(fitter.fit('abc', 5, 'f').text).toBe('…');
  });

  it('measures through the injected measurer', () => {
    expect(fitter.width('abcd', 'f')).toBe(28);
  });
});
```

`src/canvas/edges/CableEdge.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CableEdgeView } from './CableEdge';

describe('CableEdgeView', () => {
  it('draws the lit cable layers and an arrow head ending on the last point', () => {
    const { container } = render(<svg><CableEdgeView points={[[0, 8], [64, 8]]} colour="#2DD4BF" broken={false} /></svg>);

    expect(container.querySelector('.wshadow')!.getAttribute('d')).toBe('M0 8 L64 8');
    expect(container.querySelector('path.w')!.getAttribute('stroke')).toBe('#2DD4BF');
    expect(container.querySelector('.wcore')).not.toBeNull();
    expect(container.querySelector('polygon.ahead')!.getAttribute('points')).toBe('64,8 54,3 54,13');
    expect(container.querySelector('.wire')!.classList.contains('broken')).toBe(false);
  });

  it('marks a broken wire with the dashed class and a "!" at the middle of its longest segment', () => {
    const { container, getByText } = render(
      <svg><CableEdgeView points={[[0, 0], [16, 0], [16, 96], [32, 96]]} colour="#FF7A66" broken /></svg>,
    );

    expect(container.querySelector('.wire')!.classList.contains('broken')).toBe(true);
    const marker = container.querySelector('circle.brk')!;
    expect([marker.getAttribute('cx'), marker.getAttribute('cy')]).toEqual(['16', '48']);
    expect(getByText('!')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/canvas`
Expected: FAIL, the modules cannot be resolved.

- [ ] **Step 3: Implement text fitting and path helpers**

`src/canvas/fitText.ts`:

```ts
/**
 * Long labels are shortened with an ellipsis, measured with the real fonts, and keep their full
 * text for a tooltip (spec §5.4). The measurer is injected so tests do not need a canvas.
 */
export const SANS = '"IBM Plex Sans Condensed","Helvetica Neue",Arial,sans-serif';
export const MONO = '"IBM Plex Mono",ui-monospace,Consolas,monospace';

export interface FittedText {
  text: string;
  full: string;
  cut: boolean;
}

export type Measure = (text: string, font: string) => number;

export interface TextFitter {
  width(text: string, font: string): number;
  fit(text: string, maxWidth: number, font: string): FittedText;
}

export function createTextFitter(measure: Measure): TextFitter {
  return {
    width: measure,
    fit(text, maxWidth, font) {
      if (measure(text, font) <= maxWidth) return { text, full: text, cut: false };
      let lo = 0, hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measure(text.slice(0, mid) + '…', font) <= maxWidth) lo = mid;
        else hi = mid - 1;
      }
      return { text: text.slice(0, lo) + '…', full: text, cut: true };
    },
  };
}

/**
 * Measures with an offscreen 2D canvas. Call after `document.fonts.ready`. The context is created on
 * the first measurement, so merely creating the measurer touches no canvas (jsdom has none and logs
 * an error when one is asked for).
 */
export function canvasMeasure(): Measure {
  let context: CanvasRenderingContext2D | null | undefined;
  return (text, font) => {
    if (context === undefined) context = document.createElement('canvas').getContext('2d');
    if (!context) return text.length * 7;
    context.font = font;
    return context.measureText(text).width;
  };
}
```

`src/canvas/svgPath.ts`:

```ts
import type { Pt } from '../layout/router';

export const pathOf = (points: Pt[]): string => points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');

/** The middle of the longest segment: where a broken wire's "!" sits. */
export function longestSegmentMiddle(points: Pt[]): Pt {
  let best = 0, index = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i]!, [x1, y1] = points[i + 1]!;
    const length = Math.abs(x0 - x1) + Math.abs(y0 - y1);
    if (length > best) { best = length; index = i; }
  }
  const [x0, y0] = points[index]!, [x1, y1] = points[index + 1] ?? points[index]!;
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}
```

- [ ] **Step 4: Implement the edges**

`src/canvas/edges/CableEdge.tsx`:

```tsx
import type { Edge, EdgeProps } from '@xyflow/react';
import type { Pt } from '../../layout/router';
import { longestSegmentMiddle, pathOf } from '../svgPath';

export type CableEdgeData = { points: Pt[]; colour: string; broken: boolean };
export type CableEdgeType = Edge<CableEdgeData, 'cable'>;

/**
 * One lit cable (spec §5.2): shadow, halo, line and specular core, ending in an arrow head whose tip
 * is exactly the landing point on the step's left edge. A broken wire is dashed, has no core, and
 * carries a "!" disc at the middle of its longest segment. The points come from layout/wires.ts;
 * React Flow's handle coordinates are not used.
 */
export function CableEdgeView({ points, colour, broken }: CableEdgeData) {
  const d = pathOf(points);
  const [tx, ty] = points[points.length - 1]!;
  const head = `${tx},${ty} ${tx - 10},${ty - 5} ${tx - 10},${ty + 5}`;
  const mark = broken ? longestSegmentMiddle(points) : null;

  return (
    <g className={broken ? 'wire broken' : 'wire'}>
      <path className="wshadow" d={d} />
      <polygon className="ashadow" points={head} />
      <path className="whalo" d={d} stroke={colour} />
      <path className="w" d={d} stroke={colour} />
      <path className="wcore" d={d} />
      <polygon className="ahead" points={head} fill={colour} />
      <path className="alit" d={`M${tx - 10} ${ty - 5} L${tx} ${ty}`} />
      {mark && (
        <>
          <circle className="brk" cx={mark[0]} cy={mark[1]} r={9} fill="#0A1220" stroke={colour} strokeWidth={1.4} />
          <text x={mark[0]} y={mark[1] + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill={colour}>!</text>
        </>
      )}
    </g>
  );
}

export function CableEdge({ data }: EdgeProps<CableEdgeType>) {
  return data ? <CableEdgeView {...data} /> : null;
}
```

`src/canvas/edges/TetherEdge.tsx`:

```tsx
import type { Edge, EdgeProps } from '@xyflow/react';
import type { Pt } from '../../layout/router';
import { pathOf } from '../svgPath';

export type TetherEdgeData = { points: Pt[] };
export type TetherEdgeType = Edge<TetherEdgeData, 'tether'>;

/** The dashed tether that ties a linked cache to the workflow sphere. */
export function TetherEdge({ data }: EdgeProps<TetherEdgeType>) {
  return data ? <path className="tether" d={pathOf(data.points)} /> : null;
}
```

- [ ] **Step 5: Implement the tokens, styles, shared definitions and the grid**

`src/canvas/tokens.css`:

```css
/* Colour tokens of the blueprint theme (mockup v49, the :root tokens). */
:root {
  --z-fly: 1000; --z-menu: 1010; --z-toast: 1020; --z-modal: 1030; --z-switcher: 1040; --z-tip: 1050;
  --ground: #0A1220; --ground-2: #0C1628;
  --panel: #0E1828; --panel-2: #122036; --line: #1E3050; --line-2: #2A4166;
  --ink: #E6EEF8; --muted: #8193AE; --faint: #5A6B86;
  --accent: #7DD3FC;
  --c: #2DD4BF; --f: #FF7A66; --x: #F5B841; --a: #B392F0; --n: #F472B6;
  --block: #0F1C31;
  --sans: "IBM Plex Sans Condensed", "Helvetica Neue", Arial, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Consolas, monospace;
}
```

`src/canvas/canvas.css`:

```css
/* Block and wire styles (mockup v49, the effective block, chip and wire rules). */
.studio-canvas { background: var(--ground); font-family: var(--sans); }
.studio-canvas .react-flow__node { cursor: default; }
.studio-canvas svg text { font-family: var(--sans); }

/* wires */
.wire path.w { fill: none; stroke-width: 2.2; stroke-linejoin: miter; }
.wire.broken path.w { stroke-dasharray: 7 5; }
.wire.broken .wcore { display: none; }
.wire .wshadow { fill: none; stroke: #000; stroke-width: 3.2; opacity: .5; transform: translate(1.5px, 2.5px); filter: url(#wsoft); stroke-linejoin: miter; }
.wire .ashadow { fill: #000; opacity: .45; transform: translate(1.5px, 2.5px); filter: url(#wsoft); }
.wire .whalo { fill: none; stroke-width: 5; opacity: .1; stroke-linejoin: miter; }
.wire .wcore { fill: none; stroke: #fff; stroke-width: .7; opacity: .38; stroke-linejoin: miter; pointer-events: none; }
.wire .alit { fill: none; stroke: #fff; stroke-width: .9; opacity: .5; pointer-events: none; }
.wire .brk + text { font-family: var(--sans); }
.tether { fill: none; stroke: var(--line-2); stroke-width: 1.2; stroke-dasharray: 3 4; }

/* sphere */
.wf .wft { paint-order: stroke; stroke: rgba(3, 12, 28, .55); stroke-width: 3px; stroke-linejoin: round; }

/* step and cache shells */
.blk .contact, .cachetag .contact { fill: #000; opacity: .5; filter: url(#soft); }
.blk .shell, .cachetag .shell { fill: url(#darkbody); }
.blk .cap, .cachetag .cap { fill: url(#capfill); }
.blk .rimr, .cachetag .rimr { fill: none; stroke: url(#rimline); stroke-width: 1.2; }
.blk.parked { opacity: .6; }
.blk.parked .rimr { stroke: var(--faint); stroke-dasharray: 5 4; }
.blk.parked .cap { filter: saturate(.35) brightness(.8); }
.blk .name { font-size: 14.5px; font-weight: 600; fill: #F4F9FF; paint-order: stroke; stroke: rgba(3, 12, 28, .35); stroke-width: 2.5px; }
.blk .kind { font-size: 9.5px; letter-spacing: .14em; fill: #BFE6FF; }
.blk .ver { font-family: var(--mono); font-size: 10.5px; fill: #CFE6FA; }
.badge { font-family: var(--mono); font-size: 9.5px; }
.blk .asg { fill: #E0F4FF; }
.trace { stroke: #2C4A78; stroke-width: 1.4; }
.cachetag .cname { font-size: 13px; font-weight: 600; fill: #F4F9FF; paint-order: stroke; stroke: rgba(3, 12, 28, .35); stroke-width: 2.5px; }
.cachetag .csub { font-family: var(--mono); font-size: 10px; fill: var(--muted); }

/* processor: a die on a substrate */
.chipg .cbody { fill: url(#substrate); }
.chipg .crim { fill: none; stroke: #203A60; stroke-width: 1; }
.chipg .diebody { fill: url(#dieFill); }
.chipg .dierim { fill: none; stroke: url(#chipRim); }
.chipg .smd { fill: #22344F; }
.chipg .smdc { fill: #8EA4C0; }
.chipg .bond-on { stroke: #7DD3FC; stroke-width: 1; opacity: .8; }
.chipg .bond-off { stroke: #2E4566; stroke-width: 1; }
.chipg .pad-io { fill: #7DD3FC; filter: url(#pinGlow); }
.chipg .pad-null { fill: none; stroke: #3A5274; stroke-width: .8; }
.chipg .ptitle { font-family: var(--mono); font-size: 11px; fill: #D5E1F2; }
.chipg .ptitle .pv { fill: var(--faint); }
.chipg .io { font-family: var(--mono); font-size: 10px; fill: var(--muted); }
.chipg .io .lab { fill: var(--faint); }
.chipg .io .nul { fill: var(--faint); }

/* handles exist only so React Flow can attach edges; they are never seen or used */
.studio-canvas .react-flow__handle { opacity: 0; pointer-events: none; min-width: 0; min-height: 0; width: 1px; height: 1px; border: 0; }

/* legend */
.legend { position: absolute; left: 16px; bottom: 22px; z-index: 5; display: flex; gap: 14px; align-items: center; padding: 8px 12px;
  background: rgba(14, 24, 40, .86); backdrop-filter: blur(6px); border: 1px solid var(--line); border-radius: 8px; font-size: 12px; color: var(--muted); }
.legend i { display: inline-block; width: 22px; height: 0; border-top: 2.5px solid; vertical-align: middle; margin-right: 6px; }
.legend .pill { font-family: var(--mono); font-size: 10px; border-radius: 3px; padding: 0 4px; color: #04111F; margin-right: 4px; font-weight: 600; }
```

`src/canvas/SvgDefs.tsx`:

```tsx
/**
 * Every gradient and filter the blocks and wires reference, defined once per page (mockup v49,
 * the defsInto block). The ids are document-global, so nothing else may define them.
 */
export function SvgDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <radialGradient id="wfBody" cx="36%" cy="30%" r="80%" fx="30%" fy="24%">
          <stop offset="0" stopColor="#7CCBF5" /><stop offset=".18" stopColor="#3B8ED0" /><stop offset=".45" stopColor="#1B5594" />
          <stop offset=".72" stopColor="#0E3263" /><stop offset=".9" stopColor="#081F42" /><stop offset="1" stopColor="#05142D" />
        </radialGradient>
        <radialGradient id="wfShade" cx="62%" cy="68%" r="62%"><stop offset=".55" stopColor="#020A18" stopOpacity="0" /><stop offset="1" stopColor="#020A18" stopOpacity=".55" /></radialGradient>
        <radialGradient id="wfRim"><stop offset=".84" stopColor="#7DD3FC" stopOpacity="0" /><stop offset=".97" stopColor="#7DD3FC" stopOpacity=".38" /><stop offset="1" stopColor="#7DD3FC" stopOpacity="0" /></radialGradient>
        <radialGradient id="wfSpec"><stop offset="0" stopColor="#FFFFFF" stopOpacity=".55" /><stop offset=".5" stopColor="#E0F4FF" stopOpacity=".16" /><stop offset="1" stopColor="#E0F4FF" stopOpacity="0" /></radialGradient>
        <radialGradient id="wfShadow"><stop offset="0" stopColor="#000" stopOpacity=".55" /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient>
        <radialGradient id="wfHalo"><stop offset=".55" stopColor="#7DD3FC" stopOpacity=".16" /><stop offset="1" stopColor="#7DD3FC" stopOpacity="0" /></radialGradient>
        <linearGradient id="capfill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4FA2E0" /><stop offset=".35" stopColor="#22609F" /><stop offset="1" stopColor="#0C2E5A" /></linearGradient>
        <linearGradient id="darkbody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#11223B" /><stop offset="1" stopColor="#0A1527" /></linearGradient>
        <linearGradient id="rimline" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9AD8FA" stopOpacity=".75" /><stop offset=".5" stopColor="#7DD3FC" stopOpacity=".25" /><stop offset="1" stopColor="#7DD3FC" stopOpacity=".06" /></linearGradient>
        <radialGradient id="glint"><stop offset="0" stopColor="#fff" stopOpacity=".5" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
        <linearGradient id="drum" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#4E9AD8" /><stop offset=".35" stopColor="#2463A3" /><stop offset=".8" stopColor="#0F3566" /><stop offset="1" stopColor="#0A2549" /></linearGradient>
        <linearGradient id="drumTop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9AD8FA" /><stop offset="1" stopColor="#3C82C4" /></linearGradient>
        <linearGradient id="chipRim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8CC8F2" stopOpacity=".6" /><stop offset=".55" stopColor="#3B5F8F" stopOpacity=".5" /><stop offset="1" stopColor="#1E3556" stopOpacity=".6" /></linearGradient>
        <linearGradient id="substrate" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#0E1C30" /><stop offset="1" stopColor="#08121F" /></linearGradient>
        <linearGradient id="dieFill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#1E4774" /><stop offset=".45" stopColor="#14325A" /><stop offset="1" stopColor="#0B1E3B" /></linearGradient>
        <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7" /></filter>
        <filter id="pinGlow" x="-100%" y="-200%" width="300%" height="500%"><feGaussianBlur stdDeviation="1.6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        {/* userSpaceOnUse: a perfectly straight wire has a zero-height bounding box, which would erase it */}
        <filter id="wsoft" filterUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><feGaussianBlur stdDeviation="1.3" /></filter>
      </defs>
    </svg>
  );
}
```

`src/canvas/GridBackground.tsx`:

```tsx
import { useId } from 'react';
import { useStore } from '@xyflow/react';

/**
 * The lit mesh (spec §5.1): soft fine dashed neutral grey lines every 8 px, a barely visible solid
 * line every 32 px and a lit dot where 32 px lines cross, over a soft vignette. No bright dashed
 * 32 px line (removed in the mockup v49 review). The patterns are in world units and follow the
 * viewport, so world (0, 0) is a whole cell and block coordinates coincide with drawn lines. Below
 * 60 % zoom the 8 px tier drops out. Pattern ids come from useId, so two canvases never collide.
 */
export function GridBackground() {
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const ids = { minor: `${id}-minor`, tile: `${id}-tile`, major: `${id}-major`, majorOnly: `${id}-majorOnly`, vign: `${id}-vign` };
  const transform = `translate(${tx} ${ty}) scale(${zoom})`;

  return (
    <svg className="react-flow__background" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: -1, pointerEvents: 'none' }} aria-hidden="true">
      <defs>
        <pattern id={ids.minor} width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M0 0H8 M0 8H8 M0 0V8 M8 0V8" fill="none" stroke="rgba(200,208,218,.20)" strokeWidth=".6" strokeDasharray="2 2" />
        </pattern>
        <g id={ids.tile}>
          {/* the barely visible 32 px line; the bright dashed 32 px line was removed in the v49 review */}
          <path d="M0 0H32 M0 32H32 M0 0V32 M32 0V32" fill="none" stroke="rgba(214,220,230,.07)" strokeWidth="2.2" />
          {[[0, 0], [0, 32], [32, 0], [32, 32]].map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.3" fill="rgba(236,240,246,.55)" />)}
        </g>
        <pattern id={ids.major} width="32" height="32" patternUnits="userSpaceOnUse" patternTransform={transform}>
          <rect width="32" height="32" fill={`url(#${ids.minor})`} />
          <use href={`#${ids.tile}`} />
        </pattern>
        <pattern id={ids.majorOnly} width="32" height="32" patternUnits="userSpaceOnUse" patternTransform={transform}>
          <use href={`#${ids.tile}`} />
        </pattern>
        <radialGradient id={ids.vign} cx="50%" cy="45%" r="75%">
          <stop offset="0" stopColor="#0F1D33" stopOpacity=".9" /><stop offset="1" stopColor="#0A1220" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="#0A1220" />
      <rect width="100%" height="100%" fill={`url(#${ids.vign})`} />
      <rect width="100%" height="100%" fill={`url(#${zoom < 0.6 ? ids.majorOnly : ids.major})`} />
    </svg>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run src/canvas
npm run typecheck
```

Expected: 6 passed; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/WorkflowStudio/src/canvas
git commit -m "feat(studio): blueprint tokens, shared SVG definitions, the lit grid and the cable edge"
```

---

### Task 7: Block nodes and the document → React Flow mapping

**Files:**
- Create: `src/canvas/nodes/Label.tsx`, `src/canvas/nodes/WorkflowNode.tsx`, `src/canvas/nodes/StepNode.tsx`, `src/canvas/nodes/Chip.tsx`, `src/canvas/nodes/CacheNode.tsx`, `src/canvas/toFlow.ts`, `src/app/document.ts`
- Test: `src/canvas/toFlow.test.ts`, `src/canvas/nodes/StepNode.test.tsx`

**Interfaces:**
- Consumes: everything in Tasks 2–6.
- Produces:
  - `app/document.ts`: `interface StudioDocument { graph: Graph; parkedIds: Id[]; placement: Placement; wires: WireRoute[] }` (Task 8's loader fills it).
  - `nodes/*`: `WorkflowNodeData`, `StepNodeData`, `ProcessorView`, `CacheNodeData`; components `WorkflowNode`, `StepNode`, `CacheNode`, and the plain views `StepView`, `ChipView` used by tests.
  - `toFlow.ts`: `type StudioNode`, `type StudioEdge`, `toFlow(doc: StudioDocument, fitter: TextFitter): { nodes: StudioNode[]; edges: StudioEdge[] }`, node id helpers `SPHERE_NODE_ID = 'wf'`, `cacheNodeId(id)`; step node ids are the step ids.

Text limits (mockup v49, drawStep, drawChip and drawCacheTag): step name `600 14.5px` SANS, max 178; version `10.5px` MONO, max 106 (90 when parked); die title `11px` MONO, room 136, version dropped first; die rows `10px` MONO, room 136 minus the label; cache name `600 13px` SANS, max 128; cache second line `10px` MONO, max 128; sphere name `600 14px` SANS split after `-`, `_`, `.` into at most 3 lines, each fitted to the sphere chord `2·√((r−16)² − dy²)`.

- [ ] **Step 1: Write the failing tests**

`src/canvas/toFlow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { StudioDocument } from '../app/document';
import type { Graph, Step } from '../model/graph';
import { createTextFitter } from './fitText';
import { cacheNodeId, SPHERE_NODE_ID, toFlow } from './toFlow';

const fitter = createTextFitter((text) => text.length * 7);

const step = (id: string, over: Partial<Step> = {}): Step => ({
  id, name: id, version: '1.0.0', processorId: 'p1', nextStepIds: [], entryCondition: 1, updatedAt: '', ...over,
});

function doc(over: Partial<Graph> = {}, parkedIds: string[] = []): StudioDocument {
  const graph: Graph = {
    workflow: { id: 'wf1', name: 'orders', version: '1.0.0', cronExpression: null, entryStepIds: ['a'], assignmentIds: [], cacheIds: ['c1'], updatedAt: '' },
    steps: new Map([['a', step('a', { nextStepIds: ['b'] })], ['b', step('b', { entryCondition: 2 })]]),
    processors: new Map([['p1', { id: 'p1', name: 'fetcher', version: '2.1.0', inputSchemaId: 'sIn', outputSchemaId: null, configSchemaId: null }]]),
    schemas: new Map([['sIn', { id: 'sIn', name: 'orders-in', version: '1.0.0' }]]),
    assignments: [{ id: 'x1', stepId: 'a', payload: '{"url":"u","retries":3}' }],
    caches: new Map([['c1', { id: 'c1', name: 'lookups', root: 'lk', items: '{"k1":"v","k2":"v"}' }]]),
    layout: null,
    ...over,
  };
  return {
    graph,
    parkedIds,
    placement: {
      sphere: { cx: 128, cy: 128 },
      steps: new Map([['a', { x: 288, y: 32 }], ['b', { x: 576, y: 32 }], ...parkedIds.map((id) => [id, { x: 288, y: 320 }] as const)]),
      caches: new Map([['c1', { x: 32, y: 288 }]]),
    },
    wires: [
      { id: 'wf->a', source: 'wf', target: 'a', points: [[224, 128], [288, 128]], condition: 1, broken: false },
      { id: 'a->b', source: 'a', target: 'b', points: [[512, 128], [576, 128]], condition: 2, broken: true },
    ],
  };
}

describe('toFlow', () => {
  it('makes a sphere, one node per step and one per cache, sized and positioned from the placement', () => {
    const { nodes } = toFlow(doc(), fitter);

    const sphere = nodes.find((n) => n.id === SPHERE_NODE_ID)!;
    expect(sphere.position).toEqual({ x: 32, y: 32 });
    expect([sphere.width, sphere.height]).toEqual([192, 192]);

    const a = nodes.find((n) => n.id === 'a')!;
    expect(a.type).toBe('step');
    expect(a.position).toEqual({ x: 288, y: 32 });
    expect([a.width, a.height]).toEqual([224, 160]);

    expect(nodes.find((n) => n.id === cacheNodeId('c1'))!.position).toEqual({ x: 32, y: 288 });
  });

  it('turns wires into cable edges carrying their points, colour and broken flag', () => {
    const { edges } = toFlow(doc(), fitter);
    const ab = edges.find((e) => e.id === 'a->b')!;

    expect([ab.source, ab.target, ab.type]).toEqual(['a', 'b', 'cable']);
    expect(ab.data).toEqual({ points: [[512, 128], [576, 128]], colour: '#FF7A66', broken: true });
    expect(edges.find((e) => e.id === 'wf->a')!.source).toBe(SPHERE_NODE_ID);
  });

  it('ties each cache to the sphere with a tether edge', () => {
    const tether = toFlow(doc(), fitter).edges.find((e) => e.type === 'tether')!;
    expect([tether.source, tether.target]).toEqual([SPHERE_NODE_ID, cacheNodeId('c1')]);
  });

  it('fills the step cap: condition pill, assignment key count, fan-in, landing and departure heights', () => {
    const { nodes } = toFlow(doc(), fitter);
    const a = nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;
    const b = nodes.find((n) => n.id === 'b')!.data as import('./nodes/StepNode').StepNodeData;

    expect(a.letter).toBe('C');
    expect(b.letter).toBe('F');
    expect(a.assignment).toBe('◆ 2 keys');
    expect(b.assignment).toBeNull();
    expect(a.ins).toEqual([96]);     // the entry wire lands at local y 128 - 32
    expect(a.outs).toEqual([96]);
    expect(b.ins).toEqual([96]);
  });

  it('shows the processor die: name and version, In schema by name, empty slots as null', () => {
    const a = toFlow(doc(), fitter).nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;

    expect(a.processor.title.text).toBe('fetcher');
    expect(a.processor.version).toBe('2.1.0');
    expect(a.processor.rows.map((r) => [r.label.trim(), r.value?.text ?? null])).toEqual([['in', 'orders-in'], ['out', null], ['cfg', null]]);
    expect([a.processor.inputLit, a.processor.outputLit]).toEqual([true, false]);
  });

  it('labels a parked step PARKED', () => {
    const graph = doc({}, ['p']);
    graph.graph.steps.set('p', step('p'));
    const p = toFlow(graph, fitter).nodes.find((n) => n.id === 'p')!.data as import('./nodes/StepNode').StepNodeData;
    expect(p.parked).toBe(true);
  });

  it('cuts long names to fit and keeps the full text for the tooltip (review focus 5)', () => {
    const long = 'a-step-name-that-goes-on-and-on-and-on-forever';
    const graph = doc({ steps: new Map([['a', step('a', { name: long })], ['b', step('b')]]) });
    const a = toFlow(graph, fitter).nodes.find((n) => n.id === 'a')!.data as import('./nodes/StepNode').StepNodeData;

    expect(a.name.cut).toBe(true);
    expect(a.name.full).toBe(long);
    expect(a.name.text.length * 7).toBeLessThanOrEqual(178);
  });

  it('splits a long workflow name over at most three sphere lines', () => {
    const graph = doc({ workflow: { ...doc().graph.workflow, name: 'orders-intake_eu-west.nightly-backfill-and-reconcile' } });
    const sphere = toFlow(graph, fitter).nodes.find((n) => n.id === SPHERE_NODE_ID)!.data as import('./nodes/WorkflowNode').WorkflowNodeData;

    expect(sphere.lines.length).toBeGreaterThan(1);
    expect(sphere.lines.length).toBeLessThanOrEqual(3);
    expect(sphere.full).toBe('orders-intake_eu-west.nightly-backfill-and-reconcile');
  });
});
```

`src/canvas/nodes/StepNode.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
    title: { text: 'fetcher', full: 'fetcher', cut: false },
    version: '2.1.0',
    rows: [
      { label: 'in  ', value: { text: 'orders-in', full: 'orders-in', cut: false } },
      { label: 'out ', value: null },
      { label: 'cfg ', value: null },
    ],
    inputLit: true,
    outputLit: false,
    tooltip: 'fetcher 2.1.0',
  },
};

describe('StepView', () => {
  it('draws the cap text, the pill, the assignment badge and the fan-in badge', () => {
    const { getByText } = render(<svg><StepView {...data} /></svg>);

    expect(getByText('fetch…')).toBeInTheDocument();
    expect(getByText('STEP')).toBeInTheDocument();
    expect(getByText('v1.0.0')).toBeInTheDocument();
    expect(getByText('C')).toBeInTheDocument();
    expect(getByText('◆ 2 keys')).toBeInTheDocument();
    expect(getByText('fan-in ×2')).toBeInTheDocument();
  });

  it('puts the full name in a tooltip when it was cut', () => {
    const { container } = render(<svg><StepView {...data} /></svg>);
    // the <title> sits beside the <text> in a wrapping <g>, so the text keeps only what is drawn
    expect(container.querySelector('text.name')!.parentElement!.querySelector(':scope > title')!.textContent)
      .toBe('fetch-orders-from-the-api');
  });

  it('draws one edge contact per landing and per departure, lit when the side has a schema', () => {
    const { container } = render(<svg><StepView {...data} /></svg>);
    expect(container.querySelectorAll('.pad-io')).toHaveLength(2);    // two landings, In schema set
    expect(container.querySelectorAll('.pad-null')).toHaveLength(1);  // one departure, no Out schema
  });

  it('marks a parked step with the PARKED label and the parked class', () => {
    const { container, getByText } = render(<svg><StepView {...data} parked /></svg>);
    expect(getByText('PARKED')).toBeInTheDocument();
    expect(container.querySelector('.blk')!.classList.contains('parked')).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/canvas`
Expected: FAIL, `./toFlow` and `./StepNode` cannot be resolved.

- [ ] **Step 3: Implement the document type and the nodes**

`src/app/document.ts`:

```ts
import type { Id, Graph } from '../model/graph';
import type { Placement } from '../layout/placement';
import type { WireRoute } from '../layout/wires';

/** One opened workflow, ready to draw: the graph (parked steps included), where every block sits,
 *  and every wire's route. */
export interface StudioDocument {
  graph: Graph;
  parkedIds: Id[];
  placement: Placement;
  wires: WireRoute[];
}
```

`src/canvas/nodes/Label.tsx`:

```tsx
import type { ReactNode, SVGProps } from 'react';
import type { FittedText } from '../fitText';

/**
 * A label that may have been shortened. When it was, its full text is a native SVG tooltip: a
 * <title> beside the <text> inside a wrapping <g> (a <title> describes its parent), so the <text>
 * itself holds only what is drawn.
 */
export function Tip({ full, cut, children }: { full: string; cut: boolean; children: ReactNode }) {
  return cut ? <g><title>{full}</title>{children}</g> : <>{children}</>;
}

export function Label({ fitted, ...props }: { fitted: FittedText } & SVGProps<SVGTextElement>) {
  return <Tip full={fitted.full} cut={fitted.cut}><text {...props}>{fitted.text}</text></Tip>;
}
```

`src/canvas/nodes/Chip.tsx`:

```tsx
import type { FittedText } from '../fitText';
import { Tip } from './Label';

export interface ProcessorView {
  title: FittedText;
  /** null when the title had no room for it (the version drops first). */
  version: string | null;
  rows: { label: string; value: FittedText | null }[];
  inputLit: boolean;
  outputLit: boolean;
  tooltip: string;
}

const W = 176, H = 80, DX = 12, DY = 6, DW = W - 24, DH = H - 14;

/**
 * The processor drawn as a glossy die on a substrate (spec §5.1, mockup drawChip): SMD parts on
 * the border and an edge contact with a bond trace at every height a wire lands or leaves. A contact
 * is lit when the processor declares that side's schema. `ins` and `outs` are chip-local heights.
 */
export function ChipView({ p, ins, outs }: { p: ProcessorView; ins: number[]; outs: number[] }) {
  const contact = (key: string, edgeX: number, y: number, lit: boolean, dir: 1 | -1) => (
    <g key={key}>
      <path className={lit ? 'bond-on' : 'bond-off'} d={`M${edgeX + dir * 2} ${y} H${dir > 0 ? DX : DX + DW}`} />
      <rect className={lit ? 'pad-io' : 'pad-null'} x={dir > 0 ? 0 : W - 4} y={y - 3} width={4} height={6} rx={1} />
    </g>
  );

  return (
    <g className="chipg" transform="translate(24,56)">
      <title>{p.tooltip}</title>
      <rect className="cbody" width={W} height={H} rx={5} />
      <rect className="crim" x={0.6} y={0.6} width={W - 1.2} height={H - 1.2} rx={4.5} />
      {[30, 46, W - 46, W - 30].map((px) => (
        <g key={px}>
          <rect className="smd" x={px - 3} y={H - 7} width={6} height={3} rx={0.5} />
          <rect className="smdc" x={px - 3} y={H - 7} width={1.4} height={3} />
          <rect className="smdc" x={px + 1.6} y={H - 7} width={1.4} height={3} />
        </g>
      ))}
      {ins.map((y, i) => contact(`in${i}`, 0, y, p.inputLit, 1))}
      {outs.map((y, i) => contact(`out${i}`, W, y, p.outputLit, -1))}
      <rect className="diebody" x={DX} y={DY} width={DW} height={DH} rx={3} />
      <ellipse cx={DX + 38} cy={DY + 5} rx={42} ry={6} fill="url(#glint)" opacity={0.4} />
      <rect className="dierim" x={DX + 0.5} y={DY + 0.5} width={DW - 1} height={DH - 1} rx={2.5} />
      <Tip full={p.title.full} cut={p.title.cut}>
        <text className="ptitle" x={DX + 8} y={DY + 14}>
          <tspan>{p.title.text}</tspan>
          {p.version && <tspan className="pv">{` ${p.version}`}</tspan>}
        </text>
      </Tip>
      {p.rows.map((row, i) => (
        <Tip key={row.label} full={`${row.label.trim()}  ${row.value?.full ?? ''}`} cut={row.value?.cut ?? false}>
          <text className="io" x={DX + 8} y={DY + 35 + i * 13}>
            <tspan className="lab">{row.label}</tspan>
            {row.value ? <tspan>{row.value.text}</tspan> : <tspan className="nul">∅</tspan>}
          </text>
        </Tip>
      ))}
    </g>
  );
}
```

`src/canvas/nodes/StepNode.tsx`:

```tsx
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CAP_H, CHIP, PMID, STEP_H, STEP_W } from '../../layout/geometry';
import type { FittedText } from '../fitText';
import { ChipView, type ProcessorView } from './Chip';
import { Label } from './Label';

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

/** A step: a dark body under a glossy title cap, with its processor drawn inside (mockup drawStep). */
export function StepView(d: StepNodeData) {
  const ins = d.ins.length > 0 ? d.ins : [PMID];
  const outs = d.outs.length > 0 ? d.outs : [PMID];
  const versionX = d.parked ? 60 : 44;

  return (
    <g className={d.parked ? 'blk parked' : 'blk'}>
      <rect className="contact" x={5} y={9} width={W} height={H} rx={9} />
      <rect className="shell" width={W} height={H} rx={8} />
      <path className="cap" d={`M0 8 a8 8 0 0 1 8 -8 H${W - 8} a8 8 0 0 1 8 8 V${CAP_H} H0Z`} />
      <ellipse cx={56} cy={8} rx={62} ry={9} fill="url(#glint)" opacity={0.55} />
      <path d={`M0 ${CAP_H} H${W}`} stroke="rgba(160,215,255,.5)" />
      <rect className="rimr" x={0.6} y={0.6} width={W - 1.2} height={H - 1.2} rx={7.5} />
      <Label className="name" x={12} y={19} fitted={d.name} />
      <text className="kind" x={12} y={33}>{d.parked ? 'PARKED' : 'STEP'}</text>
      <Label className="ver" x={versionX} y={33} fitted={d.version} />
      <rect x={W - 24} y={8} width={14} height={13} rx={2} fill={d.colour} stroke="rgba(3,12,28,.35)" />
      <text className="badge" x={W - 17} y={18} textAnchor="middle" fill="#04111F" fontWeight={600}>{d.letter}</text>
      {d.assignment && <text className="badge asg" x={W - 11} y={33} textAnchor="end">{d.assignment}</text>}
      {d.fanIn > 1 && (
        <>
          <rect x={W - 70} y={-9} width={58} height={16} rx={8} fill="var(--panel)" stroke="var(--line-2)" />
          <text className="badge" x={W - 41} y={2.5} textAnchor="middle" fill="var(--muted)">{`fan-in ×${d.fanIn}`}</text>
        </>
      )}
      <path className="trace" d={`${ins.map((y) => `M0 ${y} H${CHIP.x}`).join(' ')} ${outs.map((y) => `M${CHIP.x + CHIP.w} ${y} H${W}`).join(' ')}`} />
      <ChipView p={d.processor} ins={ins.map((y) => y - CHIP.y)} outs={outs.map((y) => y - CHIP.y)} />
    </g>
  );
}

export function StepNode({ data }: NodeProps<StepNodeType>) {
  return (
    <>
      <Handle id="in" type="target" position={Position.Left} isConnectable={false} style={{ top: PMID }} />
      <svg width={W} height={H} overflow="visible" style={{ display: 'block' }}>
        <StepView {...data} />
      </svg>
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} style={{ top: PMID }} />
    </>
  );
}
```

`src/canvas/nodes/WorkflowNode.tsx`:

```tsx
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { SPHERE_R } from '../../layout/geometry';

export type WorkflowNodeData = { lines: string[]; full: string; cut: boolean };
export type WorkflowNodeType = Node<WorkflowNodeData, 'workflow'>;

const R = SPHERE_R, C = SPHERE_R; // the node box is 2r × 2r, so the centre is (r, r)

/** The workflow as a lit sphere showing only "WORKFLOW" and its name (spec §5.1, mockup drawWorkflow). */
export function WorkflowView({ lines, full, cut }: WorkflowNodeData) {
  const top = C - 6 - (lines.length - 1) * 8;
  return (
    <g className="wf">
      {cut && <title>{full}</title>}
      <ellipse cx={C + 6} cy={C + R + 16} rx={R * 0.95} ry={R * 0.18} fill="url(#wfShadow)" />
      <circle cx={C} cy={C} r={R + 30} fill="url(#wfHalo)" />
      <g className="sphere">
        <circle cx={C} cy={C} r={R} fill="url(#wfBody)" />
        <circle cx={C} cy={C} r={R} fill="url(#wfShade)" />
        <circle cx={C} cy={C} r={R} fill="url(#wfRim)" />
        <ellipse cx={C - R * 0.34} cy={C - R * 0.42} rx={R * 0.36} ry={R * 0.24} fill="url(#wfSpec)" transform={`rotate(-28 ${C - R * 0.34} ${C - R * 0.42})`} />
        <circle cx={C} cy={C} r={R} fill="none" stroke="rgba(125,211,252,.55)" strokeWidth={1} />
      </g>
      <text className="wft" x={C} y={top - 14} textAnchor="middle" fontSize={9.5} letterSpacing={2.5} fill="#BFE6FF">WORKFLOW</text>
      {lines.map((line, k) => (
        <text key={k} className="wft" x={C} y={C - 6 + (k - (lines.length - 1) / 2) * 16 + 8} textAnchor="middle" fontSize={14} fontWeight={600} fill="#F4F9FF">{line}</text>
      ))}
    </g>
  );
}

export function WorkflowNode({ data }: NodeProps<WorkflowNodeType>) {
  return (
    <>
      <svg width={2 * R} height={2 * R} overflow="visible" style={{ display: 'block' }}>
        <WorkflowView {...data} />
      </svg>
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} style={{ top: R }} />
      <Handle id="down" type="source" position={Position.Bottom} isConnectable={false} />
    </>
  );
}
```

`src/canvas/nodes/CacheNode.tsx`:

```tsx
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CACHE_H, CACHE_W } from '../../layout/geometry';
import type { FittedText } from '../fitText';
import { Label } from './Label';

export type CacheNodeData = { name: FittedText; sub: FittedText };
export type CacheNodeType = Node<CacheNodeData, 'cache'>;

const W = CACHE_W, H = CACHE_H;

/** A cache: the glass cap over a dark body, with a stack of lit discs (mockup drawCacheTag). */
export function CacheView({ name, sub }: CacheNodeData) {
  return (
    <g className="cachetag">
      <rect className="contact" x={5} y={8} width={W} height={H} rx={9} />
      <rect className="shell" width={W} height={H} rx={8} />
      <path className="cap" d={`M0 8 a8 8 0 0 1 8 -8 H${W - 8} a8 8 0 0 1 8 8 V28 H0Z`} />
      <ellipse cx={54} cy={7} rx={54} ry={7} fill="url(#glint)" opacity={0.55} />
      <path d={`M0 28 H${W}`} stroke="rgba(160,215,255,.5)" />
      <rect className="rimr" x={0.6} y={0.6} width={W - 1.2} height={H - 1.2} rx={7.5} />
      {[44, 36, 28].map((y) => <ellipse key={y} cx={W - 24} cy={y} rx={14} ry={5} fill="url(#drum)" stroke="rgba(200,235,255,.45)" strokeWidth={0.6} />)}
      <ellipse cx={W - 24} cy={20} rx={14} ry={5} fill="url(#drumTop)" stroke="rgba(220,240,255,.5)" strokeWidth={0.6} />
      <Label className="cname" x={12} y={19} fitted={name} />
      <Label className="csub" x={12} y={46} fitted={sub} />
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

- [ ] **Step 4: Implement the mapping**

`src/canvas/toFlow.ts`:

```ts
import { Position, type NodeHandle } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { CACHE_H, CACHE_W, PMID, SPHERE_R, STEP_H, STEP_W } from '../layout/geometry';
import { tetherPoints } from '../layout/wires';
import { WORKFLOW_SOURCE } from '../layout/ports';
import { assignmentByStep, payloadKeyCount } from '../model/assignments';
import { conditionInfo } from '../model/entryConditions';
import type { Graph, Id, Processor, Step } from '../model/graph';
import type { CableEdgeType } from './edges/CableEdge';
import type { TetherEdgeType } from './edges/TetherEdge';
import { MONO, SANS, type FittedText, type TextFitter } from './fitText';
import type { CacheNodeType } from './nodes/CacheNode';
import type { ProcessorView, StepNodeType } from './nodes/StepNode';
import type { WorkflowNodeType } from './nodes/WorkflowNode';

export type StudioNode = WorkflowNodeType | StepNodeType | CacheNodeType;
export type StudioEdge = CableEdgeType | TetherEdgeType;

export const SPHERE_NODE_ID = 'wf';
export const cacheNodeId = (id: Id) => `cache:${id}`;

const handle = (id: string, type: 'source' | 'target', position: Position, x: number, y: number): NodeHandle =>
  ({ id, type, position, x, y, width: 1, height: 1 });

/**
 * The opened document as React Flow nodes and edges. Pure: every label is fitted here (with the
 * injected fitter), and every node carries explicit width, height and handle geometry, so React
 * Flow draws edges without measuring the DOM. Edges carry their routed points; the handles exist
 * only so React Flow accepts the edge.
 */
export function toFlow(doc: StudioDocument, fitter: TextFitter): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const { graph, placement, wires } = doc;
  const parked = new Set(doc.parkedIds);
  const assignments = assignmentByStep(graph.assignments);

  const ins = new Map<Id, number[]>(), outs = new Map<Id, number[]>();
  for (const w of wires) {
    const last = w.points[w.points.length - 1]!, first = w.points[0]!;
    const target = placement.steps.get(w.target)!;
    ins.set(w.target, [...(ins.get(w.target) ?? []), last[1] - target.y]);
    if (w.source !== WORKFLOW_SOURCE) {
      const source = placement.steps.get(w.source)!;
      outs.set(w.source, [...(outs.get(w.source) ?? []), first[1] - source.y]);
    }
  }

  const nodes: StudioNode[] = [];
  const { cx, cy } = placement.sphere;
  nodes.push({
    id: SPHERE_NODE_ID, type: 'workflow', position: { x: cx - SPHERE_R, y: cy - SPHERE_R },
    width: 2 * SPHERE_R, height: 2 * SPHERE_R, draggable: false, selectable: false,
    handles: [handle('out', 'source', Position.Right, 2 * SPHERE_R, SPHERE_R), handle('down', 'source', Position.Bottom, SPHERE_R, 2 * SPHERE_R)],
    data: sphereLabel(graph.workflow.name, fitter),
  });

  for (const [id, position] of placement.steps) {
    const step = graph.steps.get(id);
    if (!step) continue;
    nodes.push({
      id, type: 'step', position, width: STEP_W, height: STEP_H, draggable: false, selectable: false,
      handles: [handle('in', 'target', Position.Left, 0, PMID), handle('out', 'source', Position.Right, STEP_W, PMID)],
      data: {
        ...stepLabels(step, parked.has(id), fitter),
        letter: conditionInfo(step.entryCondition).letter,
        colour: conditionInfo(step.entryCondition).colour,
        assignment: badge(assignments.get(id)?.payload),
        fanIn: ins.get(id)?.length ?? 0,
        ins: ins.get(id) ?? [],
        outs: outs.get(id) ?? [],
        processor: processorView(graph.processors.get(step.processorId), graph, fitter),
      },
    });
  }

  for (const [id, position] of placement.caches) {
    const cache = graph.caches.get(id);
    if (!cache) continue;
    const count = payloadKeyCount(cache.items);
    nodes.push({
      id: cacheNodeId(id), type: 'cache', position, width: CACHE_W, height: CACHE_H, draggable: false, selectable: false,
      handles: [handle('in', 'target', Position.Top, CACHE_W / 2, 0)],
      data: {
        name: fitter.fit(cache.name, CACHE_W - 12 - 52, `600 13px ${SANS}`),
        sub: fitter.fit(`root ${cache.root} · ${count ?? '?'} items`, CACHE_W - 12 - 52, `10px ${MONO}`),
      },
    });
  }

  const edges: StudioEdge[] = wires.map((w) => ({
    id: w.id, type: 'cable', source: w.source === WORKFLOW_SOURCE ? SPHERE_NODE_ID : w.source, target: w.target,
    sourceHandle: 'out', targetHandle: 'in', selectable: false, focusable: false,
    data: { points: w.points, colour: conditionInfo(w.condition).colour, broken: w.broken },
  }));
  for (const [id, position] of placement.caches) {
    if (!graph.caches.has(id)) continue;
    edges.push({
      id: `tether:${id}`, type: 'tether', source: SPHERE_NODE_ID, target: cacheNodeId(id),
      sourceHandle: 'down', targetHandle: 'in', selectable: false, focusable: false,
      data: { points: tetherPoints(placement.sphere, position) },
    });
  }

  return { nodes, edges };
}

function badge(payload: string | undefined): string | null {
  if (payload === undefined) return null;
  const n = payloadKeyCount(payload);
  if (n === null) return '◆ ?';
  return n === 0 ? '◇ {}' : `◆ ${n} key${n > 1 ? 's' : ''}`;
}

function stepLabels(step: Step, parked: boolean, fitter: TextFitter): { name: FittedText; version: FittedText; parked: boolean } {
  const versionX = parked ? 60 : 44;
  return {
    name: fitter.fit(step.name, STEP_W - 12 - 34, `600 14.5px ${SANS}`),
    version: fitter.fit(`v${step.version}`, STEP_W - versionX - 74, `10.5px ${MONO}`),
    parked,
  };
}

const ROOM = 152 - 16; // the die's inner width

function processorView(p: Processor | undefined, graph: Graph, fitter: TextFitter): ProcessorView {
  const name = p?.name ?? '(missing processor)';
  const version = p?.version ?? '';
  const titleFont = `11px ${MONO}`, rowFont = `10px ${MONO}`;
  const fitsWithVersion = version !== '' && fitter.width(`${name} ${version}`, titleFont) <= ROOM;
  const schemaLabel = (id: Id | null | undefined) => {
    if (!id) return null;
    const s = graph.schemas.get(id);
    return s ? s.name : id;
  };
  const row = (label: string, id: Id | null | undefined) => {
    const value = schemaLabel(id);
    return { label, value: value === null ? null : fitter.fit(value, ROOM - fitter.width(label, rowFont), rowFont) };
  };
  const tip = (label: string, id: Id | null | undefined) => {
    const s = id ? graph.schemas.get(id) : undefined;
    return `${label} ${id ? (s ? `${s.name} ${s.version}` : id) : '∅'}`;
  };

  return {
    title: fitsWithVersion ? { text: name, full: name, cut: false } : fitter.fit(name, ROOM, titleFont),
    version: fitsWithVersion ? version : null,
    rows: [row('in  ', p?.inputSchemaId), row('out ', p?.outputSchemaId), row('cfg ', p?.configSchemaId)],
    inputLit: !!p?.inputSchemaId,
    outputLit: !!p?.outputSchemaId,
    tooltip: [`${name} ${version}`.trim(), tip('in ', p?.inputSchemaId), tip('out', p?.outputSchemaId), tip('cfg', p?.configSchemaId)].join('\n'),
  };
}

/** Splits after `-`, `_` and `.` into at most three lines, each fitted to the sphere's chord. */
function sphereLabel(name: string, fitter: TextFitter): { lines: string[]; full: string; cut: boolean } {
  const font = `600 14px ${SANS}`;
  const chord = (dy: number) => 2 * Math.sqrt(Math.max(0, (SPHERE_R - 16) ** 2 - dy * dy));
  const parts: string[] = [];
  let current = '';
  for (const segment of name.split(/(?<=[-_.])/)) {
    if (current && fitter.width(current + segment, font) > chord(16)) { parts.push(current); current = segment; }
    else current += segment;
  }
  parts.push(current);
  if (parts.length > 3) parts.splice(2, parts.length - 2, parts.slice(2).join(''));

  let cut = false;
  const lines = parts.map((line, k) => {
    const dy = (k - (parts.length - 1) / 2) * 16;
    const fitted = fitter.fit(line, chord(Math.abs(dy) + 8), font);
    cut = cut || fitted.cut;
    return fitted.text;
  });
  return { lines, full: name, cut };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run src/canvas
npm run typecheck
```

Expected: 18 passed in `src/canvas` (Task 6's 6 + 8 `toFlow` + 4 `StepNode`); typecheck clean. If `NodeHandle` is not exported under that name by @xyflow/react 12.12.0, import the type the package declares for `Node['handles']` items and say so in the report.

- [ ] **Step 6: Commit**

```bash
git add src/WorkflowStudio/src/canvas src/WorkflowStudio/src/app/document.ts
git commit -m "feat(studio): sphere, step, processor die and cache nodes, and the document-to-flow mapping"
```

---

### Task 8: The canvas surface, the loader and the page

**Files:**
- Create: `src/canvas/WorkflowCanvas.tsx`, `src/canvas/Legend.tsx`, `src/app/loadDocument.ts`, `src/app.css`
- Modify: `src/App.tsx` (replace), `src/main.tsx` (font and style imports)
- Test: `src/app/loadDocument.test.ts`, `src/canvas/WorkflowCanvas.test.tsx`, `src/App.test.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `loadDocument(api: StudioApi, workflowId: Id): Promise<ApiResult<StudioDocument>>`.
  - `WorkflowCanvas({ doc, fitter, width?, height? })`: the read-only React Flow surface (`width`/`height` only for tests).
  - `App({ api? })`: the page.

- [ ] **Step 1: Write the failing tests**

`src/app/loadDocument.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, StudioApi } from '../api/client';
import { graphDto, processorDto, stepDto } from '../api/fixtures';
import { loadDocument } from './loadDocument';

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

function fakeApi(over: Partial<StudioApi> = {}): StudioApi {
  return {
    listWorkflows: vi.fn(),
    getGraph: vi.fn().mockResolvedValue(ok(graphDto())),
    getStep: vi.fn().mockResolvedValue(notFound),
    getProcessor: vi.fn().mockResolvedValue(notFound),
    ...over,
  };
}

describe('loadDocument', () => {
  it('loads, places and routes a workflow', async () => {
    const result = await loadDocument(fakeApi(), 'wf1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.placement.steps.keys()]).toEqual(['s1']);
    expect(result.value.wires.map((w) => w.id)).toEqual(['wf->s1']);
  });

  it('fetches parked steps the layout lists, and the processors they need', async () => {
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({ layout: { parked: ['p1'], steps: { p1: { x: 288, y: 400 } } } } as never))),
      getStep: vi.fn().mockResolvedValue(ok(stepDto('p1', { processorId: 'p9' }))),
      getProcessor: vi.fn().mockResolvedValue(ok(processorDto('p9'))),
    });

    const result = await loadDocument(api, 'wf1');

    expect(result.ok && result.value.parkedIds).toEqual(['p1']);
    expect(result.ok && result.value.placement.steps.get('p1')).toEqual({ x: 288, y: 400 });
    expect(result.ok && result.value.graph.processors.has('p9')).toBe(true);
    expect(api.getStep).toHaveBeenCalledWith('p1');
  });

  it('ignores a parked id the server no longer has, and one that is actually wired (review focus 1)', async () => {
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({ layout: { parked: ['gone', 's1'], steps: { gone: { x: 8, y: 8 } } } } as never))),
    });

    const result = await loadDocument(api, 'wf1');

    expect(result.ok && result.value.parkedIds).toEqual([]);
    expect(api.getStep).toHaveBeenCalledTimes(1);
    expect(api.getStep).toHaveBeenCalledWith('gone');
  });

  it('survives a layout that is not an object', async () => {
    const api = fakeApi({ getGraph: vi.fn().mockResolvedValue(ok(graphDto({ layout: [1, 2, 3] } as never))) });
    expect((await loadDocument(api, 'wf1')).ok).toBe(true);
  });

  it('passes on the error when the graph cannot be loaded', async () => {
    const api = fakeApi({ getGraph: vi.fn().mockResolvedValue(notFound) });
    expect(await loadDocument(api, 'wf1')).toEqual(notFound);
  });

  it('passes on a parked-step error other than 404', async () => {
    const failure = { ok: false, error: { kind: 'network', message: 'down' } } as const;
    const api = fakeApi({
      getGraph: vi.fn().mockResolvedValue(ok(graphDto({ layout: { parked: ['p1'] } } as never))),
      getStep: vi.fn().mockResolvedValue(failure),
    });
    expect(await loadDocument(api, 'wf1')).toEqual(failure);
  });
});
```

`src/canvas/WorkflowCanvas.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, stepDto } from '../api/fixtures';
import { loadDocument } from '../app/loadDocument';
import { createTextFitter } from './fitText';
import { WorkflowCanvas } from './WorkflowCanvas';

const fitter = createTextFitter((t) => t.length * 7);

describe('WorkflowCanvas', () => {
  it('draws the sphere, every step and every wire of a loaded document', async () => {
    const api = {
      getGraph: async () => ({
        ok: true,
        value: graphDto({ steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'] }), stepDto('s2', { name: 'store' })] }),
      }),
      getStep: async () => ({ ok: false, error: { kind: 'notFound', status: 404 } }),
      getProcessor: async () => ({ ok: false, error: { kind: 'notFound', status: 404 } }),
      listWorkflows: async () => ({ ok: true, value: [] }),
    } as unknown as StudioApi;
    const loaded = await loadDocument(api, 'wf1');
    if (!loaded.ok) throw new Error('load failed');

    const { container, getByText } = render(<WorkflowCanvas doc={loaded.value} fitter={fitter} width={1200} height={800} />);

    expect(getByText('WORKFLOW')).toBeInTheDocument();
    expect(getByText('fetch')).toBeInTheDocument();
    expect(getByText('store')).toBeInTheDocument();
    expect(container.querySelectorAll('.wire')).toHaveLength(2);
  });
});
```

`src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StudioApi } from './api/client';
import { workflowDto } from './api/fixtures';
import { App } from './App';

const api = (over: Partial<StudioApi>): StudioApi => ({
  listWorkflows: vi.fn(), getGraph: vi.fn(), getStep: vi.fn(), getProcessor: vi.fn(), ...over,
} as StudioApi);

describe('App', () => {
  it('lists the workflows in the picker, sorted by name', async () => {
    render(<App api={api({
      listWorkflows: vi.fn().mockResolvedValue({ ok: true, value: [workflowDto({ id: 'w2', name: 'zeta' }), workflowDto({ id: 'w1', name: 'alpha' })] }),
    })} />);

    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Open a workflow…', 'alpha 1.0.0', 'zeta 1.0.0']);
  });

  it('shows a network failure in the status line', async () => {
    render(<App api={api({ listWorkflows: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'network', message: 'Failed to fetch' } }) })} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Network error: Failed to fetch');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/app src/canvas/WorkflowCanvas.test.tsx src/App.test.tsx`
Expected: FAIL, `./loadDocument` and `./WorkflowCanvas` cannot be resolved; `App` has no picker.

- [ ] **Step 3: Implement the loader**

`src/app/loadDocument.ts`:

```ts
import type { ApiResult, StudioApi } from '../api/client';
import { graphFromDto, processorFromDto, stepFromDto } from '../api/toModel';
import { parseLayout } from '../layout/layoutDoc';
import { place } from '../layout/placement';
import { routeWires } from '../layout/wires';
import type { Graph, Id } from '../model/graph';
import { reachableStepIds } from '../model/reachability';
import type { StudioDocument } from './document';

/**
 * Opens one workflow: the graph, then the parked steps its layout lists (they are not reachable, so
 * GET /graph does not return them; spec §4.3) and any processor they need, then placement and wires.
 * A parked id the server no longer has is dropped silently (spec §8); any other failure is returned.
 */
export async function loadDocument(api: StudioApi, workflowId: Id): Promise<ApiResult<StudioDocument>> {
  const loaded = await api.getGraph(workflowId);
  if (!loaded.ok) return loaded;

  const graph: Graph = graphFromDto(loaded.value);
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

  const placement = await place({
    entryStepIds: graph.workflow.entryStepIds,
    reachable: reachable.map((id) => ({ id, nextStepIds: graph.steps.get(id)!.nextStepIds })),
    parkedIds,
    cacheIds: [...graph.caches.keys()],
    layout,
  });
  const wires = routeWires({ entryStepIds: graph.workflow.entryStepIds, steps: graph.steps, processors: graph.processors }, placement);

  return { ok: true, value: { graph, parkedIds, placement, wires } };
}
```

- [ ] **Step 4: Implement the canvas surface and the legend**

`src/canvas/Legend.tsx`:

```tsx
import { CONDITIONS } from '../model/entryConditions';

/** The colour key (mockup v49, the legend builder): each entry condition, broken and parked. */
export function Legend() {
  return (
    <div className="legend">
      {CONDITIONS.map((c) => (
        <span key={c.value}>
          <span className="pill" style={{ background: c.colour }}>{c.letter}</span>
          <i style={{ borderColor: c.colour }} />
          {c.name}
        </span>
      ))}
      <span title={'Broken wire: Out schema ≠ In schema.\nAny wire can break, whatever its colour.'}>
        <svg width="28" height="14" viewBox="0 0 28 14" style={{ verticalAlign: 'middle', marginRight: 6 }}>
          <path d="M1 7 H9 M19 7 H27" stroke="#9FB0C8" strokeWidth="2" strokeDasharray="4 2.5" />
          <text x="14" y="11" fontSize="10" textAnchor="middle" fill="#9FB0C8">⚠</text>
        </svg>
        broken
      </span>
      <span title={'Parked step: placed but not wired in,\nso not part of the workflow.'}>
        <svg width="20" height="14" viewBox="0 0 20 14" style={{ verticalAlign: 'middle', marginRight: 6 }}>
          <rect x="1.5" y="1.5" width="17" height="11" rx="2.5" fill="none" stroke="#6B7A90" strokeWidth="1.4" strokeDasharray="3 2" />
        </svg>
        parked
      </span>
    </div>
  );
}
```

`src/canvas/WorkflowCanvas.tsx`:

```tsx
import { useMemo } from 'react';
import { ReactFlow, ReactFlowProvider, type EdgeTypes, type NodeTypes } from '@xyflow/react';
import type { StudioDocument } from '../app/document';
import { CableEdge } from './edges/CableEdge';
import { TetherEdge } from './edges/TetherEdge';
import type { TextFitter } from './fitText';
import { GridBackground } from './GridBackground';
import { Legend } from './Legend';
import { CacheNode } from './nodes/CacheNode';
import { StepNode } from './nodes/StepNode';
import { WorkflowNode } from './nodes/WorkflowNode';
import { toFlow } from './toFlow';

// Defined outside the component, as React Flow requires, so they are not re-created per render.
const nodeTypes: NodeTypes = { workflow: WorkflowNode, step: StepNode, cache: CacheNode };
const edgeTypes: EdgeTypes = { cable: CableEdge, tether: TetherEdge };

interface Props {
  doc: StudioDocument;
  fitter: TextFitter;
  /** Only for tests, where jsdom has no layout. */
  width?: number;
  height?: number;
}

/**
 * The read-only canvas (slice 2). Pan with Space+drag, the middle button or the wheel; Ctrl+wheel
 * zooms at the pointer (spec §5.4). Nothing can be dragged, connected or selected yet.
 */
export function WorkflowCanvas({ doc, fitter, width, height }: Props) {
  const { nodes, edges } = useMemo(() => toFlow(doc, fitter), [doc, fitter]);

  return (
    <ReactFlowProvider>
      <div className="studio-canvas" style={{ position: 'relative', width: width ?? '100%', height: height ?? '100%' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          width={width}
          height={height}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.12 }}
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
        >
          <GridBackground />
        </ReactFlow>
        <Legend />
      </div>
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 5: Implement the page**

`src/app.css`:

```css
html, body, #root { height: 100%; margin: 0; }
body { background: var(--ground); color: var(--ink); font-family: var(--sans); }
.app { display: grid; grid-template-rows: auto 1fr; height: 100%; }
.app-bar { display: flex; align-items: center; gap: 16px; padding: 8px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
.app-bar h1 { font-size: 15px; font-weight: 600; letter-spacing: .08em; margin: 0; color: var(--accent); }
.app-bar select { background: var(--panel-2); color: var(--ink); border: 1px solid var(--line-2); border-radius: 6px; padding: 4px 8px; font: 13px var(--sans); min-width: 280px; }
.app-status { font: 12px var(--mono); color: var(--muted); }
.app-status.error { color: var(--f); }
.app-main { position: relative; min-height: 0; }
.app-empty { display: grid; place-items: center; height: 100%; color: var(--faint); }
```

`src/App.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { createApi, type ApiError, type StudioApi } from './api/client';
import type { WorkflowReadDto } from './api/types';
import type { StudioDocument } from './app/document';
import { loadDocument } from './app/loadDocument';
import { canvasMeasure, createTextFitter, type TextFitter } from './canvas/fitText';
import { SvgDefs } from './canvas/SvgDefs';
import { WorkflowCanvas } from './canvas/WorkflowCanvas';

function describe(error: ApiError): string {
  switch (error.kind) {
    case 'notFound': return 'Not found.';
    case 'network': return `Network error: ${error.message}`;
    default: return `${error.status}: ${error.detail}`;
  }
}

const workflowFromUrl = () => new URLSearchParams(window.location.search).get('workflow');

/**
 * The slice-2 page: a picker, a status line and the canvas. The open workflow is in the URL
 * (`?workflow=<id>`), so a reload or a shared link reopens it. The dock arrives in plan 5.
 */
export function App({ api: injected }: { api?: StudioApi }) {
  const api = useMemo(() => injected ?? createApi(), [injected]);
  const [workflows, setWorkflows] = useState<WorkflowReadDto[]>([]);
  const [selected, setSelected] = useState<string | null>(workflowFromUrl);
  const [doc, setDoc] = useState<StudioDocument | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean }>({ text: '', error: false });
  const [fitter, setFitter] = useState<TextFitter | null>(null);

  // Labels are measured with the real fonts, so the fitter is made once the fonts have loaded.
  useEffect(() => {
    let live = true;
    const ready = document.fonts?.ready ?? Promise.resolve();
    void ready.then(() => { if (live) setFitter(createTextFitter(canvasMeasure())); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    void api.listWorkflows().then((r) => {
      if (r.ok) setWorkflows([...r.value].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')));
      else setStatus({ text: describe(r.error), error: true });
    });
  }, [api]);

  useEffect(() => {
    if (!selected) { setDoc(null); return; }
    let live = true;
    setStatus({ text: 'Loading…', error: false });
    void loadDocument(api, selected).then((r) => {
      if (!live) return;
      if (r.ok) { setDoc(r.value); setStatus({ text: '', error: false }); }
      else { setDoc(null); setStatus({ text: describe(r.error), error: true }); }
    });
    return () => { live = false; };
  }, [api, selected]);

  const open = (id: string) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('workflow', id); else url.searchParams.delete('workflow');
    window.history.replaceState(null, '', url);
    setSelected(id || null);
  };

  return (
    <div className="app">
      <SvgDefs />
      <header className="app-bar">
        <h1>SKP STUDIO</h1>
        <select aria-label="Workflow" value={selected ?? ''} onChange={(e) => open(e.target.value)}>
          <option value="">Open a workflow…</option>
          {workflows.map((w) => <option key={w.id} value={w.id ?? ''}>{`${w.name} ${w.version}`}</option>)}
        </select>
        <span role="status" className={status.error ? 'app-status error' : 'app-status'}>{status.text}</span>
      </header>
      <main className="app-main">
        {doc && fitter ? <WorkflowCanvas doc={doc} fitter={fitter} /> : <div className="app-empty">{selected ? '' : 'Pick a workflow to open it.'}</div>}
      </main>
    </div>
  );
}
```

`src/main.tsx` (replace):

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans-condensed/400.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@xyflow/react/dist/style.css';
import './canvas/tokens.css';
import './canvas/canvas.css';
import './app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: Run the whole suite, the typecheck and the build**

```bash
npm test
npm run typecheck
npm run build
```

Expected: every test file passes, 0 failed, and the output has no React or React Flow warnings (an `act(...)` warning or "React Flow parent container needs a width and a height" in the output is a defect to fix, not noise); typecheck clean; build succeeds.

- [ ] **Step 7: Look at it against the live BaseApi**

With `k8s/port-forward-realstack.ps1` running (BaseApi on `localhost:18080`):

```bash
npm run dev
```

Open `http://localhost:5173`, pick a workflow, and check by eye: the sphere and the steps are drawn as in the mockup; wires that line up are straight; bent wires land on the processor middle; the grid's fine tier disappears when zoomed out below 60 %; Ctrl+wheel zooms at the pointer; Space+drag and the middle button pan. Report what you saw, including anything that does not match.

- [ ] **Step 8: Commit**

```bash
git add src/WorkflowStudio/src
git commit -m "feat(studio): read-only workflow canvas with picker, loader and legend"
```

---

### Task 9: nginx container, k8s manifest and the live check

**Files:**
- Create: `src/WorkflowStudio/Dockerfile`, `src/WorkflowStudio/nginx.conf`, `k8s/31-workflow-studio.yaml`
- Modify: `k8s/kustomization.yaml`, `k8s/port-forward-realstack.ps1`, `k8s/README.md`

**Interfaces:**
- Consumes: the built app (Task 8). BaseApi's Service `baseapi-service:8080` in namespace `skp`.
- Produces: image `workflow-studio:local`; Service `workflow-studio` port 8080; a port-forward on `localhost:18081`.

- [ ] **Step 1: Write the Dockerfile and nginx config**

`src/WorkflowStudio/Dockerfile` (build context: the repo root, like BaseApi's):

```dockerfile
# SKP Studio: a static Vite build served by nginx, which also proxies /api/ to BaseApi so the
# browser stays same-origin (BaseApi has no CORS policy). Build from the repo root:
#   docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
FROM node:24-alpine AS build
WORKDIR /app
COPY src/WorkflowStudio/package.json src/WorkflowStudio/package-lock.json ./
RUN npm ci
COPY src/WorkflowStudio/ ./
RUN npm run build

FROM nginx:1.29-alpine
COPY src/WorkflowStudio/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
```

`src/WorkflowStudio/nginx.conf`:

```nginx
server {
    listen 8080;
    root /usr/share/nginx/html;

    # Same origin for the API: the path is passed through unchanged (/api/v1/...).
    location /api/ {
        proxy_pass http://baseapi-service:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 32m;
    }

    location = /healthz {
        default_type text/plain;
        return 200 'ok';
    }

    # Hashed assets can be cached forever; index.html must not be, or a deploy is not picked up.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
        add_header Cache-Control "no-cache";
        try_files $uri /index.html;
    }
}
```

- [ ] **Step 2: Write the manifest and wire it in**

`k8s/31-workflow-studio.yaml`:

```yaml
# SKP Studio: the visual workflow editor (spec docs/superpowers/specs/2026-10-05-skp-studio-design.md).
#
# A static React build served by nginx. nginx also proxies /api/ to baseapi-service, so the browser
# talks to one origin: BaseApi has no CORS policy, and the studio must not need one.
#
# Build and load (from the repo root; the kind cluster is named "desktop"):
#   docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
#   kind load docker-image workflow-studio:local --name desktop
#   kubectl apply -f k8s/31-workflow-studio.yaml
# Reach it through k8s/port-forward-realstack.ps1: http://localhost:18081
apiVersion: v1
kind: Service
metadata:
  name: workflow-studio
  namespace: skp
  labels:
    app: workflow-studio
    app.kubernetes.io/part-of: skp
spec:
  selector:
    app: workflow-studio
  ports:
    - name: http
      port: 8080
      targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workflow-studio
  namespace: skp
  labels:
    app: workflow-studio
    app.kubernetes.io/part-of: skp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: workflow-studio
  template:
    metadata:
      labels:
        app: workflow-studio
        app.kubernetes.io/part-of: skp
    spec:
      containers:
        - name: workflow-studio
          image: workflow-studio:local
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 8080
          resources:
            requests:
              memory: 32Mi
            limits:
              memory: 128Mi
          startupProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 2
            failureThreshold: 30
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /healthz, port: 8080 }
            periodSeconds: 20
```

Before writing it, open `k8s/30-baseapi-service.yaml` and match its probe and resource style (field order, `periodSeconds` values, whether probes use the flow style above or the block style). Keep the values above where the BaseApi file has no equivalent.

In `k8s/kustomization.yaml`, add `- 31-workflow-studio.yaml` to `resources` directly after `- 30-baseapi-service.yaml`.

In `k8s/port-forward-realstack.ps1`, add one row to the `$forwards` table after the `baseapi-service` row:

```powershell
    @{ svc = "workflow-studio";local = 18081; remote = 8080 },
```

In `k8s/README.md`, in the section that lists images to build and load, add the studio's three commands from the manifest header, with `--name desktop` on the `kind load` line.

- [ ] **Step 3: Build the image locally**

```bash
docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
```

Expected: the build finishes with `naming to docker.io/library/workflow-studio:local`.

- [ ] **Step 4: Commit**

```bash
git add src/WorkflowStudio/Dockerfile src/WorkflowStudio/nginx.conf k8s/31-workflow-studio.yaml k8s/kustomization.yaml k8s/port-forward-realstack.ps1 k8s/README.md
git commit -m "feat(studio): nginx image, k8s manifest and port-forward for SKP Studio"
```

- [ ] **Step 5: Deploy and check it live (ask the user first: this adds a deployment to the shared dev cluster)**

```bash
kind load docker-image workflow-studio:local --name desktop
kubectl apply -f k8s/31-workflow-studio.yaml
kubectl -n skp rollout status deploy/workflow-studio --timeout=120s
```

Restart the port-forward supervisor so it picks up the new row (PowerShell):

```powershell
./k8s/port-forward-realstack.ps1 -Stop
./k8s/port-forward-realstack.ps1
```

Then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:18081/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:18081/api/v1/workflows
```

Expected: `200` and `200` (the second proves the same-origin proxy reaches BaseApi). Open `http://localhost:18081` for the user (`Start-Process "http://localhost:18081"` in PowerShell) and ask them to try it: they approve visual work by using it.

---

## Self-review notes

- **Spec coverage (slice 2, "load, render and route with the section 5 visuals"):** `api/` typed client and error mapping (§3.1) — Task 2; `model/` rules (§3.1, §9) — Task 3; `layout/` placement with elkjs for blocks without positions, stale ids ignored (§4.3, §8) — Task 4; routing straight / Z / U, landing band, bent → processor middle, fan-out spacing, arrows 16 apart, grid alignment (§5.2, §9) — Task 5; the lit grid with the 60 % rule, theme, fonts (§5.1) — Task 6; sphere, glass-cap step with processor die, cache, broken and parked styles, colours and pills (§5.1, §5.3) — Tasks 6–7; pan and zoom bindings and label shortening with tooltips (§5.4) — Tasks 7–8; nginx same-origin serving (§2, §3.1) — Task 9.
- **Deliberately not here:** editing, manual routes, alignment guides, undo, save (plan 3); Inspector, Problems (plan 4); dock (plan 5); toolbox (plan 6); junctions (plan 7); Playwright (plan 5 sets it up).
- **Type consistency checked:** `Placement`, `Sphere`, `Point`, `Pt`, `Box`, `WireRoute`, `WireEnd`, `SourceId`, `WORKFLOW_SOURCE`, `StudioDocument`, `TextFitter`, `FittedText`, `StepNodeData`, `ProcessorView`, `WorkflowNodeData`, `CacheNodeData`, `CableEdgeData`, `TetherEdgeData`, `SPHERE_NODE_ID`, `cacheNodeId` are each defined once and used with the same names and fields everywhere.

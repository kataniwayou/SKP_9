# SKP Studio 3b: Inspector Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Inspector edits each entity's own metadata (spec §7.1): read with `GET /{entity}/{id}`, save with `PUT` of the update DTO, drill from a step to its processor, its schemas and its assignment, add / edit / unlink a step's assignment, show server errors, and refresh every open document after a write. Unsaved edits are a document's draft: kept in the session, restored after a refresh, marked unsaved, and never dropped without Save / Discard / Cancel.

**Architecture:**
- **api/** gains one generic read and one generic write per entity kind (`getEntity`, `putEntity`) plus `createAssignment`. A 400 keeps its field messages.
- **store/** holds the Inspector's state per open document: the drill-down trail and the typed edits (the draft, kept in the session), and the last GET, read errors and save failures (not kept). Two pure modules describe targets (`inspectorTarget.ts`) and forms (`entityForms.ts`: field specs, the DTO round trip, error mapping).
- **app/inspectorService.ts** does the I/O: GET the shown entity, save (a fresh GET, then PUT of that DTO with only the edits changed), create and link an assignment, unlink one. A `StudioActions` context hands the service and a navigation guard to the panes.
- **The page** guards every navigation that would leave unsaved edits (canvas selection, Escape, Problems, drill-down and back, closing the document) with a Save / Discard / Cancel dialog, re-reads every open document after a write, shows the unsaved dot on the tab, enables the capsule's Save, and lets a failed document retry.

**Tech Stack:** React 19.3, dockview-react 8.4.1, @xyflow/react 12.12, TypeScript, Vitest 5 + Testing Library (jsdom), Playwright e2e against the live BaseApi.

**Spec:** `docs/superpowers/specs/2026-10-05-skp-studio-design.md`: §7.1 (what the Inspector edits), §6.1 (the session and its draft constraints), §8 (Inspector save errors), §9 (the DTO round trip, e2e that never edit shared data), §10 slice 3b. Task 9 amends §7.1 with the decisions below.

## Decisions this plan makes (please confirm at review)

1. **One Inspector draft per document.** Leaving an entity with unsaved edits always asks Save / Discard / Cancel, so a document never holds edits for two entities. The draft is the drill-down trail plus the typed text by field; it is kept in the session (`SessionDoc.draft`, an optional field, no version bump, spec §6.1) and restored on top of a fresh GET after a refresh. A field typed back to its saved value stops counting as an edit.
2. **Save re-reads before it writes.** Save does a fresh `GET`, then `PUT`s that DTO with only the edited writable fields replaced. Structural fields (`NextStepIds`, `EntryStepIds`, `AssignmentIds`, `CacheIds`, `StepId`, `ProcessorId`, schema ids) therefore go back exactly as the server holds them at that moment, never as an older read had them. This narrows, but does not remove, last-write-wins (spec §7.1 accepts it).
3. **What "unsaved" looks like.** The Inspector shows "● unsaved changes", the document's tab shows the amber dot (mockup v49 `.doctab.dirty .ud`), and the capsule toolbar's Save is enabled and saves the Inspector's edits.
4. **After any write** (save, create, unlink) every open document re-reads its graph and re-runs validate, keeping its view and selection, and every document's Inspector re-reads its shown entity in place (no flicker). A document whose re-read fails keeps its last drawing, and a toast says so. A renamed workflow's tab takes its new name.
5. **The dialog** is the mockup's `.modal` ("Unsaved changes": Cancel, Discard, Save; Save focused). It opens in the window the action came from (a pop-out included). If Save fails, the dialog closes, nothing moves, and the Inspector shows why. Unlinking an assignment asks in the same dialog ("Unlink assignment": Cancel, Unlink).
6. **Browser-side checks are only the spec's two:** Save is disabled while Name or Version is empty (the placeholder shows the saved value), and JSON fields say "Not valid JSON" while typing but still let the server judge. Everything else is BaseApi's: a 400's messages show under their fields (`errors` keys are C# property names, `Name` → `name`); messages for fields the form does not edit, and every 404 / 409 / 422, go in a banner; a network failure is "Not saved: BaseApi unreachable".
7. **Adding an assignment** opens a "New assignment" form prefilled with Name `{step name}-assignment`, Version `1.0.0`, Payload `{}`. Create POSTs it, then re-reads the workflow and PUTs it with the new id added to `AssignmentIds`. A failed second call leaves the new assignment shown with the banner "Created but not linked to this workflow: …".
8. **A restored draft that cannot be read** (the entity was deleted, BaseApi is down) shows why, and offers "Discard unsaved changes". A failed document keeps its draft, and its panel gets a **Retry** button (parked from 3a).
9. **Smaller items folded in:** a session write the browser refuses shows a toast once per failure streak (spec §6.1); `writeTabSession` reports success when a refresh will find the session; a schema read whose body has no id no longer fails the whole open (parked from 3a).
10. **e2e tests never edit shared data** (spec §9). The new spec creates its own `e2e-3b-…` schema, processor, step, cache and workflow through BaseApi, edits only those, and deletes them afterwards. The other specs skip workflows named `e2e-…`.
11. **Not in this slice:** Toolbox (untouched, as instructed), canvas editing, the richer editors of §7.2, Start/Stop, delete.

## Global Constraints

- **Location.** The app lives in `src/WorkflowStudio`. Every command runs **from `src/WorkflowStudio`** unless it says otherwise; **commit steps run from the repository root**.
- **Shells.** Run `npm run …` and `npm test` **in PowerShell**: in Git Bash `npm run` prints nothing and exits 1. `npx …` works in either shell.
- **No dependency changes.** `.npmrc` keeps `legacy-peer-deps=true`.
- **Same origin only**, relative `/api/v1/` URLs.
- **Writes.** The only writes are `PUT /{workflows|steps|processors|schemas|assignments|caches}/{id}` and `POST /assignments` (spec §10 slice 3b: "the only POST is creating an assignment; no DELETE"), plus the existing validate dry run. Start and Stop stay disabled. Nothing on the canvas is draggable.
- **The browser runs no JSON Schema validator** and re-checks no business rule (spec §7.1).
- **Boundaries.**
  - `model/` and `layout/` hold no React and no I/O.
  - **`dock/` imports nothing from `canvas/`, `panels/`, `app/` or `store/`.**
  - `canvas/` imports nothing from `app/`.
  - `store/` holds no React except `studioStore.ts`'s hooks, and no I/O.
- **Persistence (spec §6.1).** The draft is an optional field of each session document; `SESSION_VERSION` stays `1`. Every storage access is in try/catch. A draft that does not validate is dropped, never the session.
- **Rendering rules (spec §6.3).** Code inside a panel uses its own document. Overlay z-index values come only from the `--z-*` tokens (the dialog uses `--z-modal`).
- **Plans 2, 3a, 3c and 3d keep working:** selection classes, live art, re-fit and keep-centre on resize, Window › Save/Apply/Reset, exact re-dock memory, the refresh-proof session, the keyboard behaviour.
- **Do not touch the Toolbox:** `src/panels/PaneNote.tsx`, and the Toolbox's entries in `src/dock/ids.ts`.
- **Machine notes.**
  - Windows; the Bash tool is Git Bash. Write files with the Write or Edit tool (heredocs with apostrophes fail).
  - Stage only the files a task names, by name. Leave no line-ending-only changes behind (`git status` clean of tracked files after each commit).
  - Never touch `.wf-restore.json`, `tools/simulate-*.py`, `.playwright-mcp/` or `docs/HANDOVER-*.md`.
  - The kind cluster is `desktop`.
- **Commits** end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (as a second `-m`).
- **Test commands.**
  - `npm test`, `npm run typecheck`, `npm run build`, and focused runs with `npx vitest run <path>`.
  - `npm run e2e` needs BaseApi on `localhost:18080` (`..\..\k8s\port-forward-realstack.ps1 -Status`). 34 e2e tests pass before this plan.
  - A run that collects 0 tests is a failure.
- **Clean output.** A React warning in test output is a defect.

## Review Focus

The failure modes most likely to bite, each pinned by a test in the owning task:

1. **Keystrokes typed while a save is in flight are not lost.** Save clears only the edits it sent. Task 3 (`saved` reducer) and Task 4 (service).
2. **An answer that arrives after the user moved on is dropped.** A GET for an entity the Inspector no longer shows never fills it. Task 3 (`read` reducer) and Task 4.
3. **Structural fields go back as the server holds them now.** Save builds its PUT from a GET made at save time, not from the read the form was filled from. Task 4.
4. **A restored draft whose entity is gone never breaks the pane.** It shows why and can be discarded; the guard still offers Save/Discard on close. Task 5 and Task 7.
5. **Escape inside the dialog cancels the dialog only.** It neither clears the selection nor closes anything else. Task 7.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/api/types.ts` | The assignment and update DTO types | 1 |
| `src/api/entities.ts` (new) | `EntityKind`, DTO maps, URL segments | 1 |
| `src/api/client.ts` | `getEntity`, `putEntity`, `createAssignment`; a 400's field messages | 1 |
| `src/api/describeError.ts` (new) | `describeError`, moved out of `App.tsx` | 1 |
| `src/api/fixtures.ts` | `assignmentDto` | 1 |
| `src/store/inspectorTarget.ts` (new) | What the Inspector shows: targets, keys, labels, validation | 2 |
| `src/store/entityForms.ts` (new) | Field specs, the DTO round trip, error mapping, the new-assignment defaults | 2 |
| `src/store/inspector.ts` (new) | `InspectorDraft`, `InspectorState`, `SaveFailure` | 3 |
| `src/store/studioState.ts` | The Inspector actions; `refreshed`, `retry`; names follow the graph | 3 |
| `src/app/session.ts` | `SessionDoc.draft`; `writeTabSession` fix | 3 |
| `src/app/inspectorService.ts` (new) | read, save, create, unlink | 4 |
| `src/app/studioActions.ts` (new) | The `StudioActions` context; `useGuard` | 4 |
| `src/test/inspector.tsx` (new) | Test harness for the Inspector | 5 |
| `src/panels/inspectorView.ts` | Read-only rows from a DTO; kind pill | 5 |
| `src/panels/Inspector.tsx`, `src/panels/FieldEditor.tsx` (new) | The editing Inspector | 5, 6 |
| `src/panels/panels.css` | Form, breadcrumb, banner and save-bar styles | 5 |
| `src/app/ConfirmDialog.tsx` (new), `src/app/document.css` | The Save / Discard / Cancel dialog | 7 |
| `src/App.tsx`, `src/app/DocumentPanel.tsx`, `src/panels/Problems.tsx` | Guard, refresh after write, retry, service wiring | 7 |
| `src/dock/DockShell.tsx`, `src/dock/parts.tsx`, `src/dock/dock.css` | Tab unsaved dot; `notice` toast | 8 |
| `src/app/CapsuleToolbar.tsx`, `src/app/loadDocument.ts` | Capsule Save; schema read guard | 8 |
| `e2e/throwaway.ts` (new), `e2e/inspector.spec.ts` (new), `e2e/studio.ts` | Writing e2e on throwaway entities | 9 |
| `docs/superpowers/specs/2026-10-05-skp-studio-design.md` | §7.1 amended | 9 |

---

### Task 1: The API reads and writes each entity

**Files:**
- Modify: `src/api/types.ts`, `src/api/client.ts`, `src/api/fixtures.ts`, `src/App.tsx`
- Create: `src/api/entities.ts`, `src/api/describeError.ts`
- Test: `src/api/client.test.ts`; every test file with an object literal typed `StudioApi` (at least `src/App.test.tsx`)

**Interfaces:**
- Produces:
  - `type EntityKind = 'workflow' | 'step' | 'processor' | 'schema' | 'assignment' | 'cache'`, `ReadDtoOf`, `UpdateDtoOf`, `EntityReadDto`, `ENTITY_PATH` (`api/entities.ts`).
  - `StudioApi.getEntity<K>(kind: K, id: string): Promise<ApiResult<ReadDtoOf[K]>>`, `putEntity<K>(kind: K, id: string, dto: UpdateDtoOf[K]): Promise<ApiResult<ReadDtoOf[K]>>`, `createAssignment(dto: AssignmentCreateDto): Promise<ApiResult<AssignmentReadDto>>`.
  - `ApiError` `badRequest` gains `errors: Record<string, string[]>`.
  - `describeError(error: ApiError): string` in `api/describeError.ts` (App re-exports it).
  - `assignmentDto(id, over?)` in `api/fixtures.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/api/client.test.ts`, add inside `describe('createApi', …)`:

```ts
  it.each([
    ['workflow', '/api/v1/workflows/x'],
    ['step', '/api/v1/steps/x'],
    ['processor', '/api/v1/processors/x'],
    ['schema', '/api/v1/schemas/x'],
    ['assignment', '/api/v1/assignments/x'],
    ['cache', '/api/v1/caches/x'],
  ] as const)('GETs a %s from %s', async (kind, url) => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, { id: 'x' }));
    expect(await createApi('/api/v1', fetchImpl).getEntity(kind, 'x')).toEqual({ ok: true, value: { id: 'x' } });
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'GET' }));
  });

  it('PUTs an entity with its update DTO as JSON and returns what the server read back', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, { id: 's1', name: 'renamed' }));
    const dto = { name: 'renamed', version: '1.0.0', description: null, processorId: 'p1', nextStepIds: ['s2'], entryCondition: 1 as const };

    const result = await createApi('/api/v1', fetchImpl).putEntity('step', 's1', dto);

    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/steps/s1', expect.objectContaining({ method: 'PUT', body: JSON.stringify(dto) }));
    expect(fetchImpl.mock.calls[0]![1].headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(result).toEqual({ ok: true, value: { id: 's1', name: 'renamed' } });
  });

  it('POSTs a new assignment and returns the 201 body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(201, { id: 'a9', stepId: 's1' }));
    const dto = { name: 'fetch-assignment', version: '1.0.0', description: null, stepId: 's1', payload: '{}' };

    expect(await createApi('/api/v1', fetchImpl).createAssignment(dto)).toEqual({ ok: true, value: { id: 'a9', stepId: 's1' } });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/assignments', expect.objectContaining({ method: 'POST', body: JSON.stringify(dto) }));
  });

  it("keeps a 400's field messages by property name, and only the strings", async () => {
    const api = createApi('/api/v1', vi.fn().mockResolvedValue(respond(400, {
      title: 'Validation failed',
      errors: { Version: ['Version must be x.y.z.'], CronExpression: ['Bad cron.', 7], Junk: 'not a list' },
    })));

    expect(await api.putEntity('workflow', 'wf1', {})).toEqual({
      ok: false,
      error: { kind: 'badRequest', status: 400, detail: 'Validation failed', errors: { Version: ['Version must be x.y.z.'], CronExpression: ['Bad cron.'] } },
    });
  });
```

Any existing test in this file that expects a `badRequest` error gains `errors: {}` in its expectation (a 400 without `errors` keeps an empty map).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/api/client.test.ts`
Expected: FAIL (`getEntity`, `putEntity`, `createAssignment` are not functions; no `errors`).

- [ ] **Step 3: The DTO types**

Append to `src/api/types.ts`:

```ts
export type AssignmentReadDto = Schemas['AssignmentReadDto'];
export type AssignmentCreateDto = Schemas['AssignmentCreateDto'];
export type WorkflowUpdateDto = Schemas['WorkflowUpdateDto'];
export type StepUpdateDto = Schemas['StepUpdateDto'];
export type ProcessorUpdateDto = Schemas['ProcessorUpdateDto'];
export type SchemaUpdateDto = Schemas['SchemaUpdateDto'];
export type AssignmentUpdateDto = Schemas['AssignmentUpdateDto'];
export type CacheUpdateDto = Schemas['CacheUpdateDto'];
```

Create `src/api/entities.ts`:

```ts
import type {
  AssignmentReadDto, AssignmentUpdateDto, CacheReadDto, CacheUpdateDto, ProcessorReadDto, ProcessorUpdateDto,
  SchemaReadDto, SchemaUpdateDto, StepReadDto, StepUpdateDto, WorkflowReadDto, WorkflowUpdateDto,
} from './types';

/** The six entities the Inspector reads and saves (spec §7.1), each at `/{ENTITY_PATH[kind]}/{id}`. */
export type EntityKind = 'workflow' | 'step' | 'processor' | 'schema' | 'assignment' | 'cache';

export interface ReadDtoOf {
  workflow: WorkflowReadDto;
  step: StepReadDto;
  processor: ProcessorReadDto;
  schema: SchemaReadDto;
  assignment: AssignmentReadDto;
  cache: CacheReadDto;
}

export interface UpdateDtoOf {
  workflow: WorkflowUpdateDto;
  step: StepUpdateDto;
  processor: ProcessorUpdateDto;
  schema: SchemaUpdateDto;
  assignment: AssignmentUpdateDto;
  cache: CacheUpdateDto;
}

export type EntityReadDto = ReadDtoOf[EntityKind];

export const ENTITY_PATH: Record<EntityKind, string> = {
  workflow: 'workflows', step: 'steps', processor: 'processors', schema: 'schemas', assignment: 'assignments', cache: 'caches',
};
```

- [ ] **Step 4: The client**

In `src/api/client.ts`:

- Import `type EntityKind, ENTITY_PATH, type ReadDtoOf, type UpdateDtoOf` from `./entities` and `AssignmentCreateDto, AssignmentReadDto` from `./types`.
- Change the `badRequest` member of `ApiError` to `{ kind: 'badRequest'; status: 400; detail: string; errors: Record<string, string[]> }`.
- Add to `StudioApi`, after `getSchema`:

```ts
  /** `GET /{entity}/{id}`: the entity's read DTO, the Inspector's baseline (spec §7.1). */
  getEntity<K extends EntityKind>(kind: K, id: string): Promise<ApiResult<ReadDtoOf[K]>>;
  /** `PUT /{entity}/{id}` with the full update DTO; BaseApi answers 200 with the entity read back. */
  putEntity<K extends EntityKind>(kind: K, id: string, dto: UpdateDtoOf[K]): Promise<ApiResult<ReadDtoOf[K]>>;
  /** `POST /assignments`: the only create in slice 3b; BaseApi answers 201 with the new assignment. */
  createAssignment(dto: AssignmentCreateDto): Promise<ApiResult<AssignmentReadDto>>;
```

- Add `errors?: unknown;` to `interface Problem`, and this helper after `readProblem`:

```ts
/** ValidationProblemDetails' `errors` (C# property name → messages), read defensively. */
function fieldErrorsOf(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, messages] of Object.entries(value)) {
    const list = Array.isArray(messages) ? messages.filter((m): m is string => typeof m === 'string') : [];
    if (list.length > 0) out[key] = list;
  }
  return out;
}
```

- In `toError`, the 400 case becomes `return { kind: 'badRequest', status: 400, detail, errors: fieldErrorsOf(problem.errors) };`.
- Replace `request` with a version that can send a JSON body:

```ts
  async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<ApiResult<T>> {
    const init: RequestInit = body === undefined
      ? { method, headers: { Accept: 'application/json' } }
      : { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, init);
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
```

- Add to the returned object, after `getSchema`:

```ts
    getEntity<K extends EntityKind>(kind: K, entityId: string) {
      return get<ReadDtoOf[K]>(`/${ENTITY_PATH[kind]}/${id(entityId)}`);
    },
    putEntity<K extends EntityKind>(kind: K, entityId: string, dto: UpdateDtoOf[K]) {
      return request<ReadDtoOf[K]>('PUT', `/${ENTITY_PATH[kind]}/${id(entityId)}`, dto);
    },
    createAssignment: (dto) => request<AssignmentReadDto>('POST', '/assignments', dto),
```

- [ ] **Step 5: `describeError` moves; fixtures; test fakes**

Create `src/api/describeError.ts` with the function moved from `App.tsx` unchanged:

```ts
import type { ApiError } from './client';

/** One line for any failed request, as the page and the Inspector show it. */
export function describeError(error: ApiError): string {
  switch (error.kind) {
    case 'notFound': return 'This workflow no longer exists.';
    case 'network': return `Network error: ${error.message}`;
    default: return error.status === 0 ? error.detail : `${error.status}: ${error.detail}`;
  }
}
```

In `src/App.tsx`, delete the function, import it from `./api/describeError`, and add `export { describeError } from './api/describeError';` so existing imports keep working.

Append to `src/api/fixtures.ts` (import `AssignmentReadDto`):

```ts
export function assignmentDto(id: string, over: Partial<AssignmentReadDto> = {}): AssignmentReadDto {
  return { id, name: `assignment-${id}`, version: '1.0.0', description: null, stepId: 's1', payload: '{}', ...audit, ...over } as AssignmentReadDto;
}
```

Run `npm run typecheck`. Every object literal typed `StudioApi` in a test (at least `fakeApi` in `src/App.test.tsx`) now misses the three methods: add

```ts
    getEntity: vi.fn().mockResolvedValue(notFound),
    putEntity: vi.fn().mockResolvedValue(notFound),
    createAssignment: vi.fn().mockResolvedValue(notFound),
```

(using that file's own `notFound` constant).

- [ ] **Step 6: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src/api`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS, no warnings.

```bash
git add src/WorkflowStudio/src/api/types.ts src/WorkflowStudio/src/api/entities.ts src/WorkflowStudio/src/api/client.ts src/WorkflowStudio/src/api/client.test.ts src/WorkflowStudio/src/api/describeError.ts src/WorkflowStudio/src/api/fixtures.ts src/WorkflowStudio/src/App.tsx src/WorkflowStudio/src/App.test.tsx
git commit -m "feat(studio): the API reads and saves each entity, creates an assignment, and keeps a 400's field messages" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add any other test file whose `StudioApi` fake you extended.)

---

### Task 2: What the Inspector shows, and the DTO round trip

**Files:**
- Create: `src/store/inspectorTarget.ts`, `src/store/entityForms.ts`
- Test: `src/store/inspectorTarget.test.ts`, `src/store/entityForms.test.ts`

**Interfaces:**
- Consumes: `EntityKind`, `ReadDtoOf`, `UpdateDtoOf`, `EntityReadDto` (Task 1).
- Produces (`store/inspectorTarget.ts`): `SchemaSlot`, `InspectorTarget`, `rootTarget(selection, workflowId)`, `currentTarget(root, trail)`, `targetKey(target | null)`, `entityKindOf(target)`, `crumbLabel(target)`, `isTarget(value)`.
- Produces (`store/entityForms.ts`): `FieldKind`, `FieldSpec`, `FIELDS`, `UPDATE_KEYS`, `savedText(dto, key)`, `shownText(dto, edits, key)`, `updateDto(kind, saved, edits)`, `missingRequired(kind, dto, edits)`, `jsonProblem(text)`, `splitErrors(kind, errors)`, `newAssignmentDto(step)`, `createAssignmentDto(saved, edits)`.

- [ ] **Step 1: Write the failing tests**

Create `src/store/inspectorTarget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { crumbLabel, currentTarget, entityKindOf, isTarget, rootTarget, targetKey, type InspectorTarget } from './inspectorTarget';

describe('inspector targets', () => {
  it('starts from the selection', () => {
    expect(rootTarget(null, 'wf1')).toBeNull();
    expect(rootTarget({ kind: 'workflow' }, 'wf1')).toEqual({ kind: 'workflow', id: 'wf1' });
    expect(rootTarget({ kind: 'step', stepId: 's1' }, 'wf1')).toEqual({ kind: 'step', id: 's1' });
    expect(rootTarget({ kind: 'processor', processorId: 'p1', stepId: 's1' }, 'wf1')).toEqual({ kind: 'processor', id: 'p1' });
    expect(rootTarget({ kind: 'cache', cacheId: 'c1' }, 'wf1')).toEqual({ kind: 'cache', id: 'c1' });
  });

  it('shows the last drill-down, else the selection', () => {
    const root: InspectorTarget = { kind: 'step', id: 's1' };
    const schema: InspectorTarget = { kind: 'schema', id: 'sc1', slot: 'config' };
    expect(currentTarget(root, [])).toBe(root);
    expect(currentTarget(root, [{ kind: 'processor', id: 'p1' }, schema])).toBe(schema);
  });

  it('keys, kinds and labels', () => {
    expect(targetKey(null)).toBe('none');
    expect(targetKey({ kind: 'schema', id: 'sc1', slot: 'input' })).toBe('schema:sc1');
    expect(targetKey({ kind: 'newAssignment', stepId: 's1', stepName: 'fetch' })).toBe('newAssignment:s1');
    expect(entityKindOf({ kind: 'newAssignment', stepId: 's1', stepName: 'fetch' })).toBe('assignment');
    expect(crumbLabel({ kind: 'schema', id: 'sc1', slot: 'config' })).toBe('Config schema');
    expect(crumbLabel({ kind: 'newAssignment', stepId: 's1', stepName: 'fetch' })).toBe('New assignment');
  });

  it('accepts only well-formed targets (a restored draft is checked with it)', () => {
    expect(isTarget({ kind: 'step', id: 's1' })).toBe(true);
    expect(isTarget({ kind: 'schema', id: 'sc1', slot: 'config' })).toBe(true);
    expect(isTarget({ kind: 'assignment', id: 'a1', stepId: 's1' })).toBe(true);
    expect(isTarget({ kind: 'newAssignment', stepId: 's1', stepName: '' })).toBe(true);
    expect(isTarget({ kind: 'schema', id: 'sc1', slot: 'other' })).toBe(false);
    expect(isTarget({ kind: 'assignment', id: 'a1' })).toBe(false);
    expect(isTarget({ kind: 'step', id: '' })).toBe(false);
    expect(isTarget({ kind: 'wire', id: 'w1' })).toBe(false);
    expect(isTarget('step')).toBe(false);
  });
});
```

Create `src/store/entityForms.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EntityKind } from '../api/entities';
import { assignmentDto, cacheDto, processorDto, schemaDto, stepDto, workflowDto } from '../api/fixtures';
import {
  createAssignmentDto, jsonProblem, missingRequired, newAssignmentDto, savedText, shownText, splitErrors, UPDATE_KEYS, updateDto,
} from './entityForms';

describe('updateDto: the DTO round trip (spec §9)', () => {
  it('sends a workflow back as read, with only its writable fields changed', () => {
    const read = workflowDto({ entryStepIds: ['s1', 's2'], assignmentIds: ['a1'], cacheIds: ['c1'], cronExpression: '0 * * * *', description: 'old' });
    expect(updateDto('workflow', read, { name: 'renamed', cronExpression: '' })).toEqual({
      name: 'renamed', version: '1.0.0', description: 'old', entryStepIds: ['s1', 's2'], assignmentIds: ['a1'], cacheIds: ['c1'], cronExpression: null,
    });
  });

  it("sends a step's next steps and processor back unchanged, and its entry condition as a number", () => {
    const read = stepDto('s1', { nextStepIds: ['s2', 's3'], processorId: 'p9', entryCondition: 1 });
    expect(updateDto('step', read, { entryCondition: '4', description: 'now' })).toEqual({
      name: 'step-s1', version: '1.0.0', description: 'now', processorId: 'p9', nextStepIds: ['s2', 's3'], entryCondition: 4,
    });
  });

  it('keeps a null structural list null', () => {
    expect(updateDto('step', stepDto('s1', { nextStepIds: null }), {}).nextStepIds).toBeNull();
  });

  it("sends a processor's schema ids back unchanged; a blank instance id is null", () => {
    const read = processorDto('p1', { inputSchemaId: 'i1', outputSchemaId: null, configSchemaId: 'c1', instanceId: 'east' });
    expect(updateDto('processor', read, { instanceId: '  ' })).toEqual({
      name: 'proc-p1', version: '1.0.0', description: null, sourceHash: 'a'.repeat(64), instanceId: null,
      inputSchemaId: 'i1', outputSchemaId: null, configSchemaId: 'c1',
    });
  });

  it("sends an assignment's step back unchanged", () => {
    expect(updateDto('assignment', assignmentDto('a1', { stepId: 's7', payload: '{"k":1}' }), { payload: '{"k":2}' })).toEqual({
      name: 'assignment-a1', version: '1.0.0', description: null, stepId: 's7', payload: '{"k":2}',
    });
  });

  it('sends a schema and a cache with their writable fields, JSON text as typed', () => {
    expect(updateDto('schema', schemaDto('sc1'), { definition: '{"type":"object"}' })).toEqual({
      name: 'schema-sc1', version: '1.0.0', description: null, definition: '{"type":"object"}',
    });
    expect(updateDto('cache', cacheDto('c1'), { root: 'orders', items: '{"a":"b"}' })).toEqual({
      name: 'cache-c1', version: '1.0.0', description: null, root: 'orders', items: '{"a":"b"}',
    });
  });

  it('never sends the id or an audit field: exactly the update DTO keys', () => {
    const reads: Record<EntityKind, object> = {
      workflow: workflowDto(), step: stepDto('s1'), processor: processorDto('p1'), schema: schemaDto('sc1'), assignment: assignmentDto('a1'), cache: cacheDto('c1'),
    };
    for (const kind of Object.keys(reads) as EntityKind[]) {
      expect(Object.keys(updateDto(kind, reads[kind] as never, {}))).toEqual([...UPDATE_KEYS[kind]]);
    }
  });
});

describe('form helpers', () => {
  it('reads saved values as text', () => {
    expect(savedText(stepDto('s1', { description: null }), 'description')).toBe('');
    expect(savedText(stepDto('s1', { entryCondition: 3 }), 'entryCondition')).toBe('3');
    expect(shownText(stepDto('s1'), { name: 'typed' }, 'name')).toBe('typed');
    expect(shownText(stepDto('s1'), {}, 'name')).toBe('step-s1');
  });

  it('wants a name and a version (the only rule the browser checks)', () => {
    expect(missingRequired('step', stepDto('s1'), {})).toBe(false);
    expect(missingRequired('step', stepDto('s1'), { name: '  ' })).toBe(true);
    expect(missingRequired('cache', cacheDto('c1'), { version: '' })).toBe(true);
  });

  it('marks text that is not JSON', () => {
    expect(jsonProblem('{"a":1}')).toBeNull();
    expect(jsonProblem('[]')).toBeNull();
    expect(jsonProblem('{')).toBe('Not valid JSON');
    expect(jsonProblem('')).toBe('Not valid JSON');
  });

  it("puts a 400's messages under the fields the form edits, and the rest aside", () => {
    expect(splitErrors('cache', {
      Root: ["Root must not contain ':'."], Items: ['Items must be a JSON object.'], EntryStepIds: ['x'], '$.items': ['bad'],
    })).toEqual({ fields: { root: ["Root must not contain ':'."], items: ['Items must be a JSON object.'] }, other: ['x', 'bad'] });
  });

  it("prefills a new assignment from its step, and creates it from what the form shows", () => {
    const fresh = newAssignmentDto({ id: 's1', name: 'fetch' });
    expect(fresh).toMatchObject({ id: '', name: 'fetch-assignment', version: '1.0.0', description: null, stepId: 's1', payload: '{}' });
    expect(createAssignmentDto(fresh, { payload: '{"a":1}', description: '' })).toEqual({
      name: 'fetch-assignment', version: '1.0.0', description: null, stepId: 's1', payload: '{"a":1}',
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/store/inspectorTarget.test.ts src/store/entityForms.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: The targets**

Create `src/store/inspectorTarget.ts`:

```ts
import type { EntityKind } from '../api/entities';
import type { Id } from '../model/graph';
import type { Selection } from './selection';

export type SchemaSlot = 'input' | 'output' | 'config';

/**
 * What the Inspector shows (spec §7.1): an entity it reads and saves, or the form that adds a step's
 * assignment. The selection gives the first one; drill-downs (step → processor → schema, step →
 * assignment) add the rest, as a trail.
 */
export type InspectorTarget =
  | { kind: 'workflow'; id: Id }
  | { kind: 'step'; id: Id }
  | { kind: 'processor'; id: Id }
  | { kind: 'schema'; id: Id; slot: SchemaSlot }
  | { kind: 'assignment'; id: Id; stepId: Id }
  | { kind: 'newAssignment'; stepId: Id; stepName: string }
  | { kind: 'cache'; id: Id };

/** The selection as a target; existence is the server's answer (a GET that 404s). */
export function rootTarget(selection: Selection | null, workflowId: Id): InspectorTarget | null {
  if (selection === null) return null;
  switch (selection.kind) {
    case 'workflow': return { kind: 'workflow', id: workflowId };
    case 'step': return { kind: 'step', id: selection.stepId };
    case 'processor': return { kind: 'processor', id: selection.processorId };
    case 'cache': return { kind: 'cache', id: selection.cacheId };
  }
}

/** The entity shown: the trail's last drill-down, else the selection itself. */
export function currentTarget(root: InspectorTarget, trail: readonly InspectorTarget[]): InspectorTarget {
  return trail.at(-1) ?? root;
}

export function targetKey(target: InspectorTarget | null): string {
  if (target === null) return 'none';
  return target.kind === 'newAssignment' ? `newAssignment:${target.stepId}` : `${target.kind}:${target.id}`;
}

/** The entity kind a target reads and saves; the new-assignment form becomes an assignment. */
export function entityKindOf(target: InspectorTarget): EntityKind {
  return target.kind === 'newAssignment' ? 'assignment' : target.kind;
}

const SLOT_LABEL: Record<SchemaSlot, string> = { input: 'Input', output: 'Output', config: 'Config' };

/** The breadcrumb's word for a target (spec §7.1: "Step › Processor › Config schema"). */
export function crumbLabel(target: InspectorTarget): string {
  switch (target.kind) {
    case 'workflow': return 'Workflow';
    case 'step': return 'Step';
    case 'processor': return 'Processor';
    case 'schema': return `${SLOT_LABEL[target.slot]} schema`;
    case 'assignment': return 'Assignment';
    case 'newAssignment': return 'New assignment';
    case 'cache': return 'Cache';
  }
}

/** A well-formed target: a restored draft's trail is checked with it. */
export function isTarget(value: unknown): value is InspectorTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const id = (key: string) => typeof v[key] === 'string' && v[key] !== '';
  switch (v.kind) {
    case 'workflow': case 'step': case 'processor': case 'cache': return id('id');
    case 'schema': return id('id') && (v.slot === 'input' || v.slot === 'output' || v.slot === 'config');
    case 'assignment': return id('id') && id('stepId');
    case 'newAssignment': return id('stepId') && typeof v.stepName === 'string';
    default: return false;
  }
}
```

- [ ] **Step 4: The forms**

Create `src/store/entityForms.ts`:

```ts
import type { EntityKind, EntityReadDto, ReadDtoOf, UpdateDtoOf } from '../api/entities';
import type { AssignmentCreateDto, AssignmentReadDto } from '../api/types';
import type { Id } from '../model/graph';

export type FieldKind = 'text' | 'multiline' | 'json' | 'condition';

/** One writable field of the Inspector (spec §7.1's table). */
export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  /** Save is disabled while it is blank (Name and Version only, spec §7.1). */
  required?: boolean;
  /** Blank text is sent as null. */
  nullable?: boolean;
}

const NAME: FieldSpec = { key: 'name', label: 'Name', kind: 'text', required: true };
const VERSION: FieldSpec = { key: 'version', label: 'Version', kind: 'text', required: true };
const DESCRIPTION: FieldSpec = { key: 'description', label: 'Description', kind: 'multiline', nullable: true };

/** The writable fields, in the order the Inspector shows them; the first two are the head. */
export const FIELDS: Record<EntityKind, readonly FieldSpec[]> = {
  workflow: [NAME, VERSION, DESCRIPTION, { key: 'cronExpression', label: 'Cron', kind: 'text', nullable: true }],
  step: [NAME, VERSION, DESCRIPTION, { key: 'entryCondition', label: 'Entry condition', kind: 'condition' }],
  assignment: [NAME, VERSION, DESCRIPTION, { key: 'payload', label: 'Payload', kind: 'json' }],
  processor: [NAME, VERSION, DESCRIPTION, { key: 'sourceHash', label: 'Source hash', kind: 'text' }, { key: 'instanceId', label: 'Instance id', kind: 'text', nullable: true }],
  schema: [NAME, VERSION, DESCRIPTION, { key: 'definition', label: 'Definition', kind: 'json' }],
  cache: [NAME, VERSION, DESCRIPTION, { key: 'root', label: 'Root', kind: 'text' }, { key: 'items', label: 'Items', kind: 'json' }],
};

/** Every field of each update DTO, in the generated type's order: exactly what a PUT sends. */
export const UPDATE_KEYS: Record<EntityKind, readonly string[]> = {
  workflow: ['name', 'version', 'description', 'entryStepIds', 'assignmentIds', 'cacheIds', 'cronExpression'],
  step: ['name', 'version', 'description', 'processorId', 'nextStepIds', 'entryCondition'],
  assignment: ['name', 'version', 'description', 'stepId', 'payload'],
  processor: ['name', 'version', 'description', 'sourceHash', 'instanceId', 'inputSchemaId', 'outputSchemaId', 'configSchemaId'],
  schema: ['name', 'version', 'description', 'definition'],
  cache: ['name', 'version', 'description', 'root', 'items'],
};

const field = (dto: EntityReadDto, key: string): unknown => (dto as Record<string, unknown>)[key];

/** A saved value as form text: null and absent read as '', the entry condition as its number. */
export function savedText(dto: EntityReadDto, key: string): string {
  const value = field(dto, key);
  return value === null || value === undefined ? '' : String(value);
}

/** What the form shows: the typed text when there is some, else the saved value. */
export function shownText(dto: EntityReadDto, edits: Readonly<Record<string, string>>, key: string): string {
  return Object.hasOwn(edits, key) ? edits[key]! : savedText(dto, key);
}

function toDtoValue(spec: FieldSpec, text: string): unknown {
  if (spec.kind === 'condition') return Number(text);
  if (spec.nullable && text.trim() === '') return null;
  return text;
}

/**
 * The PUT body (spec §7.1, §9): every field of the update DTO exactly as `saved` has it (structural
 * lists and ids included; null stays null), then only the edited writable fields replaced.
 */
export function updateDto<K extends EntityKind>(kind: K, saved: ReadDtoOf[K], edits: Readonly<Record<string, string>>): UpdateDtoOf[K] {
  const body: Record<string, unknown> = {};
  for (const key of UPDATE_KEYS[kind]) body[key] = field(saved, key) ?? null;
  for (const spec of FIELDS[kind]) if (Object.hasOwn(edits, spec.key)) body[spec.key] = toDtoValue(spec, edits[spec.key]!);
  return body as UpdateDtoOf[K];
}

/** True while Name or Version would be sent blank: Save stays disabled. */
export function missingRequired(kind: EntityKind, dto: EntityReadDto, edits: Readonly<Record<string, string>>): boolean {
  return FIELDS[kind].some((spec) => spec.required === true && shownText(dto, edits, spec.key).trim() === '');
}

/** "Not valid JSON" while a JSON field does not parse; the server still judges it on save. */
export function jsonProblem(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch {
    return 'Not valid JSON';
  }
}

/**
 * A 400's messages (keys are C# property names: `CronExpression`) under the form's fields
 * (`cronExpression`); messages about anything the form does not edit go to `other`, for the banner.
 */
export function splitErrors(kind: EntityKind, errors: Readonly<Record<string, string[]>>): { fields: Record<string, string[]>; other: string[] } {
  const writable = new Set(FIELDS[kind].map((spec) => spec.key));
  const fields: Record<string, string[]> = {};
  const other: string[] = [];
  for (const [name, messages] of Object.entries(errors)) {
    const key = name.charAt(0).toLowerCase() + name.slice(1);
    if (writable.has(key)) fields[key] = [...(fields[key] ?? []), ...messages];
    else other.push(...messages);
  }
  return { fields, other };
}

/** The new-assignment form's starting values (spec §7.1); `id` stays '' until it is created. */
export function newAssignmentDto(step: { id: Id; name: string }): AssignmentReadDto {
  return { id: '', name: `${step.name}-assignment`, version: '1.0.0', description: null, stepId: step.id, payload: '{}' } as AssignmentReadDto;
}

/** The POST body for the new-assignment form: its starting values with what was typed. */
export function createAssignmentDto(saved: AssignmentReadDto, edits: Readonly<Record<string, string>>): AssignmentCreateDto {
  return updateDto('assignment', saved, edits);
}
```

- [ ] **Step 5: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src/store`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS.

```bash
git add src/WorkflowStudio/src/store/inspectorTarget.ts src/WorkflowStudio/src/store/inspectorTarget.test.ts src/WorkflowStudio/src/store/entityForms.ts src/WorkflowStudio/src/store/entityForms.test.ts
git commit -m "feat(studio): Inspector targets and forms, and the DTO round trip that sends structure back unchanged" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The Inspector's state per document, kept in the session

**Files:**
- Create: `src/store/inspector.ts`
- Modify: `src/store/studioState.ts`, `src/app/session.ts`
- Test: `src/store/studioState.test.ts`, `src/app/session.test.ts`

**Interfaces:**
- Consumes: Task 2's targets and forms; `EntityReadDto`; `StudioDocument`.
- Produces:
  - `InspectorDraft { trail: InspectorTarget[]; edits: Record<string, string> }`, `SaveFailure { fields: Record<string, string[]>; banner: string | null }`, `InspectorState` (draft + `saved: { key; dto } | null`, `readError: string | null`, `busy: boolean`, `failure: SaveFailure | null`), `EMPTY_INSPECTOR`, `hasEdits(draft)` (`store/inspector.ts`).
  - `OpenDocument.inspector: InspectorState`.
  - Actions: `drill`, `back`, `edit`, `discard`, `read`, `busy`, `saveFailed`, `saved`, `created`, `refreshed`, `retry` (shapes below).
  - `shownTargetOf(doc: OpenDocument): InspectorTarget | null` (`store/studioState.ts`).
  - `SessionDoc.draft?: InspectorDraft`.

- [ ] **Step 1: Write the failing store tests**

Append to `src/store/studioState.test.ts` (reuse its imports; add `stepDto` from `../api/fixtures`, `loadedDocument` from `../app/fixtures`, `EMPTY_INSPECTOR` from `./inspector`, and `reduce`, `INITIAL_STATE`, `shownTargetOf`, `inspectorKey` from `./studioState` if not already imported):

```ts
describe('the Inspector (slice 3b)', () => {
  const opened = () => {
    let s = reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    return s;
  };
  const insp = (s: ReturnType<typeof opened>) => s.docs[0]!.inspector;
  const step = stepDto('s1', { name: 'fetch' });

  it('opens a document with an empty Inspector, and a new selection starts it again', () => {
    let s = reduce(INITIAL_STATE, { type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
    expect(s.docs[0]!.inspector).toEqual(EMPTY_INSPECTOR);
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'name', text: 'x', saved: 'fetch' });
    s = reduce(s, { type: 'select', workflowId: 'wf1', selection: { kind: 'workflow' } });
    expect(insp(s)).toEqual(EMPTY_INSPECTOR);
  });

  it('drills down and back, leaving what the previous entity held', () => {
    let s = opened();
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: step } });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'schema', id: 'sc1', slot: 'config' } });
    expect(shownTargetOf(s.docs[0]!)).toEqual({ kind: 'schema', id: 'sc1', slot: 'config' });
    expect(insp(s).saved).toBeNull();
    s = reduce(s, { type: 'back', workflowId: 'wf1', depth: 0 });
    expect(insp(s).trail).toEqual([]);
    expect(shownTargetOf(s.docs[0]!)).toEqual({ kind: 'step', id: 's1' });
  });

  it('keeps an edit until it is typed back to the saved value', () => {
    let s = opened();
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'new', saved: '' });
    expect(insp(s).edits).toEqual({ description: 'new' });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: '', saved: '' });
    expect(insp(s).edits).toEqual({});
  });

  it('drops a read for an entity it no longer shows (review focus 2)', () => {
    let s = opened();
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: step } });
    expect(insp(s).saved).toBeNull();
  });

  it('a read drops edits that already match what was read; a failed read says why', () => {
    let s = opened();
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'name', text: 'fetch', saved: 'old' });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'typed', saved: '' });
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: true, dto: step } });
    expect(insp(s).edits).toEqual({ description: 'typed' });
    s = reduce(s, { type: 'read', workflowId: 'wf1', key: 'step:s1', result: { ok: false, message: 'This step no longer exists.' } });
    expect([insp(s).saved, insp(s).readError]).toEqual([null, 'This step no longer exists.']);
  });

  it('saved clears only what it sent: text typed during the save stays (review focus 1)', () => {
    let s = opened();
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'sent', saved: '' });
    s = reduce(s, { type: 'busy', workflowId: 'wf1', busy: true });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'name', text: 'typed meanwhile', saved: 'fetch' });
    s = reduce(s, { type: 'saved', workflowId: 'wf1', key: 'step:s1', sent: { description: 'sent' }, dto: { ...step, description: 'sent' } });
    expect(insp(s)).toMatchObject({ edits: { name: 'typed meanwhile' }, busy: false, failure: null });
    expect(insp(s).saved?.dto).toMatchObject({ description: 'sent' });
  });

  it('a failed save keeps the edits and says why; discard drops both', () => {
    let s = opened();
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'version', text: 'abc', saved: '1.0.0' });
    s = reduce(s, { type: 'saveFailed', workflowId: 'wf1', failure: { fields: { version: ['Version must be x.y.z.'] }, banner: null } });
    expect(insp(s)).toMatchObject({ edits: { version: 'abc' }, busy: false, failure: { fields: { version: ['Version must be x.y.z.'] } } });
    s = reduce(s, { type: 'discard', workflowId: 'wf1' });
    expect(insp(s)).toMatchObject({ edits: {}, failure: null });
  });

  it('a created assignment replaces the new-assignment form in the trail', () => {
    let s = opened();
    s = reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'fetch' } });
    s = reduce(s, { type: 'created', workflowId: 'wf1', target: { kind: 'assignment', id: 'a9', stepId: 's1' }, dto: { id: 'a9', stepId: 's1' } as never });
    expect(insp(s).trail).toEqual([{ kind: 'assignment', id: 'a9', stepId: 's1' }]);
    expect(insp(s).saved?.key).toBe('assignment:a9');
  });

  it('a refreshed document takes the new graph and name, keeping its Inspector; retry reloads a failed one', async () => {
    let s = opened();
    s = reduce(s, { type: 'loaded', workflowId: 'wf1', doc: await loadedDocument() });
    s = reduce(s, { type: 'edit', workflowId: 'wf1', key: 'description', text: 'kept', saved: '' });
    const renamed = await loadedDocument(graphDto({ workflow: workflowDto({ name: 'renamed', version: '2.0.0' }) }));
    s = reduce(s, { type: 'refreshed', workflowId: 'wf1', doc: renamed });
    expect([s.docs[0]!.name, s.docs[0]!.version, insp(s).edits]).toEqual(['renamed', '2.0.0', { description: 'kept' }]);

    s = reduce(s, { type: 'failed', workflowId: 'wf1', message: 'down' });
    s = reduce(s, { type: 'refreshed', workflowId: 'wf1', doc: renamed });
    expect(s.docs[0]!.status.kind).toBe('failed');            // only a ready document is refreshed
    s = reduce(s, { type: 'retry', workflowId: 'wf1' });
    expect(s.docs[0]!.status.kind).toBe('loading');
    expect(insp(s).edits).toEqual({ description: 'kept' });   // a failed document keeps its draft (spec §6.1)
  });

  it('the Inspector key changes with the drill-down, so a hidden Inspector glows', () => {
    const s = opened();
    const before = inspectorKey(s);
    expect(inspectorKey(reduce(s, { type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } }))).not.toBe(before);
  });
});
```

(Import `graphDto`, `workflowDto` from `../api/fixtures` too.)

- [ ] **Step 2: Write the failing session tests**

Append to `src/app/session.test.ts` (import `EMPTY_INSPECTOR` from `../store/inspector`):

```ts
describe('the draft (slice 3b, spec §6.1)', () => {
  const draft = { trail: [{ kind: 'processor', id: 'p1' }], edits: { description: 'typed' } };

  it('reads a valid draft and drops a broken one, never the session', () => {
    const storage = memoryStorage({ [SESSION_KEY]: JSON.stringify({
      ...good,
      docs: [{ ...good.docs[0], draft }, { ...good.docs[1], draft: { trail: [{ kind: 'wire' }], edits: { a: 1 } } }],
    }) });
    const read = readSession(storage)!;
    expect(read.docs[0]!.draft).toEqual(draft);
    expect(read.docs[1]!.draft).toBeUndefined();
    expect(read.version).toBe(1);
  });

  it('writes a document's draft only when it has one, and restores it into the Inspector', () => {
    const state: StudioState = {
      ...INITIAL_STATE,
      docs: [
        { workflowId: 'a', name: 'orders', version: '1.0.0', status: { kind: 'loading' }, selection: { kind: 'step', stepId: 's1' }, inspector: { ...EMPTY_INSPECTOR, ...draft, trail: draft.trail as never } },
        { workflowId: 'b', name: 'billing', version: '1.0.0', status: { kind: 'loading' }, selection: null, inspector: EMPTY_INSPECTOR },
      ],
      activeId: 'a',
    };
    const session = sessionOf(state, new Map(), null);
    expect(session.docs[0]!.draft).toEqual(draft);
    expect('draft' in session.docs[1]!).toBe(false);
    expect(restoredState(session).docs[0]!.inspector).toEqual({ ...EMPTY_INSPECTOR, ...draft });
    expect(restoredState(session).docs[1]!.inspector).toEqual(EMPTY_INSPECTOR);
  });

  it('a session write counts as kept when the next refresh will read it', () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(writeTabSession(refusing, memoryStorage(), good)).toBe(true);             // the tab holds no entry: the mirror is read
    const stale = memoryStorage({ [SESSION_KEY]: JSON.stringify(good) });
    const staleRefusing = { getItem: (k: string) => stale.getItem(k), setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(writeTabSession(staleRefusing, memoryStorage(), good)).toBe(false);       // a refresh would read the tab's old entry
  });
});
```

Existing tests in this file that build `OpenDocument` objects or compare `restoredState(...)` documents now need `inspector: EMPTY_INSPECTOR` (or compare with `toMatchObject`). Update them so they still assert what they did.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/store/studioState.test.ts src/app/session.test.ts`
Expected: FAIL (no `inspector`, no actions, no `draft`).

- [ ] **Step 4: The Inspector's state**

Create `src/store/inspector.ts`:

```ts
import type { EntityReadDto } from '../api/entities';
import type { InspectorTarget } from './inspectorTarget';

/** What a refresh keeps of a document's Inspector (spec §6.1): where it was drilled to, and what was typed. */
export interface InspectorDraft {
  /** The drill-downs below the selection, in order; empty: the selection itself is shown. */
  trail: InspectorTarget[];
  /** Typed text by field key, for the entity shown. A field typed back to its saved value is dropped. */
  edits: Record<string, string>;
}

/** Why the last save, create or unlink did not happen: messages under their fields, a banner for the rest. */
export interface SaveFailure {
  fields: Record<string, string[]>;
  banner: string | null;
}

export interface InspectorState extends InspectorDraft {
  /** The shown entity's last GET and the target key it belongs to; null until it arrives. Not kept in the session. */
  saved: { key: string; dto: EntityReadDto } | null;
  /** Why the shown entity could not be read. */
  readError: string | null;
  /** A save, create or unlink is in flight. */
  busy: boolean;
  failure: SaveFailure | null;
}

export const EMPTY_INSPECTOR: InspectorState = { trail: [], edits: {}, saved: null, readError: null, busy: false, failure: null };

export function hasEdits(draft: InspectorDraft): boolean {
  return Object.keys(draft.edits).length > 0;
}
```

- [ ] **Step 5: The store**

In `src/store/studioState.ts`:

- Import `EntityReadDto` from `../api/entities`, `savedText` from `./entityForms`, `EMPTY_INSPECTOR, type InspectorState, type SaveFailure` from `./inspector`, and `currentTarget, rootTarget, targetKey, type InspectorTarget` from `./inspectorTarget`.
- Add to `OpenDocument`, after `selection`:

```ts
  /** This document's Inspector (slice 3b): its trail and edits are the draft the session keeps. */
  inspector: InspectorState;
```

- Change the comment above `StudioState` to: "The studio's shared state. The page keeps it in its session (app/session.ts), so a refresh brings it back (spec §6.1); a document's Inspector edits are its draft."
- Add to `StudioAction`:

```ts
  | { type: 'drill'; workflowId: Id; target: InspectorTarget }
  /** Keeps the first `depth` drill-downs (0: back to the selection). */
  | { type: 'back'; workflowId: Id; depth: number }
  | { type: 'edit'; workflowId: Id; key: string; text: string; saved: string }
  | { type: 'discard'; workflowId: Id }
  | { type: 'read'; workflowId: Id; key: string; result: { ok: true; dto: EntityReadDto } | { ok: false; message: string } }
  | { type: 'busy'; workflowId: Id; busy: boolean }
  | { type: 'saveFailed'; workflowId: Id; failure: SaveFailure }
  /** `sent`: the edits the PUT carried; only those are cleared. */
  | { type: 'saved'; workflowId: Id; key: string; sent: Record<string, string>; dto: EntityReadDto }
  | { type: 'created'; workflowId: Id; target: InspectorTarget; dto: EntityReadDto }
  /** A ready document re-read after a write: the new graph, keeping selection, view and Inspector. */
  | { type: 'refreshed'; workflowId: Id; doc: StudioDocument }
  /** A failed document goes back to loading. */
  | { type: 'retry'; workflowId: Id }
```

- Add helpers after `update`:

```ts
/** The target a document's Inspector shows, or null when nothing is selected. */
export function shownTargetOf(doc: OpenDocument): InspectorTarget | null {
  const root = rootTarget(doc.selection, doc.workflowId);
  return root === null ? null : currentTarget(root, doc.inspector.trail);
}

const inspect = (state: StudioState, id: Id, change: (i: InspectorState, d: OpenDocument) => InspectorState): StudioState =>
  update(state, id, (d) => {
    const next = change(d.inspector, d);
    return next === d.inspector ? d : { ...d, inspector: next };
  });

const without = (edits: Record<string, string>, drop: (key: string, text: string) => boolean): Record<string, string> =>
  Object.fromEntries(Object.entries(edits).filter(([key, text]) => !drop(key, text)));
```

- In `reduce`:
  - `'open'`: the new document gets `inspector: EMPTY_INSPECTOR`.
  - `'loaded'`: also take the graph's names: `({ ...d, name: action.doc.graph.workflow.name, version: action.doc.graph.workflow.version, status: { kind: 'ready', doc: action.doc } })`.
  - `'select'`: a different selection resets the Inspector: `: { ...d, selection: action.selection, inspector: EMPTY_INSPECTOR }`. (The page asks Save / Discard / Cancel before it dispatches a select over unsaved edits; the reducer does not.)
  - Add:

```ts
    case 'drill':
      return inspect(state, action.workflowId, (i) => ({ ...EMPTY_INSPECTOR, trail: [...i.trail, action.target] }));
    case 'back':
      return inspect(state, action.workflowId, (i) =>
        action.depth >= i.trail.length ? i : { ...EMPTY_INSPECTOR, trail: i.trail.slice(0, Math.max(0, action.depth)) });
    case 'edit':
      return inspect(state, action.workflowId, (i) => {
        const edits = without(i.edits, (key) => key === action.key);
        if (action.text !== action.saved) edits[action.key] = action.text;
        return { ...i, edits };
      });
    case 'discard':
      return inspect(state, action.workflowId, (i) => ({ ...i, edits: {}, failure: null }));
    case 'read':
      return inspect(state, action.workflowId, (i, d) => {
        if (targetKey(shownTargetOf(d)) !== action.key) return i;
        if (!action.result.ok) return { ...i, saved: null, readError: action.result.message };
        const dto = action.result.dto;
        return { ...i, saved: { key: action.key, dto }, readError: null, edits: without(i.edits, (key, text) => text === savedText(dto, key)) };
      });
    case 'busy':
      return inspect(state, action.workflowId, (i) => (i.busy === action.busy ? i : { ...i, busy: action.busy }));
    case 'saveFailed':
      return inspect(state, action.workflowId, (i) => ({ ...i, busy: false, failure: action.failure }));
    case 'saved':
      return inspect(state, action.workflowId, (i, d) => {
        if (targetKey(shownTargetOf(d)) !== action.key) return { ...i, busy: false };
        const edits = without(i.edits, (key, text) => action.sent[key] === text);
        return { ...i, edits, busy: false, failure: null, readError: null, saved: { key: action.key, dto: action.dto } };
      });
    case 'created':
      return inspect(state, action.workflowId, (i) => ({
        ...EMPTY_INSPECTOR, trail: [...i.trail.slice(0, -1), action.target], saved: { key: targetKey(action.target), dto: action.dto },
      }));
    case 'refreshed':
      return update(state, action.workflowId, (d) => (d.status.kind !== 'ready' ? d : {
        ...d, name: action.doc.graph.workflow.name, version: action.doc.graph.workflow.version, status: { kind: 'ready', doc: action.doc },
      }));
    case 'retry':
      return update(state, action.workflowId, (d) => (d.status.kind !== 'failed' ? d : { ...d, status: { kind: 'loading' } }));
```

- `inspectorKey` adds the trail: ``return active === null ? 'none' : `${active.workflowId}|${active.status.kind}|${selectionKey(active.selection)}|${active.inspector.trail.map(targetKey).join('>')}`;``

Every test or fixture that builds an `OpenDocument` literal gets `inspector: EMPTY_INSPECTOR` (run `npm run typecheck` to find them).

- [ ] **Step 6: The session keeps the draft**

In `src/app/session.ts`:

- Import `EMPTY_INSPECTOR, hasEdits, type InspectorDraft` from `../store/inspector` and `isTarget` from `../store/inspectorTarget`.
- Add to `SessionDoc`:

```ts
  /** The document's unsaved Inspector work (slice 3b): absent when there is none. Optional, so the version stays 1. */
  draft?: InspectorDraft;
```

- In `readSession`, the pushed document gains the draft when it validates: `...(isDraft(d.draft) ? { draft: { trail: d.draft.trail, edits: d.draft.edits } } : {}),`
- Add the validator after `isView`:

```ts
function isDraft(value: unknown): value is InspectorDraft {
  return isRecord(value) && Array.isArray(value.trail) && value.trail.every(isTarget)
    && isRecord(value.edits) && Object.values(value.edits).every((text) => typeof text === 'string');
}
```

- In `sessionOf`, each document becomes:

```ts
    docs: state.docs.map((d) => ({
      workflowId: d.workflowId, name: d.name, version: d.version, selection: d.selection, view: views.get(d.workflowId) ?? null,
      ...(d.inspector.trail.length > 0 || hasEdits(d.inspector) ? { draft: { trail: d.inspector.trail, edits: d.inspector.edits } } : {}),
    })),
```

- In `restoredState`, each document gets `inspector: { ...EMPTY_INSPECTOR, ...(d.draft ?? {}) }`.
- Replace `writeTabSession`'s body, and its comment's last sentence, so it is true exactly when the next refresh will find this session:

```ts
export function writeTabSession(tab: Storage | null, mirror: Storage | null, session: Session): boolean {
  const mirrored = writeSession(mirror, session);
  if (tab === null) return mirrored;
  // a tab that refused the write is read again only if it already holds an (older) entry
  return writeSession(tab, session) || (mirrored && !holdsSession(tab));
}
```

- [ ] **Step 7: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src/store src/app`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS, no warnings.

```bash
git add src/WorkflowStudio/src/store/inspector.ts src/WorkflowStudio/src/store/studioState.ts src/WorkflowStudio/src/store/studioState.test.ts src/WorkflowStudio/src/app/session.ts src/WorkflowStudio/src/app/session.test.ts
git commit -m "feat(studio): each document's Inspector state, its draft kept in the session" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Add any other file you gave `inspector: EMPTY_INSPECTOR`.)

---

### Task 4: The Inspector service: read, save, create, unlink

**Files:**
- Create: `src/app/inspectorService.ts`, `src/app/studioActions.ts`
- Test: `src/app/inspectorService.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `interface InspectorService { read(workflowId, again?): void; save(workflowId): Promise<boolean>; create(workflowId): Promise<boolean>; unlink(workflowId): Promise<boolean> }`, `createInspectorService(api, store, afterWrite: () => void)`, `failureOf(target, error): SaveFailure` (`app/inspectorService.ts`).
  - `interface StudioActions { service; guard(workflowId, proceed, doc?); confirmUnlink(workflowId, doc?) }`, `StudioActionsProvider`, `useStudioActions()`, `useGuard()` (`app/studioActions.ts`).

- [ ] **Step 1: Write the failing tests**

Create `src/app/inspectorService.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ApiResult, StudioApi } from '../api/client';
import { assignmentDto, graphDto, stepDto, workflowDto } from '../api/fixtures';
import { createStudioStore } from '../store/studioStore';
import { loadedDocument } from './fixtures';
import { createInspectorService } from './inspectorService';

const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value });
const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup(api: Partial<StudioApi>) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument() });
  store.dispatch({ type: 'select', workflowId: 'wf1', selection: { kind: 'step', stepId: 's1' } });
  const afterWrite = vi.fn();
  const service = createInspectorService(api as StudioApi, store, afterWrite);
  const inspector = () => store.getState().docs[0]!.inspector;
  return { store, service, afterWrite, inspector };
}

describe('InspectorService', () => {
  it('reads the shown entity once, and not again while it is read', async () => {
    const getEntity = vi.fn().mockResolvedValue(ok(stepDto('s1', { name: 'fetch' })));
    const { service, inspector } = await setup({ getEntity });
    service.read('wf1');
    service.read('wf1');
    await flush();
    service.read('wf1');
    expect(getEntity).toHaveBeenCalledTimes(1);
    expect(inspector().saved?.dto).toMatchObject({ name: 'fetch' });
  });

  it('drops an answer for an entity the user has left (review focus 2)', async () => {
    let answer!: (r: ApiResult<unknown>) => void;
    const getEntity = vi.fn().mockReturnValueOnce(new Promise((r) => { answer = r; })).mockResolvedValue(ok({ id: 'p1' }));
    const { store, service, inspector } = await setup({ getEntity });
    service.read('wf1');
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'processor', id: 'p1' } });
    answer(ok(stepDto('s1')));
    await flush();
    expect(inspector().saved).toBeNull();
  });

  it('says when the shown entity no longer exists', async () => {
    const { service, inspector } = await setup({ getEntity: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'notFound', status: 404 } }) });
    service.read('wf1');
    await flush();
    expect(inspector().readError).toBe('This step no longer exists.');
  });

  it('saves from a fresh GET, so structure goes back as the server holds it now (review focus 3)', async () => {
    const getEntity = vi.fn()
      .mockResolvedValueOnce(ok(stepDto('s1', { nextStepIds: ['s2'] })))            // what the form was filled from
      .mockResolvedValueOnce(ok(stepDto('s1', { nextStepIds: ['s2', 's3'] })));     // what the server holds at save time
    const putEntity = vi.fn().mockResolvedValue(ok(stepDto('s1', { description: 'now', nextStepIds: ['s2', 's3'] })));
    const { store, service, afterWrite, inspector } = await setup({ getEntity, putEntity });
    service.read('wf1');
    await flush();
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'now', saved: '' });

    expect(await service.save('wf1')).toBe(true);
    expect(putEntity).toHaveBeenCalledWith('step', 's1', {
      name: 'step-s1', version: '1.0.0', description: 'now', processorId: 'p1', nextStepIds: ['s2', 's3'], entryCondition: 1,
    });
    expect(inspector()).toMatchObject({ edits: {}, busy: false });
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });

  it('nothing to save is a success that sends nothing', async () => {
    const putEntity = vi.fn();
    const { service } = await setup({ putEntity, getEntity: vi.fn() });
    expect(await service.save('wf1')).toBe(true);
    expect(putEntity).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'badRequest', status: 400, detail: 'Validation failed', errors: { Version: ['Version must be x.y.z.'], EntryStepIds: ['Needs an entry step.'] } },
      { fields: { version: ['Version must be x.y.z.'] }, banner: 'Not saved: Needs an entry step.' }],
    [{ kind: 'badRequest', status: 400, detail: 'Validation failed', errors: {} }, { fields: {}, banner: 'Not saved: Validation failed' }],
    [{ kind: 'conflict', status: 409, detail: 'Unique constraint violation: root already exists.', entity: null },
      { fields: {}, banner: 'Not saved: Unique constraint violation: root already exists.' }],
    [{ kind: 'notFound', status: 404 }, { fields: {}, banner: 'Not saved: this step no longer exists.' }],
    [{ kind: 'network', message: 'Failed to fetch' }, { fields: {}, banner: 'Not saved: BaseApi unreachable' }],
  ])('a failed save keeps the edits and says why (%o)', async (error, failure) => {
    const getEntity = vi.fn().mockResolvedValue(ok(stepDto('s1')));
    const { store, service, afterWrite, inspector } = await setup({ getEntity, putEntity: vi.fn().mockResolvedValue({ ok: false, error }) });
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'version', text: 'abc', saved: '1.0.0' });
    expect(await service.save('wf1')).toBe(false);
    expect(inspector()).toMatchObject({ edits: { version: 'abc' }, busy: false, failure });
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it('creates an assignment, then links it to the workflow it was read from', async () => {
    const created = assignmentDto('a9', { name: 'step-s1-assignment', stepId: 's1' });
    const createAssignment = vi.fn().mockResolvedValue(ok(created));
    const getEntity = vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a1'], entryStepIds: ['s1'] })));
    const putEntity = vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a1', 'a9'] })));
    const { store, service, afterWrite, inspector } = await setup({ createAssignment, getEntity, putEntity });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'step-s1' } });
    service.read('wf1');
    store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'payload', text: '{"k":1}', saved: '{}' });

    expect(await service.create('wf1')).toBe(true);
    expect(createAssignment).toHaveBeenCalledWith({ name: 'step-s1-assignment', version: '1.0.0', description: null, stepId: 's1', payload: '{"k":1}' });
    expect(putEntity).toHaveBeenCalledWith('workflow', 'wf1', expect.objectContaining({ assignmentIds: ['a1', 'a9'], entryStepIds: ['s1'] }));
    expect(inspector().trail).toEqual([{ kind: 'assignment', id: 'a9', stepId: 's1' }]);
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });

  it('reports an assignment that was created but not linked, and shows it', async () => {
    const { store, service, inspector } = await setup({
      createAssignment: vi.fn().mockResolvedValue(ok(assignmentDto('a9'))),
      getEntity: vi.fn().mockResolvedValue(ok(workflowDto())),
      putEntity: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } }),
    });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'newAssignment', stepId: 's1', stepName: 'step-s1' } });
    service.read('wf1');
    expect(await service.create('wf1')).toBe(false);
    expect(inspector().trail.at(-1)).toEqual({ kind: 'assignment', id: 'a9', stepId: 's1' });
    expect(inspector().failure?.banner).toBe('Created but not linked to this workflow: Network error: down');
  });

  it('unlinks the shown assignment from this workflow only, and goes back to its step', async () => {
    const putEntity = vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a2'] })));
    const { store, service, afterWrite, inspector } = await setup({
      getEntity: vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a1', 'a2'] }))), putEntity,
    });
    store.dispatch({ type: 'drill', workflowId: 'wf1', target: { kind: 'assignment', id: 'a1', stepId: 's1' } });
    expect(await service.unlink('wf1')).toBe(true);
    expect(putEntity).toHaveBeenCalledWith('workflow', 'wf1', expect.objectContaining({ assignmentIds: ['a2'] }));
    expect(inspector().trail).toEqual([]);
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });
});
```

(`graphDto` is imported for later additions; drop it if unused.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/app/inspectorService.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: The service**

Create `src/app/inspectorService.ts`:

```ts
import type { ApiError, StudioApi } from '../api/client';
import { describeError } from '../api/describeError';
import type { AssignmentReadDto } from '../api/types';
import type { Id } from '../model/graph';
import { createAssignmentDto, newAssignmentDto, splitErrors, updateDto } from '../store/entityForms';
import type { SaveFailure } from '../store/inspector';
import { crumbLabel, entityKindOf, targetKey, type InspectorTarget } from '../store/inspectorTarget';
import { shownTargetOf } from '../store/studioState';
import type { StudioStore } from '../store/studioStore';

/** The Inspector's I/O (spec §7.1). Every answer goes into the store; nothing here throws. */
export interface InspectorService {
  /** GETs the entity a document's Inspector shows, unless it is read or being read; `again` re-reads it in place. */
  read(workflowId: Id, again?: boolean): void;
  /** Saves the shown entity's edits: a fresh GET, then a PUT of that DTO with only the edits. True when nothing is left unsaved. */
  save(workflowId: Id): Promise<boolean>;
  /** Creates the assignment the new-assignment form describes, then links it to the workflow. */
  create(workflowId: Id): Promise<boolean>;
  /** Unlinks the shown assignment from this workflow; the assignment itself is kept. */
  unlink(workflowId: Id): Promise<boolean>;
}

/** What a failed write shows (spec §7.1, §8): a 400 under its fields, everything else in the banner. */
export function failureOf(target: InspectorTarget, error: ApiError): SaveFailure {
  switch (error.kind) {
    case 'badRequest': {
      const { fields, other } = splitErrors(entityKindOf(target), error.errors);
      if (other.length > 0) return { fields, banner: `Not saved: ${other.join(' ')}` };
      return { fields, banner: Object.keys(fields).length === 0 ? `Not saved: ${error.detail}` : null };
    }
    case 'notFound': return { fields: {}, banner: `Not saved: this ${crumbLabel(target).toLowerCase()} no longer exists.` };
    case 'network': return { fields: {}, banner: 'Not saved: BaseApi unreachable' };
    default: return { fields: {}, banner: `Not saved: ${error.detail}` };
  }
}

/** `afterWrite` runs after every successful write: the page re-reads every open document (spec §7.1). */
export function createInspectorService(api: StudioApi, store: StudioStore, afterWrite: () => void): InspectorService {
  /** workflowId → the target key whose GET is in flight. */
  const reading = new Map<Id, string>();
  const docOf = (id: Id) => store.getState().docs.find((d) => d.workflowId === id) ?? null;
  const shown = (id: Id) => {
    const doc = docOf(id);
    return doc === null ? null : shownTargetOf(doc);
  };
  const fail = (workflowId: Id, failure: SaveFailure): false => {
    store.dispatch({ type: 'saveFailed', workflowId, failure });
    return false;
  };

  function read(workflowId: Id, again = false): void {
    const doc = docOf(workflowId);
    const target = shown(workflowId);
    if (doc === null || target === null) return;
    const key = targetKey(target);
    if (!again && (doc.inspector.saved?.key === key || reading.get(workflowId) === key)) return;
    if (target.kind === 'newAssignment') {
      store.dispatch({ type: 'read', workflowId, key, result: { ok: true, dto: newAssignmentDto({ id: target.stepId, name: target.stepName }) } });
      return;
    }
    reading.set(workflowId, key);
    void api.getEntity(target.kind, target.id).then((r) => {
      if (reading.get(workflowId) === key) reading.delete(workflowId);
      store.dispatch({
        type: 'read', workflowId, key,
        result: r.ok ? { ok: true, dto: r.value }
          : { ok: false, message: r.error.kind === 'notFound' ? `This ${crumbLabel(target).toLowerCase()} no longer exists.` : `Could not read it. ${describeError(r.error)}` },
      });
    });
  }

  async function save(workflowId: Id): Promise<boolean> {
    const doc = docOf(workflowId);
    const target = shown(workflowId);
    if (doc === null || target === null || Object.keys(doc.inspector.edits).length === 0) return true;
    if (target.kind === 'newAssignment') return create(workflowId);
    const sent = doc.inspector.edits;
    store.dispatch({ type: 'busy', workflowId, busy: true });
    // built from a GET made now: structural fields go back exactly as the server holds them (review focus 3)
    const fresh = await api.getEntity(target.kind, target.id);
    if (!fresh.ok) return fail(workflowId, failureOf(target, fresh.error));
    const put = await api.putEntity(target.kind, target.id, updateDto(target.kind, fresh.value, sent));
    if (!put.ok) return fail(workflowId, failureOf(target, put.error));
    store.dispatch({ type: 'saved', workflowId, key: targetKey(target), sent, dto: put.value });
    afterWrite();
    return true;
  }

  /** Re-reads the workflow and PUTs it back with its assignment ids changed; null when done, else why not. */
  async function relink(workflowId: Id, change: (ids: string[]) => string[]): Promise<string | null> {
    const workflow = await api.getEntity('workflow', workflowId);
    if (!workflow.ok) return describeError(workflow.error);
    const body = { ...updateDto('workflow', workflow.value, {}), assignmentIds: change(workflow.value.assignmentIds ?? []) };
    const put = await api.putEntity('workflow', workflowId, body);
    return put.ok ? null : describeError(put.error);
  }

  async function create(workflowId: Id): Promise<boolean> {
    const doc = docOf(workflowId);
    const target = shown(workflowId);
    if (doc === null || target?.kind !== 'newAssignment' || doc.inspector.saved === null) return false;
    store.dispatch({ type: 'busy', workflowId, busy: true });
    const made = await api.createAssignment(createAssignmentDto(doc.inspector.saved.dto as AssignmentReadDto, doc.inspector.edits));
    if (!made.ok) return fail(workflowId, failureOf(target, made.error));
    const id = made.value.id ?? '';
    store.dispatch({ type: 'created', workflowId, target: { kind: 'assignment', id, stepId: target.stepId }, dto: made.value });
    const why = await relink(workflowId, (ids) => [...ids, id]);
    afterWrite();
    return why === null ? true : fail(workflowId, { fields: {}, banner: `Created but not linked to this workflow: ${why}` });
  }

  async function unlink(workflowId: Id): Promise<boolean> {
    const doc = docOf(workflowId);
    const target = shown(workflowId);
    if (doc === null || target?.kind !== 'assignment') return false;
    store.dispatch({ type: 'busy', workflowId, busy: true });
    const why = await relink(workflowId, (ids) => ids.filter((x) => x !== target.id));
    if (why !== null) return fail(workflowId, { fields: {}, banner: `Not unlinked: ${why}` });
    store.dispatch({ type: 'back', workflowId, depth: doc.inspector.trail.length - 1 });
    afterWrite();
    return true;
  }

  return { read, save, create, unlink };
}
```

- [ ] **Step 4: The actions context**

Create `src/app/studioActions.ts`:

```ts
import { createContext, useContext } from 'react';
import type { Id } from '../model/graph';
import type { InspectorService } from './inspectorService';

/** What the panes may ask of the page (slice 3b). Dock panels are React portals, so they see it too. */
export interface StudioActions {
  service: InspectorService;
  /**
   * Runs `proceed` now, or, when the document has unsaved Inspector edits, after the user chose
   * Save (and it worked) or Discard in the dialog (spec §7.1). `doc`: the window the action came from.
   */
  guard(workflowId: Id, proceed: () => void, doc?: Document): void;
  /** Asks before unlinking the shown assignment from this workflow, then unlinks it. */
  confirmUnlink(workflowId: Id, doc?: Document): void;
}

const Context = createContext<StudioActions | null>(null);

export const StudioActionsProvider = Context.Provider;

export function useStudioActions(): StudioActions {
  const actions = useContext(Context);
  if (!actions) throw new Error('useStudioActions needs a StudioActionsProvider above it.');
  return actions;
}

const UNGUARDED: StudioActions['guard'] = (_workflowId, proceed) => proceed();

/** The page's guard, or none (a pane rendered on its own, in a test, has nothing to guard). */
export function useGuard(): StudioActions['guard'] {
  return useContext(Context)?.guard ?? UNGUARDED;
}
```

- [ ] **Step 5: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src/app`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS.

```bash
git add src/WorkflowStudio/src/app/inspectorService.ts src/WorkflowStudio/src/app/inspectorService.test.ts src/WorkflowStudio/src/app/studioActions.ts
git commit -m "feat(studio): the Inspector service reads, saves from a fresh GET, creates and links an assignment, and unlinks one" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The editing Inspector: forms, drill-downs, Save and Revert

**Files:**
- Create: `src/panels/FieldEditor.tsx`, `src/test/inspector.tsx`
- Modify: `src/panels/Inspector.tsx`, `src/panels/inspectorView.ts`, `src/panels/panels.css`
- Test: `src/panels/panes.test.tsx` (the Inspector tests), `src/panels/inspectorView.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 (`useStudioActions`, the service, `shownTargetOf`, `FIELDS`, `savedText`, `shownText`, `missingRequired`, `jsonProblem`, `hasEdits`).
- Produces: the Inspector for workflow, step, processor, schema and cache. Task 6 adds the assignment views to the same component. `renderInspector(api, { selection, edits? })` test harness in `src/test/inspector.tsx`.

- [ ] **Step 1: The test harness**

Create `src/test/inspector.tsx`:

```tsx
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { StudioApi } from '../api/client';
import { graphDto, processorDto, stepDto } from '../api/fixtures';
import type { WorkflowGraphDto } from '../api/types';
import { loadedDocument } from '../app/fixtures';
import { createInspectorService } from '../app/inspectorService';
import { StudioActionsProvider, type StudioActions } from '../app/studioActions';
import { Inspector } from '../panels/Inspector';
import type { Selection } from '../store/selection';
import { createStudioStore, StudioStoreProvider } from '../store/studioStore';

const notFound = { ok: false, error: { kind: 'notFound', status: 404 } } as const;

export const inspectorGraph = graphDto({
  steps: [stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1' }), stepDto('s2', { name: 'store', processorId: 'p1' })],
  processors: [processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' })],
} as never);

/** Tests only: the Inspector over a loaded document, a real service on `api`, and a guard that records. */
export async function renderInspector(api: Partial<StudioApi>, { selection, graph = inspectorGraph }: { selection: Selection; graph?: WorkflowGraphDto }) {
  const store = createStudioStore();
  store.dispatch({ type: 'open', workflowId: 'wf1', name: 'orders', version: '1.0.0' });
  store.dispatch({ type: 'loaded', workflowId: 'wf1', doc: await loadedDocument(graph) });
  store.dispatch({ type: 'select', workflowId: 'wf1', selection });
  const full = {
    getEntity: vi.fn().mockResolvedValue(notFound), putEntity: vi.fn().mockResolvedValue(notFound),
    createAssignment: vi.fn().mockResolvedValue(notFound), ...api,
  } as unknown as StudioApi;
  const afterWrite = vi.fn();
  const service = createInspectorService(full, store, afterWrite);
  const guard = vi.fn<StudioActions['guard']>((_id, proceed) => proceed());
  const confirmUnlink = vi.fn<StudioActions['confirmUnlink']>();
  const view = render(
    <StudioStoreProvider value={store}>
      <StudioActionsProvider value={{ service, guard, confirmUnlink }}><Inspector /></StudioActionsProvider>
    </StudioStoreProvider>,
  );
  return { ...view, store, api: full, service, guard, confirmUnlink, afterWrite };
}
```

- [ ] **Step 2: Write the failing tests**

In `src/panels/panes.test.tsx`:
- The existing `describe('Inspector', …)` tests render `<Inspector />` with no actions provider. Rewrite them with `renderInspector` (the store setup they use moves into the harness). Keep what they assert: the empty states ("Open a workflow to inspect it.", "Nothing selected…"), the kind pill and unique name, the one show-all switch across entities (it now reads from each entity's GET: give `getEntity` a step and a workflow DTO), and that every **read-only** value (`.ro`, `.slot .v`) carries `data-tipcut` equal to its text.
- Add:

```tsx
describe('Inspector editing (slice 3b)', () => {
  const ok = <T,>(value: T) => ({ ok: true, value }) as const;
  const step = stepDto('s1', { name: 'fetch', nextStepIds: ['s2'], processorId: 'p1', description: null });

  it('reads the selected step and shows its writable fields filled in', async () => {
    const { api } = await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)) }, { selection: { kind: 'step', stepId: 's1' } });
    expect(await screen.findByLabelText('Name')).toHaveValue('fetch');
    expect(screen.getByLabelText('Version')).toHaveValue('1.0.0');
    expect(screen.getByLabelText('Entry condition')).toHaveValue('1');
    expect(api.getEntity).toHaveBeenCalledWith('step', 's1');
  });

  it('marks an edit unsaved, saves it, and takes what the server read back', async () => {
    const putEntity = vi.fn().mockResolvedValue(ok({ ...step, description: 'now' }));
    const { afterWrite } = await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)), putEntity }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'now' } });
    expect(screen.getByText('● unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putEntity).toHaveBeenCalledWith('step', 's1', expect.objectContaining({ description: 'now', nextStepIds: ['s2'] })));
    await waitFor(() => expect(screen.queryByText('● unsaved changes')).toBeNull());
    expect(screen.getByLabelText('Description')).toHaveValue('now');
    expect(afterWrite).toHaveBeenCalled();
  });

  it('Revert drops the edits; Save and Revert are disabled with nothing to save', async () => {
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)) }, { selection: { kind: 'step', stepId: 's1' } });
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Entry condition'), { target: { value: '4' } });
    expect(save).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(screen.getByLabelText('Entry condition')).toHaveValue('1');
    expect(save).toBeDisabled();
  });

  it('disables Save while Name is empty, showing the saved name as the placeholder', async () => {
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)) }, { selection: { kind: 'step', stepId: 's1' } });
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: '' } });
    expect(name).toHaveAttribute('placeholder', 'fetch');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('marks invalid JSON while typing and still lets the server judge it', async () => {
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(cacheDto('c1'))) }, { selection: { kind: 'cache', cacheId: 'c1' } });
    fireEvent.change(await screen.findByLabelText('Items'), { target: { value: '{"a":' } });
    expect(screen.getByText('Not valid JSON')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows a 400 under its field and a 409 in a banner, keeping what was typed', async () => {
    const putEntity = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { kind: 'badRequest', status: 400, detail: 'Validation failed', errors: { Version: ['Version must be x.y.z.'] } } })
      .mockResolvedValueOnce({ ok: false, error: { kind: 'conflict', status: 409, detail: 'Unique constraint violation: root already exists.', entity: null } });
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(cacheDto('c1'))), putEntity }, { selection: { kind: 'cache', cacheId: 'c1' } });
    fireEvent.change(await screen.findByLabelText('Version'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Version must be x.y.z.')).toBeInTheDocument();
    expect(screen.getByLabelText('Version')).toHaveValue('abc');
    expect(screen.getByLabelText('Version')).toHaveAttribute('aria-invalid', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved: Unique constraint violation: root already exists.');
    expect(screen.getByLabelText('Version')).toHaveValue('abc');
  });

  it('drills from a step to its processor and on to a schema slot, with a breadcrumb back', async () => {
    const getEntity = vi.fn(async (kind: string, id: string) =>
      ok(kind === 'step' ? step : kind === 'processor' ? processorDto('p1', { name: 'fetcher', configSchemaId: 'sc1' }) : schemaDto(id, { name: 'cfg' })));
    const { guard } = await renderInspector({ getEntity }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.click(await screen.findByRole('button', { name: /fetcher_1\.0\.0-p1/ }));
    expect(await screen.findByText('PROCESSOR')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'sc1' }));                   // the Config slot; the graph does not carry sc1
    expect(await screen.findByLabelText('Definition')).toHaveValue('{}');
    expect(screen.getByRole('navigation', { name: 'Drill-down' })).toHaveTextContent('Step›Processor›Config schema');
    expect(guard).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('PROCESSOR')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Step' }));
    expect(await screen.findByLabelText('Name')).toHaveValue('fetch');
  });

  it('shows why a restored draft cannot be read, and lets it be discarded (review focus 4)', async () => {
    const { store } = await renderInspector({ getEntity: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'notFound', status: 404 } }) },
      { selection: { kind: 'step', stepId: 's1' } });
    act(() => store.dispatch({ type: 'edit', workflowId: 'wf1', key: 'description', text: 'restored', saved: '' }));
    expect(await screen.findByText('This step no longer exists.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(store.getState().docs[0]!.inspector.edits).toEqual({});
  });
});
```

(Import `waitFor`, `vi`; `cacheDto`, `schemaDto` from `../api/fixtures`; `renderInspector` from `../test/inspector`.)

In `src/panels/inspectorView.test.ts`, replace the old view tests with tests of the new helpers:

```ts
import { describe, expect, it } from 'vitest';
import { stepDto } from '../api/fixtures';
import { loadedDocument } from '../app/fixtures';
import { detailRows, formatInstant, kindLabel, uniqueNameOf } from './inspectorView';

describe('inspectorView', () => {
  it('formats instants and leaves anything else as it came', () => {
    expect(formatInstant('2026-10-05T12:00:00.123456Z')).toBe('2026-10-05 12:00:00.123 UTC');
    expect(formatInstant('yesterday')).toBe('yesterday');
  });

  it("reads the base-entity details from the entity's last GET", () => {
    expect(detailRows(stepDto('s1', { createdBy: 'ana' })).map((r) => [r.label, r.value])).toEqual([
      ['Id', 's1'], ['Created at', '2026-10-05 12:00:00 UTC'], ['Created by', 'ana'], ['Updated at', '2026-10-05 12:00:00 UTC'], ['Updated by', '—'],
    ]);
  });

  it('names the entity by its saved name and marks a parked step', async () => {
    const doc = await loadedDocument();
    expect(uniqueNameOf(stepDto('s1', { name: 'fetch' }))).toBe('fetch_1.0.0-s1');
    expect(kindLabel({ kind: 'step', id: 's1' }, doc)).toBe('STEP');
    expect(kindLabel({ kind: 'step', id: 'parked' }, { ...doc, parkedIds: ['parked'] })).toBe('STEP · PARKED');
    expect(kindLabel({ kind: 'schema', id: 'sc1', slot: 'config' }, doc)).toBe('SCHEMA');
    expect(kindLabel({ kind: 'newAssignment', stepId: 's1', stepName: 'fetch' }, doc)).toBe('NEW ASSIGNMENT');
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/panels`
Expected: FAIL (no form fields, no `detailRows`, no `kindLabel`).

- [ ] **Step 4: The read-only parts**

Replace `src/panels/inspectorView.ts` with:

```ts
import type { EntityReadDto } from '../api/entities';
import type { StudioDocument } from '../app/document';
import { entityName } from '../model/entityNames';
import type { InspectorTarget } from '../store/inspectorTarget';

/** One read-only line of the Inspector. `value` is always text: an absent value reads "—". */
export interface Row {
  label: string;
  value: string;
}

const NONE = '—';
const text = (value: string | null | undefined): string => (value === null || value === undefined || value === '' ? NONE : value);

/** `2026-10-05T12:00:00.123456Z` → `2026-10-05 12:00:00.123 UTC`; anything else is shown as it came. */
export function formatInstant(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(iso);
  if (!m) return text(iso);
  return `${m[1]} ${m[2]}${m[3] ? m[3].slice(0, 4) : ''} UTC`;
}

/** The base-entity fields behind "▸ show all" (spec §7), from the entity's last GET. */
export function detailRows(dto: EntityReadDto): Row[] {
  return [
    { label: 'Id', value: text(dto.id) },
    { label: 'Created at', value: formatInstant(dto.createdAt ?? '') },
    { label: 'Created by', value: text(dto.createdBy) },
    { label: 'Updated at', value: formatInstant(dto.updatedAt ?? '') },
    { label: 'Updated by', value: text(dto.updatedBy) },
  ];
}

/** The unique name (spec §7) by the saved name and version, never by what is being typed. */
export function uniqueNameOf(dto: EntityReadDto): string {
  return entityName(dto.name ?? '', dto.version ?? '', dto.id ?? '');
}

/** The kind pill. */
export function kindLabel(target: InspectorTarget, doc: StudioDocument): string {
  switch (target.kind) {
    case 'step': return doc.parkedIds.includes(target.id) ? 'STEP · PARKED' : 'STEP';
    case 'newAssignment': return 'NEW ASSIGNMENT';
    default: return target.kind.toUpperCase();
  }
}
```

- [ ] **Step 5: One field**

Create `src/panels/FieldEditor.tsx`:

```tsx
import { useId } from 'react';
import { CONDITIONS, conditionInfo } from '../model/entryConditions';
import { jsonProblem, type FieldSpec } from '../store/entityForms';

/**
 * One writable field (spec §7.1). Free text: the server judges it; the browser only marks JSON that
 * does not parse and shows the saved Name or Version as the placeholder of a cleared one.
 */
export function FieldEditor({ spec, value, saved, errors, onChange }: {
  spec: FieldSpec;
  value: string;
  saved: string;
  errors: readonly string[];
  onChange: (text: string) => void;
}) {
  const id = useId();
  const json = spec.kind === 'json' ? jsonProblem(value) : null;
  const common = {
    id,
    className: spec.kind === 'json' ? 'input json' : 'input',
    'aria-invalid': errors.length > 0 || json !== null ? true : undefined,
    spellCheck: false,
  };
  let control;
  switch (spec.kind) {
    case 'text':
      control = <input {...common} type="text" value={value} placeholder={spec.required ? saved : undefined} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'multiline':
      control = <textarea {...common} rows={2} value={value} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'json':
      control = <textarea {...common} rows={6} value={value} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'condition': {
      const known = CONDITIONS.some((c) => String(c.value) === value);
      control = (
        <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          {!known && <option value={value} disabled>{`${conditionInfo(Number(value)).letter} · Invalid (${value})`}</option>}
          {CONDITIONS.map((c) => <option key={c.value} value={String(c.value)}>{`${c.letter} · ${c.name}`}</option>)}
        </select>
      );
      break;
    }
  }
  return (
    <div className={spec.kind === 'json' || spec.kind === 'multiline' ? 'field tall' : 'field'}>
      <label htmlFor={id}>{spec.label}</label>
      <div className="fval">
        {control}
        {json !== null && <div className="fnote">{json}</div>}
        {errors.map((message, i) => <div key={i} className="ferr">{message}</div>)}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: The Inspector**

Replace `src/panels/Inspector.tsx` with:

```tsx
import { Fragment, useEffect, useRef } from 'react';
import type { EntityReadDto } from '../api/entities';
import type { ProcessorReadDto, StepReadDto } from '../api/types';
import type { StudioDocument } from '../app/document';
import { useStudioActions } from '../app/studioActions';
import { entityName } from '../model/entityNames';
import { FIELDS, missingRequired, savedText, shownText, type FieldSpec } from '../store/entityForms';
import { hasEdits } from '../store/inspector';
import { crumbLabel, entityKindOf, rootTarget, targetKey, type InspectorTarget, type SchemaSlot } from '../store/inspectorTarget';
import { activeDocument, shownTargetOf, type OpenDocument } from '../store/studioState';
import { useStudio, useStudioStore } from '../store/studioStore';
import { FieldEditor } from './FieldEditor';
import { detailRows, kindLabel, uniqueNameOf, type Row } from './inspectorView';
import { PaneNote } from './PaneNote';

/** Read-only text: one line, cut with an ellipsis, its full text a tooltip only when cut (spec §7). */
const readOnly = (row: Row) => (
  <div key={row.label} className="field"><label>{row.label}</label><span className="ro" data-tipcut={row.value}>{row.value}</span></div>
);

/**
 * The shared Inspector (spec §7, §7.1). It follows the active document's selection wherever the pane
 * is, reads the shown entity, and edits its own metadata: Save and Revert, drill-downs with a
 * breadcrumb, server errors under their fields or in a banner. Unsaved edits live in the store.
 */
export function Inspector() {
  const active = useStudio(activeDocument);
  const { service } = useStudioActions();
  const target = active === null ? null : shownTargetOf(active);
  const key = targetKey(target);
  const workflowId = active?.workflowId ?? null;
  const ready = active?.status.kind === 'ready';
  useEffect(() => {
    if (workflowId !== null && ready && key !== 'none') service.read(workflowId);
  }, [service, workflowId, ready, key]);

  if (active === null) return <PaneNote pane="inspector">Open a workflow to inspect it.</PaneNote>;
  if (active.status.kind === 'loading') return <PaneNote pane="inspector">Loading…</PaneNote>;
  if (active.status.kind === 'failed') return <PaneNote pane="inspector">{active.status.message}</PaneNote>;
  if (target === null) return <PaneNote pane="inspector">Nothing selected. Click a step, a processor, a cache or the workflow.</PaneNote>;
  return <EntityPane open={active} doc={active.status.doc} target={target} />;
}

function EntityPane({ open, doc, target }: { open: OpenDocument; doc: StudioDocument; target: InspectorTarget }) {
  const store = useStudioStore();
  const showDetails = useStudio((s) => s.showDetails);
  const { service, guard } = useStudioActions();
  const owner = useRef<HTMLDivElement>(null);
  const { workflowId, inspector } = open;
  const go = (proceed: () => void) => guard(workflowId, proceed, owner.current?.ownerDocument ?? document);
  const drill = (next: InspectorTarget) => go(() => store.dispatch({ type: 'drill', workflowId, target: next }));
  const back = (depth: number) => go(() => store.dispatch({ type: 'back', workflowId, depth }));
  const crumbs = [rootTarget(open.selection, workflowId)!, ...inspector.trail];
  const saved = inspector.saved?.key === targetKey(target) ? inspector.saved.dto : null;
  const dirty = hasEdits(inspector);

  return (
    <div className="paneBody" data-pane="inspector" ref={owner}>
      <div className="ph2">
        <span className="kindpill">{kindLabel(target, doc)}</span>
        {dirty && <span className="unsaved">● unsaved changes</span>}
      </div>
      {crumbs.length > 1 && (
        <nav className="crumbs" aria-label="Drill-down">
          <button type="button" className="link" aria-label="Back" onClick={() => back(inspector.trail.length - 1)}>‹</button>
          {crumbs.map((t, i) => (i === crumbs.length - 1
            ? <span key={i} aria-current="page">{crumbLabel(t)}</span>
            : <Fragment key={i}><button type="button" className="link" onClick={() => back(i)}>{crumbLabel(t)}</button><span className="sep">›</span></Fragment>))}
        </nav>
      )}
      {saved === null ? (
        <div className="pbody">
          <div className="sec">
            <p className={inspector.readError ? 'note warn' : 'note'}>{inspector.readError ?? 'Loading…'}</p>
            {inspector.readError && dirty && (
              <button type="button" className="btn" onClick={() => store.dispatch({ type: 'discard', workflowId })}>Discard unsaved changes</button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="pbody">
            <EntityForm open={open} doc={doc} target={target} saved={saved} showDetails={showDetails} drill={drill} />
          </div>
          <div className="savebar">
            {inspector.failure?.banner && <div className="banner" role="alert">{inspector.failure.banner}</div>}
            <button type="button" className="btn" disabled={!dirty || inspector.busy} onClick={() => store.dispatch({ type: 'discard', workflowId })}>Revert</button>
            <button type="button" className="btn primary" disabled={!dirty || inspector.busy || missingRequired(entityKindOf(target), saved, inspector.edits)}
              onClick={() => void service.save(workflowId)}>{inspector.busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      )}
    </div>
  );
}

const SLOTS: ReadonlyArray<{ slot: SchemaSlot; label: string; key: 'inputSchemaId' | 'outputSchemaId' | 'configSchemaId' }> = [
  { slot: 'input', label: 'In', key: 'inputSchemaId' },
  { slot: 'output', label: 'Out', key: 'outputSchemaId' },
  { slot: 'config', label: 'Config', key: 'configSchemaId' },
];

function EntityForm({ open, doc, target, saved, showDetails, drill }: {
  open: OpenDocument; doc: StudioDocument; target: InspectorTarget; saved: EntityReadDto; showDetails: boolean; drill: (t: InspectorTarget) => void;
}) {
  const store = useStudioStore();
  const { workflowId, inspector } = open;
  const kind = entityKindOf(target);
  const editor = (spec: FieldSpec) => (
    <FieldEditor key={spec.key} spec={spec} value={shownText(saved, inspector.edits, spec.key)} saved={savedText(saved, spec.key)}
      errors={inspector.failure?.fields[spec.key] ?? []}
      onChange={(text) => store.dispatch({ type: 'edit', workflowId, key: spec.key, text, saved: savedText(saved, spec.key) })} />
  );
  const name = uniqueNameOf(saved);
  const { graph } = doc;

  return (
    <>
      <div className="sec">
        <div className="uname" aria-label="Unique name"><span className="ro" data-tipcut={name}>{name}</span></div>
        <div className="sec-title">{crumbLabel(target)}</div>
        {FIELDS[kind].slice(0, 2).map(editor)}
        <div className="metatog">
          <button type="button" className="link" onClick={() => store.dispatch({ type: 'toggleDetails' })}>
            {showDetails ? '▾ hide details' : '▸ show all'}
          </button>
        </div>
        {showDetails && <div className="meta">{detailRows(saved).map(readOnly)}</div>}
        {FIELDS[kind].slice(2).map(editor)}
        {target.kind === 'step' && (() => {
          const step = saved as StepReadDto;
          const p = graph.processors.get(step.processorId ?? '');
          const label = p ? entityName(p.name, p.version, p.id) : step.processorId ?? '';
          return (
            <div className="field">
              <label>Processor</label>
              <button type="button" className="drill" data-tipcut={label} onClick={() => drill({ kind: 'processor', id: step.processorId ?? '' })}>{label}</button>
            </div>
          );
        })()}
        {target.kind === 'step' && doc.parkedIds.includes(target.id) && <div className="note warn">⚠ Parked: not connected, so not part of this workflow.</div>}
      </div>
      {target.kind === 'processor' && (
        <div className="sec">
          <div className="sec-title">Schemas</div>
          {SLOTS.map(({ slot, label, key }) => {
            const id = (saved as ProcessorReadDto)[key];
            const schema = id ? graph.schemas.get(id) : undefined;
            const text = id ? (schema ? entityName(schema.name, schema.version, schema.id) : id) : '∅';
            return (
              <div key={slot} className="slot">
                <span className="k">{label}</span>
                {id
                  ? <button type="button" className="v drill" data-tipcut={text} onClick={() => drill({ kind: 'schema', id, slot })}>{text}</button>
                  : <span className="v null" data-tipcut={text}>{text}</span>}
                <span />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
```

`OpenDocument` must be exported from `store/studioState.ts` (it already is; check).

- [ ] **Step 7: Styles**

Append to `src/panels/panels.css`:

```css
/* inspector editing (slice 3b; mockup v49 .input, .btn) */
.input { font-family: var(--mono); font-size: 12px; background: var(--ground-2); border: 1px solid var(--line-2); border-radius: 5px; padding: 6px 8px; color: var(--ink); width: 100%; min-width: 0; box-sizing: border-box; }
.input::placeholder { color: var(--faint); }
.input[aria-invalid="true"] { border-color: var(--f); }
textarea.input { resize: vertical; line-height: 1.45; font-family: var(--mono); }
textarea.input.json { white-space: pre; overflow: auto; }
select.input { appearance: auto; }
.field.tall { align-items: start; }
.field.tall > label { padding-top: 7px; }
.fval { min-width: 0; }
.ferr { margin-top: 3px; font-size: 11.5px; color: var(--f); }
.fnote { margin-top: 3px; font-size: 11.5px; color: var(--x); }
.drill { font-family: var(--mono); font-size: 12px; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drill::after { content: " ›"; color: var(--faint); }
.slot .v.drill { color: var(--accent); }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 16px 0; font-size: 12px; color: var(--muted); }
.crumbs .sep { color: var(--faint); }
.crumbs [aria-current] { color: var(--ink); }
.unsaved { margin-left: 8px; font-size: 11.5px; color: var(--x); }
.savebar { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); background: var(--panel); }
.banner { flex: 1 0 100%; padding: 6px 8px; font-size: 12px; color: var(--f); background: rgba(255, 122, 102, .08); border: 1px solid rgba(255, 122, 102, .35); border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
.btn:disabled { opacity: .45; cursor: default; }
.link.danger { color: var(--f); }
```

- [ ] **Step 8: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src/panels src/test`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS, no warnings. The e2e tests that read the Inspector (`.kindpill`, `.slot`, `.uname`) still find them.

```bash
git add src/WorkflowStudio/src/panels/Inspector.tsx src/WorkflowStudio/src/panels/FieldEditor.tsx src/WorkflowStudio/src/panels/inspectorView.ts src/WorkflowStudio/src/panels/inspectorView.test.ts src/WorkflowStudio/src/panels/panes.test.tsx src/WorkflowStudio/src/panels/panels.css src/WorkflowStudio/src/test/inspector.tsx
git commit -m "feat(studio): the Inspector edits each entity's metadata, with drill-downs, Save, Revert and server errors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The step's assignment: open, edit, add, unlink

**Files:**
- Modify: `src/panels/Inspector.tsx`
- Test: `src/panels/panes.test.tsx`

**Interfaces:**
- Consumes: `assignmentByStep`, `payloadKeyCount` (`model/assignments.ts`); `service.create`; `confirmUnlink` (the page implements it in Task 7; the harness records it).

- [ ] **Step 1: Write the failing tests**

Add to `describe('Inspector editing (slice 3b)', …)` in `src/panels/panes.test.tsx` (import `assignmentDto`, `workflowDto`, `graphDto`, `stepDto`, `processorDto`, and `inspectorGraph` from the harness):

```tsx
  const withAssignment = graphDto({
    ...inspectorGraph,
    assignments: [assignmentDto('a1', { stepId: 's1', payload: '{"k":1,"j":2}' })],
  } as never);

  it("opens a step's assignment and saves it with its step unchanged", async () => {
    const assignment = assignmentDto('a1', { stepId: 's1', payload: '{"k":1,"j":2}' });
    const putEntity = vi.fn().mockResolvedValue(ok({ ...assignment, payload: '{"k":3}' }));
    const getEntity = vi.fn(async (kind: string) => ok(kind === 'step' ? step : assignment));
    await renderInspector({ getEntity, putEntity }, { selection: { kind: 'step', stepId: 's1' }, graph: withAssignment });
    fireEvent.click(await screen.findByRole('button', { name: '◆ 2 keys' }));
    fireEvent.change(await screen.findByLabelText('Payload'), { target: { value: '{"k":3}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putEntity).toHaveBeenCalledWith('assignment', 'a1', {
      name: 'assignment-a1', version: '1.0.0', description: null, stepId: 's1', payload: '{"k":3}',
    }));
  });

  it('adds an assignment to a step that has none: a prefilled form, then Create', async () => {
    const created = assignmentDto('a9', { name: 'fetch-assignment', stepId: 's1' });
    const createAssignment = vi.fn().mockResolvedValue(ok(created));
    const getEntity = vi.fn(async (kind: string) => ok(kind === 'step' ? step : kind === 'workflow' ? workflowDto() : created));
    const putEntity = vi.fn().mockResolvedValue(ok(workflowDto({ assignmentIds: ['a9'] })));
    await renderInspector({ getEntity, putEntity, createAssignment }, { selection: { kind: 'step', stepId: 's1' } });

    fireEvent.click(await screen.findByRole('button', { name: '＋ Add assignment' }));
    expect(await screen.findByText('NEW ASSIGNMENT')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('fetch-assignment');
    expect(screen.getByLabelText('Payload')).toHaveValue('{}');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(putEntity).toHaveBeenCalledWith('workflow', 'wf1', expect.objectContaining({ assignmentIds: ['a9'] })));
    expect(createAssignment).toHaveBeenCalledWith({ name: 'fetch-assignment', version: '1.0.0', description: null, stepId: 's1', payload: '{}' });
    expect(await screen.findByText('ASSIGNMENT')).toBeInTheDocument();
  });

  it('the new-assignment form cancels back to its step', async () => {
    await renderInspector({ getEntity: vi.fn().mockResolvedValue(ok(step)) }, { selection: { kind: 'step', stepId: 's1' } });
    fireEvent.click(await screen.findByRole('button', { name: '＋ Add assignment' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('STEP')).toBeInTheDocument();
  });

  it('asks the page before unlinking an assignment from this workflow', async () => {
    const assignment = assignmentDto('a1', { stepId: 's1' });
    const { confirmUnlink } = await renderInspector({ getEntity: vi.fn(async (kind: string) => ok(kind === 'step' ? step : assignment)) },
      { selection: { kind: 'step', stepId: 's1' }, graph: withAssignment });
    fireEvent.click(await screen.findByRole('button', { name: '◆ 2 keys' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink from this workflow' }));
    expect(confirmUnlink).toHaveBeenCalledWith('wf1', document);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/panels/panes.test.tsx`
Expected: FAIL (no assignment row, form or buttons).

- [ ] **Step 3: Implement**

In `src/panels/Inspector.tsx`:

- Import `assignmentByStep, payloadKeyCount` from `../model/assignments` and `AssignmentReadDto` from `../api/types`.
- In `EntityForm`, after the step's Processor row, add the Assignment row:

```tsx
        {target.kind === 'step' && (() => {
          const assignment = assignmentByStep(graph.assignments).get(target.id);
          if (!assignment) {
            const stepName = (saved as StepReadDto).name ?? '';
            return (
              <div className="field">
                <label>Assignment</label>
                <button type="button" className="link" onClick={() => drill({ kind: 'newAssignment', stepId: target.id, stepName })}>＋ Add assignment</button>
              </div>
            );
          }
          const keys = payloadKeyCount(assignment.payload);
          const label = keys === null ? '◆ payload' : `◆ ${keys} key${keys === 1 ? '' : 's'}`;
          return (
            <div className="field">
              <label>Assignment</label>
              <button type="button" className="drill" onClick={() => drill({ kind: 'assignment', id: assignment.id, stepId: target.id })}>{label}</button>
            </div>
          );
        })()}
```

- For an assignment or the new-assignment form, show its step, read-only, after the fields:

```tsx
        {(target.kind === 'assignment' || target.kind === 'newAssignment') && (() => {
          const stepId = (saved as AssignmentReadDto).stepId ?? target.stepId;
          const s = graph.steps.get(stepId);
          return readOnly({ label: 'Step', value: s ? entityName(s.name, s.version, s.id) : stepId });
        })()}
```

- The new-assignment form has no id yet: in `EntityForm`, its unique-name line reads `New assignment for {step unique name}`. Compute `name` as `target.kind === 'newAssignment' ? `New assignment for ${…}` : uniqueNameOf(saved)`, using the same step lookup. Do not show "▸ show all" for it (it has no audit fields yet).
- In `EntityPane`'s save bar:
  - For `newAssignment`, replace Revert / Save with **Cancel** (`back(inspector.trail.length - 1)`) and **Create** (`disabled={inspector.busy || missingRequired('assignment', saved, inspector.edits)}`, `onClick={() => void service.create(workflowId)}`, label `Creating…` while busy). Create is enabled with no edits: the defaults are a valid assignment.
  - For `assignment`, add before Revert: `<button type="button" className="link danger" disabled={inspector.busy} onClick={() => confirmUnlink(workflowId, owner.current?.ownerDocument ?? document)}>Unlink from this workflow</button>` (destructure `confirmUnlink` from `useStudioActions()`).

- [ ] **Step 4: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src/panels`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS.

```bash
git add src/WorkflowStudio/src/panels/Inspector.tsx src/WorkflowStudio/src/panels/panes.test.tsx
git commit -m "feat(studio): a step's assignment in the Inspector: open and edit it, add one, or unlink it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The page guards unsaved edits and refreshes after a write

**Files:**
- Create: `src/app/ConfirmDialog.tsx`
- Modify: `src/App.tsx`, `src/app/DocumentPanel.tsx`, `src/panels/Problems.tsx`, `src/app/document.css`
- Test: `src/App.test.tsx`, `src/app/DocumentPanel.test.tsx`

**Interfaces:**
- Consumes: the service and `StudioActions` (Task 4); `refreshed`, `retry` (Task 3).
- Produces: `ConfirmDialog` (`{ doc, title, message, buttons, onCancel }`); `DocumentPanel` props `onSelect?(selection)`, `onRetry?()`.

- [ ] **Step 1: Write the failing tests**

In `src/App.test.tsx`, reuse `fakeApi` and the session seeding of the plan 3d tests (`SESSION_KEY`, `memoryStorage`, the `tabStorage` prop). Add:

```tsx
describe('unsaved Inspector edits (slice 3b)', () => {
  const draftSession = (edits: Record<string, string>, extra: object[] = []) => memoryStorage({ [SESSION_KEY]: JSON.stringify({
    version: 1, activeId: ALPHA, showDetails: false, dock: null,
    docs: [{ workflowId: ALPHA, name: 'alpha', version: '1.0.0', selection: { kind: 'step', stepId: 's1' }, view: null, draft: { trail: [], edits } }, ...extra],
  }) });
  const withEntities = (over: Partial<StudioApi> = {}) => fakeApi({
    getEntity: vi.fn().mockResolvedValue({ ok: true, value: stepDto('s1', { name: 'fetch' }) }),
    putEntity: vi.fn().mockResolvedValue({ ok: true, value: stepDto('s1', { name: 'fetch', description: 'typed' }) }),
    ...over,
  });
  const dialog = () => screen.findByRole('alertdialog', { name: 'Unsaved changes' });

  it('brings a draft back after a refresh, marked unsaved', async () => {
    render(<App api={withEntities()} storage={memoryStorage()} tabStorage={draftSession({ description: 'typed' })} />);
    expect(await screen.findByLabelText('Description')).toHaveValue('typed');
    expect(screen.getByText('● unsaved changes')).toBeInTheDocument();
  });

  it('asks before Escape drops a selection with unsaved edits: Cancel keeps, Discard drops', async () => {
    render(<App api={withEntities()} storage={memoryStorage()} tabStorage={draftSession({ description: 'typed' })} />);
    await screen.findByLabelText('Description');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Description')).toHaveValue('typed');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText(/Nothing selected/)).toBeInTheDocument();
  });

  it('Save in the dialog saves, then goes on', async () => {
    const api = withEntities();
    render(<App api={api} storage={memoryStorage()} tabStorage={draftSession({ description: 'typed' })} />);
    await screen.findByLabelText('Description');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Nothing selected/)).toBeInTheDocument();
    expect(api.putEntity).toHaveBeenCalledWith('step', 's1', expect.objectContaining({ description: 'typed' }));
  });

  it('a failed Save in the dialog moves nothing and shows why', async () => {
    render(<App api={withEntities({ putEntity: vi.fn().mockResolvedValue({ ok: false, error: { kind: 'network', message: 'down' } }) })}
      storage={memoryStorage()} tabStorage={draftSession({ description: 'typed' })} />);
    await screen.findByLabelText('Description');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved: BaseApi unreachable');
    expect(screen.getByLabelText('Description')).toHaveValue('typed');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Escape inside the dialog cancels it only (review focus 5)', async () => {
    render(<App api={withEntities()} storage={memoryStorage()} tabStorage={draftSession({ description: 'typed' })} />);
    await screen.findByLabelText('Description');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(within(await dialog()).getByRole('button', { name: 'Save' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByLabelText('Description')).toHaveValue('typed');
  });

  it('asks before closing a document with unsaved edits', async () => {
    render(<App api={withEntities()} storage={memoryStorage()} tabStorage={draftSession({ description: 'typed' })} />);
    await screen.findByLabelText('Description');
    fireEvent.click(screen.getByRole('button', { name: 'Close alpha' }));
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryAllByText('alpha', { selector: '.doctab .nm' })).toHaveLength(0));
  });

  it('re-reads every open document after a save', async () => {
    const api = withEntities();
    render(<App api={api} storage={memoryStorage()} tabStorage={draftSession({ description: 'typed' },
      [{ workflowId: ZETA, name: 'zeta', version: '1.0.0', selection: null, view: null }])} />);
    await screen.findByLabelText('Description');
    await waitFor(() => expect(api.getGraph).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.getGraph).toHaveBeenCalledTimes(4));
    expect(api.validate).toHaveBeenCalledTimes(4);
  });

  it('a failed document can be retried, and keeps its draft meanwhile', async () => {
    const getGraph = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { kind: 'network', message: 'down' } })
      .mockResolvedValue({ ok: true, value: graphDto({ workflow: workflowDto({ id: ALPHA, name: 'alpha' }), steps: [stepDto('s1', { name: 'fetch' })] }) });
    const tab = draftSession({ description: 'typed' });
    render(<App api={withEntities({ getGraph })} storage={memoryStorage()} tabStorage={tab} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Description')).toHaveValue('typed');
  });
});
```

(Import `within`, `waitFor`; `stepDto`, `graphDto`, `workflowDto` from `./api/fixtures`; `StudioApi` type. `ALPHA` / `ZETA` and `fakeApi` are the file's.)

In `src/app/DocumentPanel.test.tsx`, add a test that a failed document shows a **Retry** button calling `onRetry`, and that `onSelect`, when given, replaces the panel's own dispatch.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/App.test.tsx src/app/DocumentPanel.test.tsx`
Expected: FAIL (no actions provider, no dialog, no retry, no refresh).

- [ ] **Step 3: The dialog**

Create `src/app/ConfirmDialog.tsx`:

```tsx
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface DialogButton {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

/**
 * The studio's modal question (mockup v49 `.modal`), drawn in the window the action came from.
 * The primary button has focus; Escape is Cancel and goes no further (the dock skips a handled key).
 */
export function ConfirmDialog({ doc, title, message, buttons, onCancel }: {
  doc: Document;
  title: string;
  message: ReactNode;
  buttons: readonly DialogButton[];
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    const before = doc.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLButtonElement>('.btn.primary')?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, [doc]);
  return createPortal(
    <div className="modal on" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      <div className="mbox" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId} ref={box}>
        <div className="mt" id={titleId}>{title}</div>
        <div className="mb" id={messageId}>{message}</div>
        <div className="mbtns">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <span className="spacer" />
          {buttons.map((b) => (
            <button key={b.label} type="button" className={b.primary ? 'btn primary' : 'btn'} onClick={b.onClick}>{b.label}</button>
          ))}
        </div>
      </div>
    </div>,
    doc.body,
  );
}
```

Append to `src/app/document.css` (mockup v49 `.modal`, `.mbox`, `.mt`, `.mb`, `.mbtns`):

```css
/* the modal question (mockup v49 .modal) */
.modal { position: fixed; inset: 0; display: none; place-items: center; background: rgba(3, 8, 16, .6); backdrop-filter: blur(2px); z-index: var(--z-modal); font-family: var(--sans); }
.modal.on { display: grid; }
.mbox { width: 420px; max-width: calc(100vw - 32px); padding: 20px 20px 16px; background: var(--panel-2); border: 1px solid var(--line-2); border-radius: 12px; box-shadow: 0 30px 80px -20px rgba(0, 0, 0, .85); color: var(--ink); }
.mt { font-size: 16px; font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
.mt::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--x); }
.mb { font-size: 13px; color: var(--muted); line-height: 1.55; margin-bottom: 18px; }
.mb b { color: var(--ink); font-weight: 600; }
.mbtns { display: flex; gap: 8px; align-items: center; }
.mbtns .spacer { flex: 1; }
.doc-msg .btn { margin-left: 10px; }
```

- [ ] **Step 4: The page**

In `src/App.tsx`, in `Studio`:

- Imports: `ConfirmDialog` from `./app/ConfirmDialog`; `createInspectorService` from `./app/inspectorService`; `StudioActionsProvider, type StudioActions` from `./app/studioActions`; `hasEdits` from `./store/inspector`; `selectionKey, type Selection` from `./store/selection`; `useState` already imported.
- After `load`, add the re-read of a ready document and of all of them:

```tsx
  /** Re-reads a ready document after a write (spec §7.1); a failure keeps its last drawing. */
  const refresh = useCallback((id: string) => {
    const token = (opens.current.get(id) ?? 0) + 1;
    opens.current.set(id, token);
    void loadDocument(api, id).then((r) => {
      const current = store.getState().docs.find((d) => d.workflowId === id);
      if (opens.current.get(id) !== token || current?.status.kind !== 'ready') return;
      if (r.ok) store.dispatch({ type: 'refreshed', workflowId: id, doc: r.value });
      else setNotice((n) => ({ id: n.id + 1, text: `${current.name} could not be re-read: ${describeError(r.error)}` }));
    });
  }, [api, store]);
```

  (`notice` is added in Task 8; in this task declare `const [notice, setNotice] = useState({ id: 0, text: '' });` here and leave it unused by the dock until Task 8, or pass it now if Task 8's prop exists. Either way the toast text above is the one to use.)

- The service and the actions:

```tsx
  const serviceRef = useRef<ReturnType<typeof createInspectorService> | null>(null);
  const afterWrite = useCallback(() => {
    for (const d of store.getState().docs) {
      if (d.status.kind === 'ready') refresh(d.workflowId);
      serviceRef.current?.read(d.workflowId, true);
    }
  }, [store, refresh]);
  const service = useMemo(() => createInspectorService(api, store, afterWrite), [api, store, afterWrite]);
  serviceRef.current = service;

  type Prompt =
    | { kind: 'unsaved'; workflowId: string; proceed: () => void; doc: Document }
    | { kind: 'unlink'; workflowId: string; doc: Document };
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  const actions: StudioActions = useMemo(() => ({
    service,
    guard: (workflowId, proceed, doc = document) => {
      const open = store.getState().docs.find((d) => d.workflowId === workflowId);
      if (!open || !hasEdits(open.inspector)) { proceed(); return; }
      setPrompt({ kind: 'unsaved', workflowId, proceed, doc });
    },
    confirmUnlink: (workflowId, doc = document) => setPrompt({ kind: 'unlink', workflowId, doc }),
  }), [service, store]);
```

- In the restored-documents effect and `openWorkflow` nothing changes. Wire the guard:
  - `onCloseDocument={(id) => actions.guard(id, () => { views.current.delete(id); store.dispatch({ type: 'close', workflowId: id }); })}`
  - `onEscape={() => { const id = store.getState().activeId; if (id !== null) actions.guard(id, () => store.dispatch({ type: 'select', workflowId: id, selection: null })); }}`
  - `renderDocument`: pass `onSelect` and `onRetry` to `DocumentPanel`:

```tsx
          onSelect={(selection: Selection | null) => {
            store.dispatch({ type: 'activate', workflowId: id });
            const open = store.getState().docs.find((d) => d.workflowId === id);
            if (open && selectionKey(open.selection) === selectionKey(selection)) return;
            actions.guard(id, () => store.dispatch({ type: 'select', workflowId: id, selection }));
          }}
          onRetry={() => { store.dispatch({ type: 'retry', workflowId: id }); load(id); }}
```

- Wrap the returned `<DockShell …/>` in `<StudioActionsProvider value={actions}>…</StudioActionsProvider>`, and render the prompt after the dock, inside the provider:

```tsx
      {prompt?.kind === 'unsaved' && (
        <ConfirmDialog doc={prompt.doc} title="Unsaved changes" onCancel={() => setPrompt(null)}
          message={<>The Inspector has unsaved changes in <b>{store.getState().docs.find((d) => d.workflowId === prompt.workflowId)?.name}</b>.</>}
          buttons={[
            { label: 'Discard', onClick: () => { setPrompt(null); store.dispatch({ type: 'discard', workflowId: prompt.workflowId }); prompt.proceed(); } },
            { label: 'Save', primary: true, onClick: () => { setPrompt(null); void service.save(prompt.workflowId).then((saved) => { if (saved) prompt.proceed(); }); } },
          ]} />
      )}
      {prompt?.kind === 'unlink' && (
        <ConfirmDialog doc={prompt.doc} title="Unlink assignment" onCancel={() => setPrompt(null)}
          message="This workflow stops using the assignment. The assignment itself is kept."
          buttons={[{ label: 'Unlink', primary: true, onClick: () => { setPrompt(null); void service.unlink(prompt.workflowId); } }]} />
      )}
```

In `src/app/DocumentPanel.tsx`:
- Add props `onSelect?: (selection: Selection | null) => void` and `onRetry?: () => void` (import `Selection` from `../store/selection`).
- `WorkflowCanvas`'s `onSelect` becomes `onSelect ?? ((selection) => { store.dispatch({ type: 'activate', workflowId }); store.dispatch({ type: 'select', workflowId, selection }); })`.
- The failed state gains a Retry button: `<div className="doc-msg error" role="alert">{open.status.message}{onRetry && <button type="button" className="btn" onClick={onRetry}>Retry</button>}</div>`.

In `src/panels/Problems.tsx`, guard the click: `const guard = useGuard();` (from `../app/studioActions`), and `select` becomes `() => guard(active.workflowId, () => store.dispatch({ type: 'select', workflowId: active.workflowId, selection: target }))`.

- [ ] **Step 5: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS, no warnings (watch for `act(...)` warnings from the refresh's promises: await them with `waitFor`).

```bash
git add src/WorkflowStudio/src/app/ConfirmDialog.tsx src/WorkflowStudio/src/app/document.css src/WorkflowStudio/src/App.tsx src/WorkflowStudio/src/App.test.tsx src/WorkflowStudio/src/app/DocumentPanel.tsx src/WorkflowStudio/src/app/DocumentPanel.test.tsx src/WorkflowStudio/src/panels/Problems.tsx
git commit -m "feat(studio): Save / Discard / Cancel before leaving unsaved edits, a refresh of every document after a write, and Retry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Unsaved on the tab and the capsule; the session-write toast; a safer schema read

**Files:**
- Modify: `src/dock/DockShell.tsx`, `src/dock/parts.tsx`, `src/dock/dock.css`, `src/app/CapsuleToolbar.tsx`, `src/app/DocumentPanel.tsx`, `src/App.tsx`, `src/app/loadDocument.ts`
- Test: `src/dock/DockShell.test.tsx`, `src/app/DocumentPanel.test.tsx`, `src/App.test.tsx`, `src/app/loadDocument.test.ts`

**Interfaces:**
- Produces: `DockDocument.dirty?: boolean`; `DockShellProps.notice?: { id: number; text: string }`; `CapsuleToolbar` props `dirty`, `busy`, `onSave`.

- [ ] **Step 1: Write the failing tests**

- `src/dock/DockShell.test.tsx`:

```tsx
  it("marks an unsaved document's tab (mockup v49 .doctab.dirty)", () => {
    setup({ documents: [{ ...doc('a'), dirty: true }, doc('b')] });
    const tabs = [...document.querySelectorAll('.doctab')].filter((t) => t.querySelector('.nm')?.textContent?.startsWith('wf-'));
    expect(tabs.map((t) => [t.querySelector('.nm')!.textContent, t.classList.contains('dirty')])).toEqual([['wf-a', true], ['wf-b', false]]);
    expect(tabs[0]!.querySelector('.ud')).toHaveAttribute('data-tip', 'unsaved changes');
  });

  it('shows a toast for each new notice', () => {
    const { update } = setup({ notice: { id: 1, text: 'first' } });
    expect(toast()).toHaveTextContent('first');
    update({ notice: { id: 2, text: 'second' } });
    expect(toast()).toHaveTextContent('second');
  });
```

  (Use the file's `setup`/`update`/`toast` helpers; if `setup` does not return `update`, re-render with the file's existing pattern.)
- `src/app/DocumentPanel.test.tsx`: the capsule's Save is disabled with "Nothing to save yet" when the document has no edits; with edits it is enabled, shows "● unsaved changes", and clicking it calls the given `onSave`.
- `src/App.test.tsx`: in Task 7's "brings a draft back after a refresh" test, add `expect(document.querySelector('.doctab.dirty')).not.toBeNull();` (the restored draft marks its tab).
- `src/App.test.tsx`: a session write the browser refuses shows the toast once: render with `tabStorage` and `storage` whose `setItem` throws and `getItem` returns null; open a workflow; expect the toast text `This browser would not keep the session: a refresh may lose unsaved changes` once (`getAllByText` length 1 after two changes).
- `src/app/loadDocument.test.ts`: a parked step's processor names a schema whose GET returns a body without an id; the document still opens, and the schema is left out (`graph.schemas.has(id)` is false).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/dock/DockShell.test.tsx src/app src/App.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `src/dock/DockShell.tsx`:
  - `DockDocument` gains `/** Unsaved changes: the tab shows the amber dot. */ dirty?: boolean;`.
  - `DockShellProps` gains `/** A message for the toast; a new id shows it (the page's notices, e.g. a refused session write). */ notice?: { id: number; text: string };`.
  - After `showToast`: `useEffect(() => { if (props.notice && props.notice.text) showToast(props.notice.text); }, [props.notice?.id]);` (add a comment that the id is the trigger).
  - `documentInfo` (what `StudioTab` reads) carries `dirty`.
- `src/dock/parts.tsx`, `StudioTab`: `className={info?.dirty ? 'doctab dirty' : 'doctab'}`, and the first child `{info && <span className="ud" data-tip="unsaved changes" />}`.
- `src/dock/dock.css`: `.doctab .ud { width: 7px; height: 7px; border-radius: 50%; background: var(--x); display: none; flex: none; }` and `.doctab.dirty .ud { display: block; }`.
- `src/App.tsx`:
  - `documents` carries `dirty: hasEdits(d.inspector)`; add the dirty flag to the `identity` string so the memo updates.
  - Pass `notice={notice}` to `DockShell`.
  - In the saver, toast once per failure streak:

```tsx
  const sessionRefused = useRef(false);
  // inside the createSaver callback, replacing the bare writeTabSession call:
    const kept = writeTabSession(tabStorage, storage, sessionOf(state, views.current, dockState.current));
    if (!kept && !sessionRefused.current) setNotice((n) => ({ id: n.id + 1, text: 'This browser would not keep the session: a refresh may lose unsaved changes' }));
    sessionRefused.current = !kept;
```

  - `renderDocument` passes `onSave={() => void service.save(id)}` to `DocumentPanel`.
- `src/app/DocumentPanel.tsx`: prop `onSave?: () => void`; pass `dirty={hasEdits(open.inspector)}`, `busy={open.inspector.busy}` and `onSave` to `CapsuleToolbar`.
- `src/app/CapsuleToolbar.tsx`: props `dirty?: boolean; busy?: boolean; onSave?: () => void`. The Save button:

```tsx
        {dirty && onSave
          ? <button type="button" className="qb" disabled={busy} onClick={onSave} data-tip="Save the Inspector's changes">⤓ Save</button>
          : <span data-tip="Nothing to save yet"><button type="button" className="qb" disabled>⤓ Save</button></span>}
```

  and, after the status pill, `{dirty && <span className="cap-b dirtyl">● unsaved changes</span>}`. Add to `src/app/document.css`: `.docbar .dirtyl { color: var(--x); font-size: 12px; }`. Update the component comment: Save saves the Inspector's edits (slice 3b); Start and Stop stay disabled.
- `src/app/loadDocument.ts`, `loadMissingSchemas`: `if (schema.ok) { try { graph.schemas.set(id, schemaFromDto(schema.value)); } catch { /* a body without an id is left out: the slot shows its raw id */ } }`.

- [ ] **Step 4: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS, no warnings.

```bash
git add src/WorkflowStudio/src/dock/DockShell.tsx src/WorkflowStudio/src/dock/DockShell.test.tsx src/WorkflowStudio/src/dock/parts.tsx src/WorkflowStudio/src/dock/dock.css src/WorkflowStudio/src/app/CapsuleToolbar.tsx src/WorkflowStudio/src/app/DocumentPanel.tsx src/WorkflowStudio/src/app/DocumentPanel.test.tsx src/WorkflowStudio/src/app/document.css src/WorkflowStudio/src/App.tsx src/WorkflowStudio/src/App.test.tsx src/WorkflowStudio/src/app/loadDocument.ts src/WorkflowStudio/src/app/loadDocument.test.ts
git commit -m "feat(studio): unsaved on the tab and the capsule, whose Save saves the Inspector; a refused session write toasts; a schema without an id no longer fails an open" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end tests on throwaway entities, and the spec

**Files:**
- Create: `e2e/throwaway.ts`, `e2e/inspector.spec.ts`
- Modify: `e2e/studio.ts`, `docs/superpowers/specs/2026-10-05-skp-studio-design.md`

- [ ] **Step 1: Other specs skip throwaway workflows**

In `e2e/studio.ts`, `workflowsWithSteps`: `if (names.has(w.name) || w.name.startsWith('e2e-')) continue;` and say so in its comment.

- [ ] **Step 2: Throwaway entities**

Create `e2e/throwaway.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { expect, test as base, type APIRequestContext } from '@playwright/test';
import type { LiveWorkflow } from './studio';

export { expect };

/** One test run's own entities (spec §9: e2e tests never edit shared data). Names start with `e2e-`. */
export interface Throwaway {
  workflow: LiveWorkflow;
  stepId: string;
  stepName: string;
  processorId: string;
  schemaId: string;
  cacheId: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const label = (name: string, version: string, id: string) => `${name}_${version}-${GUID.test(id) ? id.slice(19).toLowerCase() : id}`;

async function post(request: APIRequestContext, path: string, data: object): Promise<{ id: string }> {
  const r = await request.post(`/api/v1/${path}`, { data });
  expect(r.status(), `POST ${path}: ${await r.text()}`).toBe(201);
  return (await r.json()) as { id: string };
}

/** Creates a schema, a processor using it as its config schema, a step, a cache and a workflow. */
export async function createThrowaway(request: APIRequestContext): Promise<Throwaway> {
  const tag = `e2e-3b-${Date.now().toString(36)}`;
  const schema = await post(request, 'schemas', { name: `${tag}-config`, version: '1.0.0', description: null, definition: '{"type":"object"}' });
  const processor = await post(request, 'processors', {
    name: `${tag}-proc`, version: '1.0.0', description: null, sourceHash: randomBytes(32).toString('hex'), instanceId: null,
    inputSchemaId: null, outputSchemaId: null, configSchemaId: schema.id,
  });
  const stepName = `${tag}-step`;
  const step = await post(request, 'steps', { name: stepName, version: '1.0.0', description: null, processorId: processor.id, nextStepIds: [], entryCondition: 1 });
  const cache = await post(request, 'caches', { name: `${tag}-cache`, version: '1.0.0', description: null, root: `${tag}-root`, items: '{}' });
  const workflow = await post(request, 'workflows', {
    name: tag, version: '1.0.0', description: null, entryStepIds: [step.id], assignmentIds: [], cacheIds: [cache.id], cronExpression: null,
  });
  return {
    workflow: { id: workflow.id, name: tag, version: '1.0.0', label: label(tag, '1.0.0', workflow.id) },
    stepId: step.id, stepName, processorId: processor.id, schemaId: schema.id, cacheId: cache.id,
  };
}

/** Deletes them all, and any assignment made for the step; a missing one is fine. */
export async function removeThrowaway(request: APIRequestContext, t: Throwaway): Promise<void> {
  const del = (path: string) => request.delete(`/api/v1/${path}`);
  await del(`workflows/${t.workflow.id}`);
  const assignments = await request.get('/api/v1/assignments');
  if (assignments.ok()) {
    for (const a of (await assignments.json()) as { id: string; stepId: string }[]) if (a.stepId === t.stepId) await del(`assignments/${a.id}`);
  }
  await del(`steps/${t.stepId}`);
  await del(`processors/${t.processorId}`);
  await del(`schemas/${t.schemaId}`);
  await del(`caches/${t.cacheId}`);
}

/**
 * The page test for writing specs: the browser may write only to this run's entities (a PUT to one of
 * them, or POST /assignments). Every other write fails the test, like the read-only guard elsewhere.
 */
export const allowed = new Set<string>();
export const test = base.extend<{ writeGuard: void }>({
  writeGuard: [async ({ context }, use) => {
    const stray: string[] = [];
    context.on('request', (r) => {
      const url = new URL(r.url());
      if (r.method() === 'GET' || r.method() === 'HEAD') return;
      if (r.method() === 'POST' && /^\/api\/v1\/workflows\/[^/]+\/validate$/.test(url.pathname)) return;
      if (r.method() === 'POST' && url.pathname === '/api/v1/assignments') return;
      const id = url.pathname.split('/').at(-1) ?? '';
      if (r.method() === 'PUT' && allowed.has(id)) return;
      stray.push(`${r.method()} ${url.pathname}`);
    });
    await use();
    expect(stray, 'the browser may only write to this run\'s throwaway entities').toEqual([]);
  }, { auto: true }],
});
```

The test also allows a PUT to an assignment the run created: add its id to `allowed` when the test sees it (read it from the Inspector's "show all" Id row) before saving it.

- [ ] **Step 3: The writing e2e**

Create `e2e/inspector.spec.ts`. In `beforeAll`, `createThrowaway` and add every id to `allowed`; in `afterAll`, `removeThrowaway`. In `beforeEach`, go to `/`, clear `localStorage` and `sessionStorage`, reload. Use `openWorkflow(page, t.workflow)`, `documentPanel`, `inspector` and `tab` from `./studio`. Tests:

1. **Each entity kind saves.**
   - Workflow: click the sphere (`.react-flow__node-workflow`), change Description, Save; `GET /api/v1/workflows/{id}` has it.
   - Step: click the step (`.react-flow__node-step`, position `{ x: 20, y: 12 }`), change Description and Entry condition to `4`, Save; the GET shows both, and `nextStepIds` is unchanged.
   - Processor: click the step's processor (`.chipg`), change Description, Save.
   - Schema: from the processor, click the Config slot; change Description, Save.
   - Cache: click the cache node (`.react-flow__node-cache`), change Items to `{"a":"b"}`, Save.
   - After each Save: "● unsaved changes" is gone, and the tab has no `.dirty`.
2. **A 400 under its field:** on the step, set Version to `abc` and Save. The Version field shows a message, the input has `aria-invalid="true"`, and the value is still `abc`. Revert.
3. **A 409 banner:** on the Config schema, change Definition to `{"type":"string"}` and Save. The banner (`role="alert"`) contains `frozen`, and the text is kept. Revert.
4. **Assignment add, edit, unlink:**
   - On the step, click **＋ Add assignment**, then Create. The kind pill is `ASSIGNMENT`, and `GET /api/v1/workflows/{id}` lists one assignment id.
   - Read the new assignment's id from "▸ show all", add it to `allowed`, change Payload to `{"k":1}`, Save; the GET of the assignment shows it.
   - **Unlink from this workflow**, then Unlink in the dialog. The pill is `STEP`, and the workflow lists no assignment.
5. **Unsaved edits are guarded and survive a refresh:**
   - On the step, type a Description, then click the sphere: the "Unsaved changes" dialog appears. Cancel keeps the text.
   - Reload the page. The Description is still typed, "● unsaved changes" shows, and the tab is `.dirty`.
   - Click the sphere, then Discard. The Inspector shows the workflow.

Every assertion is about the throwaway entities only.

- [ ] **Step 4: Run the e2e**

Run (PowerShell): `npm run e2e`
Expected: every test passes (34 before, plus the new ones). Report any skip with its reason. Afterwards, `GET /api/v1/workflows` holds no `e2e-3b-` workflow.

- [ ] **Step 5: Amend the spec**

In `docs/superpowers/specs/2026-10-05-skp-studio-design.md`, §7.1:
- After "Every save is `PUT /{entity}/{id}` …", add: "Save re-reads the entity (`GET`) immediately before the `PUT`, so structural fields go back exactly as the server holds them at that moment (decided 2026-10-06, plan 3b)."
- After the **Save and Revert** bullet, add: "A document holds at most one Inspector draft: the drill-down trail and the typed fields (§6.1). It is marked by \"● unsaved changes\", the tab's amber dot and an enabled capsule Save, which saves it. After any write every open document re-reads its graph and validate, and every Inspector re-reads its entity; a document that fails to re-read keeps its drawing and a toast says so."

- [ ] **Step 6: Commit**

```bash
git add src/WorkflowStudio/e2e/throwaway.ts src/WorkflowStudio/e2e/inspector.spec.ts src/WorkflowStudio/e2e/studio.ts docs/superpowers/specs/2026-10-05-skp-studio-design.md
git commit -m "test(studio): e2e edits, errors, assignments and the refresh-proof draft on throwaway entities; spec §7.1 amended" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Deploy and check (ask first)

**Ask the user before deploying**: it restarts the `workflow-studio` pod on the shared `desktop` cluster.

- [ ] **Step 1: Deploy (after approval)** — from the repository root (PowerShell):

```powershell
docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
kind load docker-image workflow-studio:local --name desktop
kubectl -n skp rollout restart deploy/workflow-studio
kubectl -n skp rollout status deploy/workflow-studio --timeout=180s
```

Confirm `http://localhost:18081` serves the `assets/index-*.js` that `src/WorkflowStudio/dist/assets` holds (the port-forward can take a few seconds to come back).

- [ ] **Step 2: Check in the browser**

On a throwaway workflow (create one with `createThrowaway`'s calls, or let the user pick one they may edit):

1. Edit a step's Description and Save: the canvas and the hub tooltip update.
2. Type a change, refresh: it comes back marked unsaved.
3. Click elsewhere: Save / Discard / Cancel appears.
4. Drill step → processor → Config schema and back.
5. Add an assignment, then unlink it.

Then open the studio for the user with `Start-Process http://localhost:18081`, and delete the throwaway entities you created.

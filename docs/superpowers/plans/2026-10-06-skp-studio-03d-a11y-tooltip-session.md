# SKP Studio 3d: Accessibility, Step Tooltip and Refresh-Proof Session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three changes the user asked for on 2026-10-06:
1. The accessibility pass the 3a and 3c reviews deferred.
2. A hover tooltip on every step, like the processor's.
3. A page refresh that keeps everything as it was: the open documents, the dock panes, and each blueprint drawing's zoom, scroll position and selection.

**Architecture:**
- The tooltip and the accessibility fixes are local changes to existing components.
- The session is new:
  - `app/session.ts` reads, validates and writes one localStorage entry, `skp.studio.session`, separate from Window › Save's `skp.studio.layout`.
  - It holds the store's documents (id, name, version, selection), the active document, the Inspector's "show all", each document's view, and the dock's layout *with its documents*.
  - The page writes it 300 ms after any change, and at once on `pagehide`.
  - On load, the store starts from it, each document is fetched again, the dock restores its layout instead of the saved window layout, and each canvas opens at its saved view.
  - The dock stays independent of the app: it receives a layout to restore and reports layout snapshots through two new props.

**Tech Stack:** React 19.3, dockview-react 8.4.1, @xyflow/react 12.12, TypeScript, Vitest 5 + Testing Library (jsdom), Playwright e2e against the live BaseApi.

**Spec:** `docs/superpowers/specs/2026-10-05-skp-studio-design.md`.
- §6.1 and §6.2 change. "open documents are not restored on reload" is replaced by the session; Task 7 edits the spec.
- §5.4 is affected: long labels are shortened with a tooltip.

## Decisions this plan makes (please confirm at review)

1. **What a refresh keeps.** These come back exactly as they were:
   - every open document, its tab and dock position, and the active tab;
   - each document's selection, and its zoom and scroll position;
   - the Inspector's "show all";
   - floating and auto-hidden panes, and pane sizes.

   The user said: "the refresh doesn't affect the designer documents, dock panel states or the blueprint drawing", and: "imagine that you work hard and design a workflow without saving, and then you refresh page and everything goes back to first state or discards work".

   **Rule for every later slice: unsaved work survives a refresh.** Today nothing can be edited (the studio is read-only until plan 3b), so there is no draft yet, and each document's graph is fetched again from BaseApi on load. From plan 3b on, every edit not yet saved (an Inspector form, a moved block, a new wire, a layout change) must be kept in this session as that document's draft, written on every change and on `pagehide`. On reload it comes back on top of the fetched graph, marked unsaved, until the user saves or discards it. This plan builds the session so a draft can be added per document without changing its shape for the rest (the version bumps then). Task 7 writes the rule into the spec, so plans 3b and 4 cannot miss it.
2. **A view that still follows Fit stays fitted.** A document the user never zoomed or panned re-fits on load (the window may have changed size). A zoomed or panned one comes back at the exact position.
3. **Pop-out windows come back docked.** A browser will not reopen a window without a click. Pop-out panes return to their dock home, as Window › Apply already does, and pop-out documents return to the document area.
4. **Window › Save / Apply / Reset layout are unchanged.** They still keep one named layout. At startup the session wins; with no session the saved layout applies, and with neither, the default.
5. **A workflow deleted since the refresh** comes back as its tab with "This workflow no longer exists." (the existing failed state). The user closes it.
6. **The step tooltip** is the step's unique name, its entry condition, its assignment and, when parked, a parked note. Hovering the processor panel still shows the processor's own tooltip: the innermost SVG `<title>` wins.
7. **Accessibility scope.** Only the items the reviews deferred:
   - a pane or document's tab ×, and Problems items: reachable and usable by keyboard;
   - menus: focus goes back to where it came from, and Tab closes the menu;
   - Picker: arrow keys choose the item and `aria-selected` follows; the list stays on screen;
   - switcher: headings outside its listboxes;
   - the zoom level: an `<output>`, not a labelled span.

   The disabled Start/Stop tooltips stay for the slice that enables them. Canvas keyboard navigation is not in scope.
8. **Toolbox untouched**, as instructed. `src/panels/PaneNote.tsx` (the Toolbox pane) is not changed. `Problems.tsx` is.

## Global Constraints

- **Location.** The app lives in `src/WorkflowStudio`. Every command runs **from `src/WorkflowStudio`** unless it says otherwise; **commit steps run from the repository root**.
- **Shells.** Run `npm run …` and `npm test` **in PowerShell**: in Git Bash `npm run` prints nothing and exits 1. `npx …` works in either shell.
- **No dependency changes.** `.npmrc` keeps `legacy-peer-deps=true`.
- **Same origin only**, relative `/api/v1/` URLs.
- **Read-only.** Only `GET`s plus the existing validate `POST` dry run. Save, Start and Stop stay disabled. Nothing on the canvas is draggable.
- **Boundaries.**
  - `model/` and `layout/` hold no React and no I/O.
  - **`dock/` imports nothing from `canvas/`, `panels/`, `app/` or `store/`.** The dock's session props carry dock types only.
  - `canvas/` imports nothing from `app/`.
- **Persistence (spec §6.2.2, as amended).**
  - The session lives in `localStorage` under `skp.studio.session`. The named window layout stays under `skp.studio.layout`.
  - Every `localStorage` access is wrapped in try/catch.
  - A session that cannot be read, is not JSON, or has another version is ignored (the page starts as if there were none), never migrated, and never throws.
  - Nothing is stored in the database.
- **Rendering rules (spec §6.3).**
  - Documents keep `renderer: 'always'`.
  - Code inside a panel uses its own document.
  - Overlay z-index values come only from the `--z-*` tokens.
  - The `.docpanel.bg` rule keeps hiding a background document.
- **Plan 2, 3a and 3c keep working.**
  - The selection classes `studio-sel` / `studio-die-sel`.
  - The live art context.
  - The resize behaviour (re-fit until zoomed, then keep the centre).
  - Window › Save/Apply/Reset.
  - Exact re-dock memory.
- **Do not touch the Toolbox:** `src/panels/PaneNote.tsx`, and the Toolbox's entries in `src/dock/ids.ts`.
- **Machine notes.**
  - Windows; the Bash tool is Git Bash. Write files with the Write or Edit tool (heredocs with apostrophes fail).
  - Stage only the files a task names, by name.
  - Never touch `.wf-restore.json`, `tools/simulate-*.py`, `.playwright-mcp/` or `docs/HANDOVER-*.md`.
  - The kind cluster is `desktop`.
- **Commits** end with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (as a second `-m`).
- **Test commands.**
  - `npm test`, `npm run typecheck`, `npm run build`, and focused runs with `npx vitest run <path>`.
  - `npm run e2e` needs BaseApi on `localhost:18080` (`..\..\k8s\port-forward-realstack.ps1 -Status`).
  - A run that collects 0 tests is a failure.
- **Clean output.** A React warning in test output is a defect.

## Review Focus

The failure modes most likely to bite, each pinned by a test in the owning task:

1. **A broken or foreign session never breaks the page.** That covers a session that is not JSON, from another version, with a malformed dock layout or selection, or naming an unknown tool pane. The page must start (with the parts that are valid, or as new) and never throw. Task 4, `app/session.test.ts`.
2. **A dock layout dockview rejects at restore** falls back to the default layout. The restored documents stay open, with a toast. Task 5, `DockShell.test.tsx`.
3. **Closing a document before the refresh** keeps it closed, and its saved view is dropped, so reopening it later fits it afresh. Task 6, `App.test.tsx`.
4. **The last change before a refresh is kept.** A change made less than 300 ms before the page goes away is written on `pagehide`. Task 4 (`createSaver` flush) and Task 6 (`pagehide` wiring).
5. **Two documents' views never mix.** Each document restores its own view, and a document opened fresh after the refresh fits. Task 6, `App.test.tsx`, and Task 7 e2e.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/canvas/toFlow.ts`, `src/canvas/nodes/StepNode.tsx` | The step's `tip` and its `<title>` | 1 |
| `src/dock/parts.tsx` | The tab × reachable and usable by keyboard | 2 |
| `src/panels/Problems.tsx` | Problems items reachable and usable by keyboard | 2 |
| `src/canvas/ZoomControls.tsx` | The zoom level is an `<output>` | 2 |
| `src/dock/Menu.tsx` | Focus restore; Tab closes | 3 |
| `src/dock/Picker.tsx` | Arrow-key highlight, `aria-selected`, `aria-activedescendant`, list on screen | 3 |
| `src/dock/Switcher.tsx` | Headings outside the listboxes | 3 |
| `src/canvas/savedView.ts` (new) | `SavedView` | 4 |
| `src/dock/layoutPersistence.ts` | `parseLayout`, `sessionDock`, a shared `takePopouts` | 4 |
| `src/dock/windowActions.ts` | `captureLayout(…, { keepDocuments })` | 4 |
| `src/app/session.ts` (new) | Session type, read, write, validate, build, restore, saver | 4 |
| `src/dock/DockShell.tsx` | `restore` and `onLayoutChange` props | 5 |
| `src/canvas/WorkflowCanvas.tsx`, `src/app/DocumentPanel.tsx` | `initialView` / `onViewChange` | 6 |
| `src/App.tsx` | Start from the session, re-fetch documents, save on change and on `pagehide` | 6 |
| `e2e/session.spec.ts` (new), `e2e/dock.spec.ts`, `e2e/a11y.spec.ts` (new) | Refresh and keyboard e2e; the old reload test updated | 7 |
| `docs/superpowers/specs/2026-10-05-skp-studio-design.md` | §6.1, §6.2.2 amended | 7 |

---

### Task 1: A tooltip on every step

**Files:**
- Modify: `src/canvas/toFlow.ts`, `src/canvas/nodes/StepNode.tsx`
- Test: `src/canvas/toFlow.test.ts`, `src/canvas/nodes/StepNode.test.tsx`

**Interfaces:**
- Produces: `StepNodeData.tip: string`.

- [ ] **Step 1: Write the failing tests**

In `src/canvas/nodes/StepNode.test.tsx`, add `tip: 'fetch-orders-from-the-api_1.0.0-s1\nentry C · Completed\nassignment ◆ 2 keys',` to the `data` fixture, after `assignment`, and add:

```tsx
  it('shows the step tooltip on the step, and keeps the processor its own', () => {
    const { container } = view();
    expect(container.querySelector('.blk > title')!.textContent).toBe('fetch-orders-from-the-api_1.0.0-s1\nentry C · Completed\nassignment ◆ 2 keys');
    expect(container.querySelector('.chipg > title')!.textContent).toBe('fetcher 2.1.0');
  });
```

In `src/canvas/toFlow.test.ts`, add:

```ts
  it('gives each step a tooltip: unique name, entry condition, assignment, and parked when it is', () => {
    const graph = doc({}, ['p']);
    graph.graph.steps.set('p', step('p', { entryCondition: 4 }));
    const nodes = toFlow(graph, fitter).nodes;
    const tip = (id: string) => (nodes.find((n) => n.id === id)!.data as import('./nodes/StepNode').StepNodeData).tip;

    expect(tip('a')).toBe('a_1.0.0-a\nentry C · Completed\nassignment ◆ 2 keys');
    expect(tip('b')).toBe('b_1.0.0-b\nentry F · Failed\nno assignment');
    expect(tip('p')).toBe('p_1.0.0-p\nentry A · Always\nno assignment\nparked: placed but not wired into this workflow');
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/canvas/toFlow.test.ts src/canvas/nodes/StepNode.test.tsx`
Expected: FAIL (`tip` is undefined; no `.blk > title`).

- [ ] **Step 3: Implement**

In `src/canvas/nodes/StepNode.tsx`, add to `StepNodeData`, after `assignment`:

```ts
  /** The step's tooltip (unique name, entry condition, assignment, parked); the processor panel has its own. */
  tip: string;
```

and make the step's `<title>` the first child of the `.blk` group:

```tsx
    <g className={d.parked ? 'blk nx parked' : 'blk nx'}>
      <title>{d.tip}</title>
```

In `src/canvas/toFlow.ts`, in the step loop, compute the condition once and add `tip` to the data:

```ts
    const condition = conditionInfo(step.entryCondition);
    const assignment = badge(assignments.get(id)?.payload);
```

Use `condition.letter`, `condition.colour` and `assignment` in place of the two `conditionInfo(...)` calls and the `badge(...)` call, and add:

```ts
        tip: [
          entityName(step.name, step.version, step.id),
          `entry ${condition.letter} · ${condition.name}`,
          assignment === null ? 'no assignment' : `assignment ${assignment}`,
          ...(parked.has(id) ? ['parked: placed but not wired into this workflow'] : []),
        ].join('\n'),
```

(`entityName` is already imported in `toFlow.ts` since plan 3c Task 4.)

- [ ] **Step 4: Run them to see them pass; full check; commit**

Run: `npx vitest run src/canvas`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS, no React warnings.

```bash
git add src/WorkflowStudio/src/canvas/toFlow.ts src/WorkflowStudio/src/canvas/toFlow.test.ts src/WorkflowStudio/src/canvas/nodes/StepNode.tsx src/WorkflowStudio/src/canvas/nodes/StepNode.test.tsx
git commit -m "feat(studio): a hover tooltip on every step: unique name, entry condition, assignment, parked" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Keyboard reach for the tab ×, Problems items and the zoom level

**Files:**
- Modify: `src/dock/parts.tsx`, `src/panels/Problems.tsx`, `src/canvas/ZoomControls.tsx`
- Test: `src/dock/DockShell.test.tsx`, `src/panels/panes.test.tsx`, `src/canvas/WorkflowCanvas.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `src/dock/DockShell.test.tsx`, add inside `describe('DockShell', …)`:

```tsx
  it('closes a pane or a document from the keyboard on its tab ×', () => {
    const { props } = setup({ documents: [doc('a')] });
    const close = screen.getByRole('button', { name: 'Close Inspector' });
    expect(close).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(close, { key: 'Enter' });
    expect(screen.queryAllByText('Inspector', { selector: '.doctab .nm' })).toHaveLength(0);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Close wf-a' }), { key: ' ' });
    expect(props.onCloseDocument).toHaveBeenCalledWith('a');
  });
```

In `src/panels/panes.test.tsx`, find the Problems test that clicks a problem to select it. Add beside it a test that does the same from the keyboard: the item is focusable, and Enter selects it. Mirror that test's own setup (store and document fixture):

```tsx
  it('selects a problem from the keyboard: it is focusable and Enter selects its target', () => {
    // same setup as the click test above
    const item = screen.getAllByRole('listitem')[0]!;
    expect(item).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(item, { key: 'Enter' });
    // same expectation as the click test: the store's selection is the problem's target
  });
```

(Copy the click test's setup and its expectation literally, replacing the click with `keyDown` Enter. A problem with no target keeps no tabindex: assert that on a static item if the fixture has one.)

In `src/canvas/WorkflowCanvas.test.tsx`, in `'drives its own React Flow instance …'`, add after `render(...)`:

```tsx
      expect(screen.getByLabelText('Zoom level').tagName).toBe('OUTPUT');
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/dock/DockShell.test.tsx src/panels/panes.test.tsx src/canvas/WorkflowCanvas.test.tsx`
Expected: FAIL (no tabindex, no keyDown handling, the zoom level is a SPAN).

- [ ] **Step 3: Implement**

In `src/dock/parts.tsx`, give the tab's `.x` span keyboard use:

```tsx
      <span
        className="x"
        role="button"
        tabIndex={0}
        aria-label={`Close ${name}`}
        data-tip="Close"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); shell.closePanel(id); }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          shell.closePanel(id);
        }}
      >
```

In `src/panels/Problems.tsx`, give a problem that has a target keyboard use:

```tsx
            <div
              key={i}
              role="listitem"
              className={target === null ? 'prob static' : 'prob'}
              tabIndex={select ? 0 : undefined}
              onClick={select}
              onKeyDown={select ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } } : undefined}
              data-tip={target === null ? undefined : 'Select it'}
            >
```

In `src/canvas/ZoomControls.tsx`, replace the zoom-level span with:

```tsx
      <output aria-label="Zoom level">{`${Math.round(zoom * 100)}%`}</output>
```

In `src/canvas/canvas.css`, change the selector `.zoom span` to `.zoom output` (same declarations).

- [ ] **Step 4: Run them to see them pass; full check; commit**

Run: `npx vitest run src/dock src/panels src/canvas`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS.

```bash
git add src/WorkflowStudio/src/dock/parts.tsx src/WorkflowStudio/src/dock/DockShell.test.tsx src/WorkflowStudio/src/panels/Problems.tsx src/WorkflowStudio/src/panels/panes.test.tsx src/WorkflowStudio/src/canvas/ZoomControls.tsx src/WorkflowStudio/src/canvas/WorkflowCanvas.test.tsx src/WorkflowStudio/src/canvas/canvas.css
git commit -m "fix(studio): tab close buttons and Problems items work from the keyboard; the zoom level is an output" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Menus, the picker and the switcher for keyboard and screen readers

**Files:**
- Modify: `src/dock/Menu.tsx`, `src/dock/Picker.tsx`, `src/dock/Switcher.tsx`
- Test: `src/dock/overlays.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `src/dock/overlays.test.tsx` (it already renders `Menu`, `Picker` and `Switcher`; reuse its imports and helpers), add:

```tsx
describe('keyboard and screen readers (plan 3d)', () => {
  it('a menu gives focus back to where it was when it closes, and Tab closes it', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const anchor = { x: 10, y: 10, doc: document };
    const { unmount } = render(<Menu label="File" anchor={anchor} onClose={onClose} entries={[{ id: 'a', label: 'Open', onSelect: vi.fn() }]} />);
    const item = screen.getByRole('menuitem', { name: /Open/ });
    expect(document.activeElement).toBe(item);

    fireEvent.keyDown(item, { key: 'Tab' });
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('the picker moves its choice with the arrow keys, and Enter opens the chosen one', () => {
    const onPick = vi.fn();
    const items = [{ id: 'a', label: 'alpha', open: false }, { id: 'b', label: 'beta', open: false }, { id: 'c', label: 'gamma', open: false }];
    render(<Picker items={items} anchor={{ x: 10, y: 10, doc: document }} onPick={onPick} onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Search workflows' });
    const selected = () => screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.textContent);

    expect(selected()).toEqual(['alpha']);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selected()).toEqual(['gamma']);
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[2]!.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });              // stops at the last
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(selected()).toEqual(['beta']);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('b');
  });

  it('the picker goes back to the first match when the search changes', () => {
    const items = [{ id: 'a', label: 'alpha', open: false }, { id: 'b', label: 'beta', open: false }];
    render(<Picker items={items} anchor={{ x: 10, y: 10, doc: document }} onPick={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Search workflows' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: 'a' } });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('the picker opens on screen near the bottom edge', () => {
    render(<Picker items={[]} anchor={{ x: 10, y: window.innerHeight - 5, doc: document }} onPick={vi.fn()} onClose={vi.fn()} />);
    const top = parseFloat((screen.getByRole('dialog', { name: 'Open workflow' }) as HTMLElement).style.top);
    expect(top).toBeLessThanOrEqual(window.innerHeight - 360);
  });

  it('the switcher keeps its headings outside its listboxes', () => {
    render(<Switcher entries={[{ id: 'inspector', label: 'Inspector', document: false }, { id: 'doc:a', label: 'a', document: true }]} selected="doc:a" onPick={vi.fn()} />);
    for (const box of screen.getAllByRole('listbox')) {
      expect([...box.children].every((c) => c.getAttribute('role') === 'option')).toBe(true);
    }
    expect(screen.getByRole('listbox', { name: 'Active documents' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/dock/overlays.test.tsx`
Expected: FAIL (no focus restore and no Tab close; aria-selected fixed on the first item; no clamp; headings inside the listboxes).

- [ ] **Step 3: Implement the menu**

In `src/dock/Menu.tsx`, replace the line `useEffect(() => { items()[0]?.focus(); }, []);` with:

```tsx
  // focus the first item on open; on close, give focus back to whatever had it (the trigger)
  useEffect(() => {
    const before = anchor.doc.activeElement as HTMLElement | null;
    items()[0]?.focus();
    return () => { if (before && before.isConnected && typeof before.focus === 'function') before.focus(); };
  }, []);
```

and add a Tab case at the top of `onKeyDown`, before the `list.length` check:

```tsx
    if (e.key === 'Tab') { onClose(); return; }
```

- [ ] **Step 4: Implement the picker**

In `src/dock/Picker.tsx`:
- Add state `const [chosen, setChosen] = useState(0);`.
- Reset it when the search changes: in the input's `onChange`, call `setChosen(0)` after `setQuery(...)`.
- Clamp its index to the list: `const at = Math.min(chosen, Math.max(0, shown.length - 1));`.
- Give each option an id: `const optionId = (i: number) => `${baseId}-o${i}`;` with `const baseId = useId().replace(/[^\w-]/g, '');` (import `useId`).
- In the input's `onKeyDown`, add:

```tsx
          if (e.key === 'ArrowDown') { e.preventDefault(); setChosen(Math.min(at + 1, shown.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setChosen(Math.max(at - 1, 0)); }
```

  and change the Enter case to `if (e.key === 'Enter' && shown[at]) { e.preventDefault(); pick(shown[at].id); }`.
- Give the input `aria-activedescendant={shown.length > 0 ? optionId(at) : undefined}` and `aria-controls={`${baseId}-list`}`.
- Give the listbox `id={`${baseId}-list`}`.
- Each option: `id={optionId(i)}`, `aria-selected={i === at}`, `className={i === at ? 'pk hi' : 'pk'}`.
- Keep the panel on screen: `const top = Math.max(8, Math.min(anchor.y, (view?.innerHeight ?? 800) - 360));` and use `top` in the style instead of `anchor.y`.

- [ ] **Step 5: Implement the switcher**

In `src/dock/Switcher.tsx`, replace the `sw-b` block with:

```tsx
      <div className="sw-b">
        <div>
          <div className="sw-h" aria-hidden="true">Active tool windows</div>
          <div role="listbox" aria-label="Active tool windows">{entries.filter((e) => !e.document).map(row)}</div>
        </div>
        <div>
          <div className="sw-h" aria-hidden="true">Active documents</div>
          <div role="listbox" aria-label="Active documents">{entries.filter((e) => e.document).map(row)}</div>
        </div>
      </div>
```

(The visible heading is decorative; the listbox's own `aria-label` names it for screen readers. Check `dock.css` still styles `.sw-b > div` the same; if a rule targeted `[role=listbox]` directly for the column layout, point it at `.sw-b > div`.)

- [ ] **Step 6: Run them to see them pass; full check; commit**

Run: `npx vitest run src/dock`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS. The existing Esc-order tests in `DockShell.test.tsx` still pass.

```bash
git add src/WorkflowStudio/src/dock/Menu.tsx src/WorkflowStudio/src/dock/Picker.tsx src/WorkflowStudio/src/dock/Switcher.tsx src/WorkflowStudio/src/dock/overlays.test.tsx src/WorkflowStudio/src/dock/dock.css
git commit -m "fix(studio): menus give focus back and close on Tab; the picker follows the arrow keys; switcher headings leave its listboxes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Leave `dock.css` out of `git add` if it did not change.)

---

### Task 4: The session: what is kept, and how it is read and written

**Files:**
- Create: `src/canvas/savedView.ts`
- Modify: `src/dock/layoutPersistence.ts`, `src/dock/windowActions.ts`
- Create: `src/app/session.ts`, `src/app/session.test.ts`
- Test: `src/dock/layoutPersistence.test.ts`, `src/dock/windowActions.test.ts`

**Interfaces:**
- Produces:
  - `interface SavedView { x: number; y: number; zoom: number; followFit: boolean }` (`canvas/savedView.ts`).
  - `parseLayout(value: unknown): SavedLayout | null`; `readLayout` now delegates to it.
  - `sessionDock(layout: SerializedDockview): { dock; documentGroupId; popped: string[][] }` (`dock/layoutPersistence.ts`).
  - `captureLayout(api, memory, hidden, options?: { keepDocuments?: boolean }): SavedLayout` (`dock/windowActions.ts`).
  - From `app/session.ts`:
    - `SESSION_KEY = 'skp.studio.session'`, `SESSION_VERSION = 1`;
    - `interface SessionDoc { workflowId: string; name: string; version: string; selection: Selection | null; view: SavedView | null }`;
    - `interface Session { version: 1; docs: SessionDoc[]; activeId: string | null; showDetails: boolean; dock: SavedLayout | null }`;
    - `readSession(storage: Storage | null): Session | null`;
    - `writeSession(storage: Storage | null, session: Session): boolean`;
    - `sessionOf(state: StudioState, views: ReadonlyMap<string, SavedView>, dock: SavedLayout | null): Session`;
    - `restoredState(session: Session | null): StudioState`;
    - `createSaver(write: () => void, delayMs?: number): { schedule(): void; flush(): void; cancel(): void }`.

- [ ] **Step 1: Write the failing session tests**

Create `src/app/session.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { INITIAL_STATE, type StudioState } from '../store/studioState';
import { createSaver, readSession, restoredState, SESSION_KEY, sessionOf, writeSession, type Session } from './session';

const dock = { version: 1, dock: { grid: { root: { type: 'branch', data: [] }, width: 1200, height: 700, orientation: 'HORIZONTAL' }, panels: {} }, documentGroupId: null, hidden: [], sides: {}, homes: {}, popped: [] };

const good: Session = {
  version: 1,
  docs: [
    { workflowId: 'a', name: 'orders', version: '1.0.0', selection: { kind: 'step', stepId: 's1' }, view: { x: -40, y: 12, zoom: 0.8, followFit: false } },
    { workflowId: 'b', name: 'billing', version: '2.0.0', selection: null, view: null },
  ],
  activeId: 'b',
  showDetails: true,
  dock: dock as Session['dock'],
};

afterEach(() => { vi.useRealTimers(); });

describe('readSession / writeSession', () => {
  it('round-trips a session', () => {
    const storage = memoryStorage();
    expect(writeSession(storage, good)).toBe(true);
    expect(readSession(storage)).toEqual(good);
  });

  // Review focus 1: a broken or foreign session never breaks the page.
  it.each([
    ['nothing stored', undefined],
    ['not JSON', '{oops'],
    ['another version', JSON.stringify({ ...good, version: 2 })],
    ['not an object', '[]'],
  ])('reads %s as no session', (_label, text) => {
    expect(readSession(memoryStorage(text === undefined ? {} : { [SESSION_KEY]: text }))).toBeNull();
  });

  it('keeps the valid parts: a bad document entry, a bad selection, a bad view and a bad dock are dropped, not the session', () => {
    const text = JSON.stringify({
      ...good,
      docs: [good.docs[0], { workflowId: 7 }, { ...good.docs[1], selection: { kind: 'wire' }, view: { x: 'far' } }],
      activeId: 'gone',
      dock: { version: 1, dock: { nonsense: true } },
    });
    const read = readSession(memoryStorage({ [SESSION_KEY]: text }))!;
    expect(read.docs.map((d) => d.workflowId)).toEqual(['a', 'b']);
    expect(read.docs[1]).toEqual({ ...good.docs[1], selection: null, view: null });
    expect(read.activeId).toBe('a');            // an active id that is not open falls back to the first document
    expect(read.dock).toBeNull();
  });

  it('never throws when storage refuses', () => {
    const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(readSession(refusing)).toBeNull();
    expect(writeSession(refusing, good)).toBe(false);
    expect(readSession(null)).toBeNull();
    expect(writeSession(null, good)).toBe(false);
  });
});

describe('sessionOf / restoredState', () => {
  it('keeps each open document with its selection and view, and drops views of closed documents', () => {
    const state: StudioState = {
      ...INITIAL_STATE,
      docs: [{ workflowId: 'a', name: 'orders', version: '1.0.0', status: { kind: 'loading' }, selection: { kind: 'workflow' } }],
      activeId: 'a',
      showDetails: true,
    };
    const views = new Map([['a', { x: 1, y: 2, zoom: 1.5, followFit: false }], ['closed', { x: 9, y: 9, zoom: 9, followFit: false }]]);
    expect(sessionOf(state, views, null)).toEqual({
      version: 1, activeId: 'a', showDetails: true, dock: null,
      docs: [{ workflowId: 'a', name: 'orders', version: '1.0.0', selection: { kind: 'workflow' }, view: { x: 1, y: 2, zoom: 1.5, followFit: false } }],
    });
  });

  it('starts the store from a session: every document loading, with its selection, and the active one', () => {
    const state = restoredState(good);
    expect(state.docs.map((d) => [d.workflowId, d.name, d.status.kind, d.selection])).toEqual([
      ['a', 'orders', 'loading', { kind: 'step', stepId: 's1' }],
      ['b', 'billing', 'loading', null],
    ]);
    expect([state.activeId, state.showDetails]).toEqual(['b', true]);
    expect(restoredState(null)).toBe(INITIAL_STATE);
  });
});

describe('createSaver', () => {
  it('writes once, 300 ms after the last change', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const saver = createSaver(write);
    saver.schedule(); vi.advanceTimersByTime(200); saver.schedule(); vi.advanceTimersByTime(200);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('writes a pending change at once on flush, and nothing when none is pending (review focus 4)', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const saver = createSaver(write);
    saver.flush();
    expect(write).not.toHaveBeenCalled();
    saver.schedule();
    saver.flush();
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
```

In `src/dock/layoutPersistence.test.ts`, add tests for `sessionDock`. Use the file's existing layout fixtures (one with a document in the grid, a floating group and a pop-out group):

```ts
describe('sessionDock', () => {
  it('keeps the documents where they are, drops pop-out windows and returns the panes they held', () => {
    // build `layout` like the stripDocuments fixture: a grid group holding doc:a and doc:b, a tool group,
    // and a pop-out group holding 'inspector' and doc:c
    const { dock, documentGroupId, popped } = sessionDock(layout);
    expect(Object.keys(dock.panels)).toEqual(expect.arrayContaining(['doc:a', 'doc:b']));
    expect(dock.panels['doc:c']).toBeUndefined();          // a popped-out document comes back in the document area
    expect(dock.panels['inspector']).toBeUndefined();
    expect(dock.popoutGroups).toEqual([]);
    expect(popped).toEqual([['inspector']]);
    expect(documentGroupId).toBe(/* the id of the grid group holding doc:a */ 'g1');
  });
});
```

Adapt the fixture-building lines to the file's existing helpers; the assertions are the requirement. Also add `parseLayout` to the existing `readLayout` tests: `parseLayout(JSON.parse(text))` gives the same result as `readLayout` for a valid and an invalid layout.

In `src/dock/windowActions.test.ts`, add a test that `captureLayout(api, memory, [], { keepDocuments: true })` on a dock with an open document keeps that document's panel in `dock.panels`, and that the default call still strips it.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/app/session.test.ts src/dock/layoutPersistence.test.ts src/dock/windowActions.test.ts`
Expected: FAIL (no `session.ts`, no `sessionDock`, no `parseLayout`, no `keepDocuments`).

- [ ] **Step 3: The saved view**

Create `src/canvas/savedView.ts`:

```ts
/**
 * Where a document's view was (the session, spec §6.1): React Flow's viewport, and whether it still
 * followed Fit. A view that follows Fit is fitted again on restore, since the window may have changed.
 */
export interface SavedView {
  x: number;
  y: number;
  zoom: number;
  followFit: boolean;
}
```

- [ ] **Step 4: The dock's session layout**

In `src/dock/layoutPersistence.ts`:
- Split `readLayout`: move everything after `JSON.parse` into `export function parseLayout(value: unknown): SavedLayout | null`. `readLayout` reads the text, parses JSON (null on failure) and returns `parseLayout(value)`.
- Change the comment on `SavedLayout` from "It never holds a document: they are not restored." to "Window › Save keeps no document; the session (app/session.ts) keeps the same shape with its documents."
- Add a shared helper, and use it in `stripDocuments` in place of its pop-out loop and the two lines after it (`for (const views of popped) …` and `dock.popoutGroups = [];`):

```ts
/** Takes the pop-out windows out of a layout copy and returns the tool panes each held; their documents just go. */
function takePopouts(dock: SerializedDockview): string[][] {
  const popped: string[][] = [];
  for (const p of dock.popoutGroups ?? []) {
    const visit = (g: GroupState) => {
      const tools = g.views.filter((v) => !isDocPanelId(v));
      if (tools.length > 0) popped.push(tools);
      for (const v of g.views) delete dock.panels[v];
    };
    if (p.data) visit(p.data);
    if (p.grid) forEachGroup(p.grid.root, visit);
  }
  dock.popoutGroups = [];
  return popped;
}

/**
 * A copy of `toJSON()` for the session: documents stay where they are. Pop-out windows go (a reload
 * cannot reopen a browser window); the tool panes they held are returned so they can be docked on
 * restore, and the documents they held come back in the document area (the page adds every open
 * document the layout does not hold).
 */
export function sessionDock(layout: SerializedDockview): { dock: SerializedDockview; documentGroupId: string | null; popped: string[][] } {
  const dock = JSON.parse(JSON.stringify(layout)) as SerializedDockview;
  let documentGroupId: string | null = null;
  forEachGroup(dock.grid.root, (g) => { if (documentGroupId === null && g.views.some(isDocPanelId)) documentGroupId = g.id; });
  const popped = takePopouts(dock);
  fixRootSize(dock);
  return { dock, documentGroupId, popped };
}
```

In `src/dock/windowActions.ts`, give `captureLayout` an options argument:

```ts
export function captureLayout(api: DockviewApi, memory: DockMemory, hidden: readonly ToolId[], { keepDocuments = false }: { keepDocuments?: boolean } = {}): SavedLayout {
  const { dock, documentGroupId, popped: poppedGroups } = (keepDocuments ? sessionDock : stripDocuments)(api.toJSON());
```

The rest is unchanged. Import `sessionDock`. Update the doc comment: with `keepDocuments` it is the session's snapshot.

- [ ] **Step 5: The session module**

Create `src/app/session.ts`:

```ts
import type { SavedView } from '../canvas/savedView';
import { parseLayout, type SavedLayout } from '../dock/layoutPersistence';
import type { Selection } from '../store/selection';
import { INITIAL_STATE, type StudioState } from '../store/studioState';

/**
 * The page as the user left it (spec §6.1, amended 2026-10-06): a refresh keeps the open documents,
 * the dock and each document's selection and view. One localStorage entry, separate from Window ›
 * Save's named layout. Documents are fetched again on load: only where things were is kept.
 */
export const SESSION_KEY = 'skp.studio.session';
export const SESSION_VERSION = 1;

export interface SessionDoc {
  workflowId: string;
  name: string;
  version: string;
  selection: Selection | null;
  /** null: the view still followed Fit, or was never reported; the document is fitted on restore. */
  view: SavedView | null;
}

export interface Session {
  version: typeof SESSION_VERSION;
  docs: SessionDoc[];
  activeId: string | null;
  showDetails: boolean;
  /** The dock with its documents (`captureLayout(…, { keepDocuments: true })`); null: the page's default. */
  dock: SavedLayout | null;
}

export function readSession(storage: Storage | null): Session | null {
  let text: string | null;
  try {
    text = storage?.getItem(SESSION_KEY) ?? null;
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
  if (!isRecord(value) || value.version !== SESSION_VERSION) return null;
  const docs: SessionDoc[] = [];
  for (const d of Array.isArray(value.docs) ? value.docs : []) {
    if (!isRecord(d) || typeof d.workflowId !== 'string' || typeof d.name !== 'string' || typeof d.version !== 'string') continue;
    if (docs.some((x) => x.workflowId === d.workflowId)) continue;
    docs.push({
      workflowId: d.workflowId, name: d.name, version: d.version,
      selection: isSelection(d.selection) ? d.selection : null,
      view: isView(d.view) ? d.view : null,
    });
  }
  const activeId = typeof value.activeId === 'string' && docs.some((d) => d.workflowId === value.activeId)
    ? value.activeId : docs[0]?.workflowId ?? null;
  return { version: SESSION_VERSION, docs, activeId, showDetails: value.showDetails === true, dock: parseLayout(value.dock) };
}

/** False when the browser refuses (quota, blocked storage); never throws. */
export function writeSession(storage: Storage | null, session: Session): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

/** The session for the current state: views of documents that are no longer open are dropped. */
export function sessionOf(state: StudioState, views: ReadonlyMap<string, SavedView>, dock: SavedLayout | null): Session {
  return {
    version: SESSION_VERSION,
    docs: state.docs.map((d) => ({ workflowId: d.workflowId, name: d.name, version: d.version, selection: d.selection, view: views.get(d.workflowId) ?? null })),
    activeId: state.activeId,
    showDetails: state.showDetails,
    dock,
  };
}

/** The store's first state: every document from the session, loading again, with its selection. */
export function restoredState(session: Session | null): StudioState {
  if (session === null) return INITIAL_STATE;
  return {
    docs: session.docs.map((d) => ({ workflowId: d.workflowId, name: d.name, version: d.version, status: { kind: 'loading' }, selection: d.selection })),
    activeId: session.activeId,
    showDetails: session.showDetails,
  };
}

/** Coalesces writes: `schedule` writes 300 ms after the last call; `flush` writes a pending one now. */
export function createSaver(write: () => void, delayMs = 300): { schedule(): void; flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  return {
    schedule() { cancel(); timer = setTimeout(() => { timer = undefined; write(); }, delayMs); },
    flush() { if (timer === undefined) return; cancel(); write(); },
    cancel,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSelection(value: unknown): value is Selection {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'workflow': return true;
    case 'step': return typeof value.stepId === 'string';
    case 'processor': return typeof value.processorId === 'string' && typeof value.stepId === 'string';
    case 'cache': return typeof value.cacheId === 'string';
    default: return false;
  }
}

function isView(value: unknown): value is SavedView {
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  return isRecord(value) && finite(value.x) && finite(value.y) && finite(value.zoom) && (value.zoom as number) > 0 && typeof value.followFit === 'boolean';
}
```

- [ ] **Step 6: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src/app src/dock`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS. Every existing `stripDocuments` / `captureLayout` / `readLayout` test still passes.

```bash
git add src/WorkflowStudio/src/canvas/savedView.ts src/WorkflowStudio/src/dock/layoutPersistence.ts src/WorkflowStudio/src/dock/layoutPersistence.test.ts src/WorkflowStudio/src/dock/windowActions.ts src/WorkflowStudio/src/dock/windowActions.test.ts src/WorkflowStudio/src/app/session.ts src/WorkflowStudio/src/app/session.test.ts
git commit -m "feat(studio): the page session: documents, selections, views and the dock, read and written defensively" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The dock restores the session's layout and reports its own

**Files:**
- Modify: `src/dock/DockShell.tsx`
- Test: `src/dock/DockShell.test.tsx`

**Interfaces:**
- Consumes: `captureLayout(…, { keepDocuments: true })`, `SavedLayout`, `applyLayout`.
- Produces: two `DockShellProps`: `restore?: SavedLayout | null` and `onLayoutChange?: (dock: SavedLayout) => void`.

- [ ] **Step 1: Write the failing tests**

In `src/dock/DockShell.test.tsx`, add:

```tsx
describe('session (plan 3d)', () => {
  it('reports its layout, documents included, when it changes, and restores it at startup in place of the saved layout', () => {
    const onLayoutChange = vi.fn();
    const storage = memoryStorage();
    const { update } = setup({ documents: [doc('a'), doc('b')], activeDocumentId: 'b', onLayoutChange, storage });
    // change the layout: auto-hide Problems from its tab menu
    fireEvent.contextMenu(tab('Problems'));
    choose(/Auto hide/);
    const last = onLayoutChange.mock.calls.at(-1)![0] as import('./layoutPersistence').SavedLayout;
    expect(Object.keys(last.dock.panels)).toEqual(expect.arrayContaining(['doc:a', 'doc:b']));
    expect(last.hidden).toContain('problems');
    update({}); // keep the rendered shell; a fresh one below restores `last`

    cleanup();
    // a saved window layout that differs: the session must win at startup
    setup({ documents: [doc('a'), doc('b')], activeDocumentId: 'b', restore: last, storage: memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ ...last, hidden: [] }) }) });
    expect(railTab('problems')).not.toBeNull();
    expect(screen.getAllByText('wf-a', { selector: '.doctab .nm' })).toHaveLength(1);
    expect(screen.getAllByText('wf-b', { selector: '.doctab .nm' })).toHaveLength(1);
  });

  it('falls back to the default layout when dockview rejects the restored layout, keeping the documents (review focus 2)', () => {
    expectingDockviewRejection(() => {
      setup({ documents: [doc('a')], restore: { ...JSON.parse(REJECTED_BY_DOCKVIEW), documentGroupId: null, hidden: [], sides: {}, homes: {}, popped: [] } });
    });
    expect(toast()).toHaveTextContent(/default layout/);
    expect(screen.getAllByText('wf-a', { selector: '.doctab .nm' })).toHaveLength(1);
  });

  it('without a session, still applies the saved window layout at startup', () => {
    // the existing startup test for LAYOUT_KEY keeps passing with restore omitted (no change needed); this one pins restore: null
    const storage = memoryStorage();
    setup({ storage, restore: null });
    expect(tab('Inspector')).toBeInTheDocument();
  });
});
```

Import `cleanup` from `@testing-library/react` if the file does not already. `REJECTED_BY_DOCKVIEW` and `expectingDockviewRejection` already exist in this file. If `REJECTED_BY_DOCKVIEW` is a full `SavedLayout` JSON, pass `JSON.parse(REJECTED_BY_DOCKVIEW)` directly.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/dock/DockShell.test.tsx`
Expected: FAIL (no `restore` or `onLayoutChange` props).

- [ ] **Step 3: Implement**

In `src/dock/DockShell.tsx`:
- Add to `DockShellProps`, after `storage`:

```ts
  /** The dock as the page left it (the session, spec §6.1): restored at startup in place of the saved window layout. */
  restore?: SavedLayout | null;
  /** Called with the dock's state, documents included, whenever it changes: the page keeps it in its session. */
  onLayoutChange?: (dock: SavedLayout) => void;
```

  (Import `type SavedLayout` from `./layoutPersistence`.)
- In `apply`, read the session's layout first at startup:

```ts
    const restore = atStartup ? latest.current.props.restore ?? null : null;
    const saved = restore ?? readLayout(storage);
```

  The catch branch already resets and toasts. Keep it.
- Add a snapshot callback after `apply`:

```ts
  /** Hands the page the dock's current state for its session; never while a layout is being applied. */
  const report = useCallback((dv: DockviewApi) => {
    const onLayoutChange = latest.current.props.onLayoutChange;
    if (!onLayoutChange || applying.current) return;
    onLayoutChange(captureLayout(dv, memory, latest.current.hidden, { keepDocuments: true }));
  }, [memory]);
```

- In `onReady`, change the layout-change subscription to `dv.onDidLayoutChange(() => { markDocumentArea(dv, memory); report(dv); });`, and add `report` to `onReady`'s dependency list.
- Report when the rails change (auto-hide state lives in React state, not in dockview's layout):

```ts
  useEffect(() => { if (api) report(api); }, [api, hidden, report]);
```

- [ ] **Step 4: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src/dock`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS, including every existing DockShell test.

```bash
git add src/WorkflowStudio/src/dock/DockShell.tsx src/WorkflowStudio/src/dock/DockShell.test.tsx
git commit -m "feat(studio): the dock restores the session's layout at startup and reports its own as it changes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The page keeps its session, and each canvas its view

**Files:**
- Modify: `src/canvas/WorkflowCanvas.tsx`, `src/app/DocumentPanel.tsx`, `src/App.tsx`
- Test: `src/canvas/WorkflowCanvas.test.tsx`, `src/App.test.tsx`

**Interfaces:**
- Consumes: everything Task 4 produced; DockShell's `restore` and `onLayoutChange`.
- Produces: `WorkflowCanvas` props `initialView?: SavedView | null` and `onViewChange?: (view: SavedView) => void`; `DocumentPanel` passes both through.

- [ ] **Step 1: Write the failing canvas tests**

In `src/canvas/WorkflowCanvas.test.tsx`, add inside `describe('selection (slice 3a)', …)`:

```tsx
    it('opens at a saved view that no longer followed Fit, and reports the view when it settles', async () => {
      const onViewChange = vi.fn();
      const { container } = render(
        <WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800}
          initialView={{ x: -100, y: 40, zoom: 1.5, followFit: false }} onViewChange={onViewChange}>
          <ZoomControls />
        </WorkflowCanvas>,
      );
      await waitFor(() => expect(screen.getByLabelText('Zoom level')).toHaveTextContent('150%'));
      expect((container.querySelector('.react-flow__viewport') as HTMLElement).style.transform).toBe('translate(-100px, 40px) scale(1.5)');

      fireEvent.click(screen.getByLabelText('Zoom in'));
      await waitFor(() => expect(onViewChange).toHaveBeenCalled());
      const last = onViewChange.mock.calls.at(-1)![0];
      expect(last.zoom).toBeGreaterThan(1.5);
      expect(last.followFit).toBe(false);
    });

    it('fits a document whose saved view still followed Fit', async () => {
      render(
        <WorkflowCanvas doc={await twoSteps()} fitter={fitter} width={1200} height={800} initialView={{ x: -100, y: 40, zoom: 1.5, followFit: true }}>
          <ZoomControls />
        </WorkflowCanvas>,
      );
      await waitFor(() => expect(screen.getByLabelText('Zoom level')).not.toHaveTextContent('150%'));
    });
```

- [ ] **Step 2: Write the failing page tests**

In `src/App.test.tsx`, reuse its existing api fake (it answers `listWorkflows`, `getGraph`, `validate`, `listLive` and `listLiveness`) and add:

```tsx
describe('session (plan 3d)', () => {
  const seeded = (session: unknown) => memoryStorage({ [SESSION_KEY]: JSON.stringify(session) });

  it('brings back the open documents, the active one and each selection after a reload', async () => {
    const storage = seeded({
      version: 1, activeId: 'wf2', showDetails: false, dock: null,
      docs: [
        { workflowId: 'wf1', name: 'orders', version: '1.0.0', selection: { kind: 'workflow' }, view: null },
        { workflowId: 'wf2', name: 'billing', version: '2.0.0', selection: null, view: null },
      ],
    });
    render(<App api={api} storage={storage} />);
    expect(await screen.findAllByText('orders', { selector: '.doctab .nm' })).toHaveLength(1);
    expect(screen.getAllByText('billing', { selector: '.doctab .nm' })).toHaveLength(1);
    await waitFor(() => expect(api.getGraph).toHaveBeenCalledWith('wf1'));
    expect(api.getGraph).toHaveBeenCalledWith('wf2');
  });

  it('keeps a document closed before the reload closed, and forgets its view (review focus 3)', async () => {
    const storage = memoryStorage();
    const { unmount } = render(<App api={api} storage={storage} />);
    // open wf1 through the picker, close it, then let the saver write
    // (use the file's existing open helper; then click "Close <name>" on its tab)
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    const saved = JSON.parse(storage.getItem(SESSION_KEY)!);
    expect(saved.docs).toEqual([]);
    unmount();
  });

  it('writes the session at once when the page goes away (review focus 4)', async () => {
    const storage = memoryStorage();
    render(<App api={api} storage={storage} />);
    // open a workflow with the file's existing helper, then fire pagehide before 300 ms pass
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(JSON.parse(storage.getItem(SESSION_KEY)!).docs).toHaveLength(1);
  });

  it('starts as new when the stored session is broken (review focus 1)', () => {
    render(<App api={api} storage={memoryStorage({ [SESSION_KEY]: '{oops' })} />);
    expect(screen.getByText('No workflow open')).toBeInTheDocument();
  });
});
```

Fill in the "open a workflow" steps with the same picker interaction the file's existing tests use; the assertions are the requirement. Make `api.getGraph` a `vi.fn` if it is not already. Import `SESSION_KEY` from `./app/session`, `memoryStorage` from `./test/memoryStorage`, and `act` and `waitFor` from Testing Library.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/canvas/WorkflowCanvas.test.tsx src/App.test.tsx`
Expected: FAIL (no `initialView`, no session).

- [ ] **Step 4: The canvas keeps its view**

In `src/canvas/WorkflowCanvas.tsx`:
- Import `type SavedView` from `./savedView`.
- Add to `Props`:

```ts
  /** Where the view was when the page was left (the session); null, omitted, or still following Fit: fit the workflow. */
  initialView?: SavedView | null;
  /** Called when the view settles after a zoom, pan, fit or resize, for the session. */
  onViewChange?: (view: SavedView) => void;
```

- Destructure both, then:

```tsx
  const restored = initialView && !initialView.followFit ? initialView : null;
  const followFit = useRef(restored === null);
```

  (This replaces `const followFit = useRef(true);`.)
- On `<ReactFlow>`, replace `fitView` with `fitView={restored === null}`, and add:

```tsx
            defaultViewport={restored ? { x: restored.x, y: restored.y, zoom: restored.zoom } : undefined}
            onMoveEnd={onViewChange ? (_event, v) => onViewChange({ x: v.x, y: v.y, zoom: v.zoom, followFit: followFit.current }) : undefined}
```

In `src/app/DocumentPanel.tsx`, add `initialView?: SavedView | null` and `onViewChange?: (view: SavedView) => void` to the props, and pass both to `<WorkflowCanvas …>`.

- [ ] **Step 5: The page keeps its session**

In `src/App.tsx`:

```tsx
import { browserStorage } from './dock/layoutPersistence';
import type { SavedLayout } from './dock/layoutPersistence';
import type { SavedView } from './canvas/savedView';
import { createSaver, readSession, restoredState, sessionOf, writeSession, type Session } from './app/session';
```

In `App`, resolve the storage once, read the session once, and start the store from it:

```tsx
  const resolved = useMemo(() => (storage === undefined ? browserStorage() : storage), [storage]);
  const session = useMemo(() => readSession(resolved), [resolved]);
  const store = useMemo(() => createStudioStore(restoredState(session)), []);
```

…and pass `storage={resolved} session={session}` to `<Studio>`. In `Studio` (props `{ api, storage, session }`):
- Split `openWorkflow`'s fetch into `load(id)`. `openWorkflow` dispatches `open` and calls `load(id)` unless the workflow is already open.
- Fetch every restored document once, on mount:

```tsx
  useEffect(() => {
    for (const d of store.getState().docs) if (d.status.kind === 'loading') load(d.workflowId);
  }, []); // the restored documents only; later ones are loaded by openWorkflow
```

- Views and the dock snapshot, kept outside React state (they change on every pan and drag):

```tsx
  const views = useRef(new Map<string, SavedView>(session?.docs.flatMap((d) => (d.view ? [[d.workflowId, d.view] as const] : [])) ?? []));
  const dockState = useRef<SavedLayout | null>(session?.dock ?? null);
  const saver = useMemo(() => createSaver(() => {
    const state = store.getState();
    for (const id of [...views.current.keys()]) if (!state.docs.some((d) => d.workflowId === id)) views.current.delete(id);
    writeSession(storage, sessionOf(state, views.current, dockState.current));
  }), [store, storage]);
  useEffect(() => store.subscribe(saver.schedule), [store, saver]);
  useEffect(() => {
    const flush = () => saver.flush();
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); saver.flush(); };
  }, [saver]);
```

- Pass to `<DockShell>`: `restore={session?.dock ?? null}` and `onLayoutChange={(dock) => { dockState.current = dock; saver.schedule(); }}`.
- In `renderDocument`:

```tsx
      renderDocument={(id, panel) => (
        <DocumentPanel api={api} workflowId={id} panel={panel}
          initialView={views.current.get(id) ?? null}
          onViewChange={(v) => { views.current.set(id, v); saver.schedule(); }} />
      )}
```

- `onCloseDocument`: also `views.current.delete(id)` before dispatching `close`, so a document reopened later fits afresh.

Update the comment on `StudioState` in `src/store/studioState.ts`: "Open documents are not restored on reload (spec §6.1), so none of this is persisted." becomes "The page keeps it in its session (app/session.ts), so a refresh brings it back (spec §6.1)."

- [ ] **Step 6: Run the tests to see them pass; full check; commit**

Run: `npx vitest run src`, then (PowerShell) `npm test; npm run typecheck; npm run build`.
Expected: PASS, no React warnings. Watch for `act(...)` warnings from the saver's timer in App tests: flush or advance timers inside `act`.

```bash
git add src/WorkflowStudio/src/canvas/WorkflowCanvas.tsx src/WorkflowStudio/src/canvas/WorkflowCanvas.test.tsx src/WorkflowStudio/src/app/DocumentPanel.tsx src/WorkflowStudio/src/App.tsx src/WorkflowStudio/src/App.test.tsx src/WorkflowStudio/src/store/studioState.ts
git commit -m "feat(studio): a refresh keeps the open documents, their selection and view, and the dock" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end tests and the spec

**Files:**
- Create: `e2e/session.spec.ts`, `e2e/a11y.spec.ts`
- Modify: `e2e/dock.spec.ts` (the reload test), `docs/superpowers/specs/2026-10-05-skp-studio-design.md`

- [ ] **Step 1: The refresh e2e**

Create `e2e/session.spec.ts`:

```ts
import { documentPanel, expect, inspector, liveWorkflows, openWorkflow, tab, test, type LiveWorkflow } from './studio';

// Spec §6.1 (amended 2026-10-06): a refresh keeps the documents, the dock and each drawing's view. Read-only.
let workflows: LiveWorkflow[];
test.beforeAll(async ({ request }) => { workflows = await liveWorkflows(request, 2); });
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('a refresh brings back the open workflows, the active tab, each selection and view, and the panes', async ({ page }) => {
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  await documentPanel(page, a!).locator('.react-flow__node-step').first().click({ position: { x: 20, y: 12 } });
  await expect(inspector(page).locator('.kindpill')).toHaveText(/STEP/);
  await openWorkflow(page, b!);
  const panelB = documentPanel(page, b!);
  await panelB.getByRole('button', { name: 'Zoom in' }).click();
  await panelB.getByRole('button', { name: 'Zoom in' }).click();
  const zoom = await panelB.getByLabel('Zoom level').textContent();
  const transform = await panelB.locator('.react-flow__viewport').getAttribute('style');
  await tab(page, 'Problems').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Auto hide/ }).click();
  await expect(page.locator('[data-rt="problems"]')).toBeVisible();

  await page.reload();

  await expect(documentPanel(page, b!).locator('.react-flow__node').first()).toBeVisible();
  await expect(tab(page, a!.name)).toBeVisible();
  await expect(page.locator('.dv-tab.dv-active-tab').filter({ has: tab(page, b!.name) })).toHaveCount(1);
  await expect(documentPanel(page, b!).getByLabel('Zoom level')).toHaveText(zoom!);
  expect(await documentPanel(page, b!).locator('.react-flow__viewport').getAttribute('style')).toBe(transform);
  await expect(page.locator('[data-rt="problems"]')).toBeVisible();

  await tab(page, a!.name).click();
  await expect(documentPanel(page, a!).locator('.react-flow__node-step.studio-sel')).toHaveCount(1);
  await expect(inspector(page).locator('.kindpill')).toHaveText(/STEP/);
});

test('a workflow closed before the refresh stays closed', async ({ page }) => {
  const [a, b] = workflows;
  await openWorkflow(page, a!);
  await openWorkflow(page, b!);
  await tab(page, a!.name).getByRole('button', { name: `Close ${a!.name}` }).click();

  await page.reload();

  await expect(documentPanel(page, b!).locator('.react-flow__node').first()).toBeVisible();
  await expect(tab(page, a!.name)).toHaveCount(0);
});
```

- [ ] **Step 2: The old reload test now expects the documents back**

In `e2e/dock.spec.ts`, replace the test `'a saved window layout comes back after a reload, without the documents'` with:

```ts
test('Window › Apply brings back the saved layout after a refresh changed nothing else', async ({ page }) => {
  await openWorkflow(page, workflows[0]!);
  await tab(page, 'Output').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Auto hide/ }).click();
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Save window layout/ }).click();
  await expect(page.locator('.toast')).toHaveText('Window layout saved in this browser');
  await page.locator('[data-rt="output"]').click();
  await page.locator('.fly').getByRole('button', { name: /Dock/ }).click();
  await expect(page.locator('[data-rt="output"]')).toHaveCount(0);

  await page.reload();

  // the refresh keeps the page as it was: the document is back, Output docked
  await expect(documentPanel(page, workflows[0]!).locator('.react-flow__node').first()).toBeVisible();
  await expect(page.locator('[data-rt="output"]')).toHaveCount(0);
  // the saved layout is still there for Apply, and Apply keeps the document
  await page.getByRole('menuitem', { name: 'Window' }).click();
  await page.getByRole('menuitem', { name: /Apply saved window layout/ }).click();
  await expect(page.locator('[data-rt="output"]')).toBeVisible();
  await expect(documentPanel(page, workflows[0]!)).toHaveCount(1);
});
```

(Match the Window menu's labels to the ones `DockShell` uses: read `windowMenu`/`stripEntries` in `DockShell.tsx` for the exact Apply label. Check whether the next test, the popped-out pane after reload, still holds with the session. A popped-out pane at refresh time comes back docked through the session, as decision 3 says. Adjust its wording if its title claims "saved layout", but keep its assertions.)

- [ ] **Step 3: Keyboard e2e**

Create `e2e/a11y.spec.ts`:

```ts
import { documentPanel, expect, inspector, liveWorkflows, openWorkflow, tab, test } from './studio';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('a pane closes from the keyboard on its tab ×', async ({ page }) => {
  const close = tab(page, 'Output').getByRole('button', { name: 'Close Output' });
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(tab(page, 'Output')).toHaveCount(0);
});

test('a menu gives focus back to its button when Escape closes it', async ({ page }) => {
  const file = page.getByRole('menuitem', { name: 'File' });
  await file.click();
  await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(file).toBeFocused();
});

test('the picker opens the workflow chosen with the arrow keys', async ({ page, request }) => {
  const [first, second] = await liveWorkflows(request, 2);
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /Open workflow/ }).click();
  const box = page.getByRole('textbox', { name: 'Search workflows' });
  await expect(page.getByRole('listbox', { name: 'Workflows' }).getByText(first!.label, { exact: true })).toBeVisible();
  const labels = await page.getByRole('option').allTextContents();
  const index = labels.findIndex((l) => l.startsWith(second!.label));
  for (let i = 0; i < index; i++) await box.press('ArrowDown');
  await box.press('Enter');
  await expect(documentPanel(page, second!).locator('.react-flow__node').first()).toBeVisible();
  void inspector;
});
```

(If the menu-strip's Escape is handled by DockShell's own Esc order, closing through the shell rather than the Menu, the focus restore still comes from Menu's unmount cleanup. The test pins it from the user's side.)

- [ ] **Step 4: Run the e2e**

Run (PowerShell): `npm run e2e`
Expected: every test passes (27 before, plus 2 session, plus 3 keyboard, with the reload test replaced: 32). Report any skip with its reason.

- [ ] **Step 5: Amend the spec**

In `docs/superpowers/specs/2026-10-05-skp-studio-design.md`:
- §6.1, last bullet: replace "The window layout persists; **open documents are not restored on reload**." with: "**A refresh keeps the page as it was** (user decision 2026-10-06): the open documents (fetched again), the active tab, each document's selection and view (zoom and scroll; a view still following Fit is fitted again), the dock with floating and auto-hidden panes, and the Inspector's show-all. Pop-out windows come back docked. It is one per-browser `localStorage` session (`skp.studio.session`), never the database. **Unsaved work is never lost to a refresh:** from slice 3b on, every edit not yet saved is kept in the session as its document's draft (written on every change and on `pagehide`) and comes back on reload, marked unsaved, until it is saved or discarded."
- §10, slices 3b and 4: append to each "Its unsaved edits are kept in the session as the document's draft and survive a refresh (§6.1)."
- §6.2 item 2: append "At startup the session (§6.1) wins over the saved layout; Apply still brings the saved one back, keeping the open documents."

- [ ] **Step 6: Commit**

```bash
git add src/WorkflowStudio/e2e/session.spec.ts src/WorkflowStudio/e2e/a11y.spec.ts src/WorkflowStudio/e2e/dock.spec.ts docs/superpowers/specs/2026-10-05-skp-studio-design.md
git commit -m "test(studio): e2e for the refresh-proof session and keyboard use; spec §6.1 and §6.2 amended" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Deploy and check (ask first)

**Ask the user before deploying**: it restarts the `workflow-studio` pod on the shared `desktop` cluster.

- [ ] **Step 1: Deploy (after approval)** — from the repository root (PowerShell):

```powershell
docker build -f src/WorkflowStudio/Dockerfile -t workflow-studio:local .
kind load docker-image workflow-studio:local --name desktop
kubectl -n skp rollout restart deploy/workflow-studio
kubectl -n skp rollout status deploy/workflow-studio --timeout=180s
```

Confirm `http://localhost:18081` serves the `assets/index-*.js` that `src/WorkflowStudio/dist/assets` holds.

- [ ] **Step 2: Check in the browser**

1. Open two workflows. Zoom and pan one, select a step in the other, float or auto-hide a pane.
2. Press F5 (the studio shows a toast for F5 inside the page; use the browser's reload button or Ctrl+R if F5 is captured).
3. Everything must come back as it was.
4. Hover a step: its tooltip shows. Hover its processor: the processor's tooltip shows.
5. Tab through a menu and the picker.

Then open the studio for the user with `Start-Process http://localhost:18081`.

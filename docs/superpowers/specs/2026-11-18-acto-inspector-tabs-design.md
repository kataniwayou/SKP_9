# Acto — Inspector tabs, React Flow look, running wires, ghosts (design)

Amends `2026-11-18-acto-triangles-design.md` (the triangles spec). Where they differ, this one wins. Everything the
triangles spec says and this one does not touch stays as it is — the database rules, Save, Take stored, delete, chat.

Mockups the user approved (2026-11-18, visual companion, `.superpowers/brainstorm/1305-1794971489/content/`):
`inspector-tabs-v4.html` (scenes 1–4; style option **B** picked) and `scene4-ghosts-v2.html` (ghosts; stopped style
**S1** picked). Marks: [user] = the user said it; [call] = my decision, open to change.

## 1. Intent

Make the Inspector read like WorkflowStudio's (all of an entity's metadata, readable JSON, Studio's entry-condition
picker), split it into tabs that follow what was clicked, let several workflows be compared on a shared step, show
motion only where something runs, and keep deleted things visible as ghosts until the page is reloaded. Look and
wiring follow React Flow's own examples (reactflow.dev): its xy-theme defaults and its "React Flow UI" BaseNode and
NodeStatusIndicator components [user].

## 2. Look (React Flow) [user: "embrace the style"; B]

- **Step card = React Flow UI BaseNode** [user: B]: white card, 8px radius, 1px `#D4D4D8` border, soft shadow; a
  header row (processor colour square + processor name, the entry-condition letter pill at the right) over a
  border-bottom; the body is the step name. Handles: React Flow's default — dark `#1A192B` circle, white ring, left
  (in) and right (out). Unsaved / failed / selected marks stay, drawn on this card.
- **Status ring = NodeStatusIndicator**: a step that a **running** workflow reaches gets a green (`#22C55E`) ring
  around the card. No ring otherwise.
- **Triangle, running**: white triangle, ink outline, a green ▶ inside, a green spinning dashed ring around it
  (NodeStatusIndicator's "loading" border), "● running" under the name in green.
- **Triangle, stopped = S1** [user]: slate-tinted fill `#F1F3F7`, slate outline `#64748B`, a slate ■ inside, a slate
  pill "■ stopped" under the name. Unknown state (before the first live read): S1 shape with "checking…" [call].
- **Cache block**: same card look as a step (8px radius, border, shadow), "⛁ name".
- Board: React Flow `<Background variant="dots">`, `<Controls>`, `<MiniMap>` with xy-theme colours (ink `#1A192B`,
  dots `#91919A`, accent `#FF0072`). Toolbars are React Flow `<NodeToolbar>` with the xy-theme button look.

## 3. Wires and motion [user: "dash movement only on running workflow"]

- Wire colour/letter/arrowhead: unchanged (the target step's entry condition) [call: kept, user did not object].
- A **wire's dashes move** (React Flow's `animated` edge) only when a running workflow reaches it: some running
  workflow reaches its source step and its target step through it [call: a wire into a shared step moves if *any*
  running workflow reaches it]. Every other wire is solid and still.
- An **entry arrow** moves only while its triangle runs. **Cache lines** never move (dashed, still).

## 4. Selection [user: items 3, 4]

- **Click a triangle** → it is the selected workflow; the Inspector shows its Workflow tab. Its stream is marked —
  **nothing on the board fades any more** [user: faded is for deleted only]: the selected triangle, its tip arrows
  and its key chips carry its colour.
- **Key chips**: every step in a selected workflow's stream that has an assignment of that workflow shows a chip
  under the card: "◆ N keys" (N = top-level keys of the payload JSON; "◆ payload" when it is not an object) [user:
  "the keys in workflow's steps will appear"].
- **Ctrl+click another triangle** adds it to the selected workflows (Ctrl+click again removes it) [user: item 4 —
  lifts the old "no multi-select of triangles" rule]. Each selected workflow gets its own colour from a fixed palette
  (pink `#FF0072`, purple `#7C3AED`, then teal, amber, blue, …) for its triangle, arrows, chips and tab dot [call].
  With several selected, a step shows one chip per workflow ("◆ 2 keys · daily").
- **Click a step** keeps the selected workflows (plain click on a step does not clear them); clicking empty board
  clears everything (unchanged). A plain click on a triangle makes it the only selected workflow.
- **Multi-select of steps, wires, caches and ghosts**: Ctrl+click as today, light bar + numbered badges [user: ghosts
  too]. The bar shows the actions common to everything picked. With 2+ triangles selected and nothing else picked,
  the bar shows **Start · Stop · Delete** for all of them (Delete confirms once, listing every workflow) [call].

## 5. Inspector — tabs [user: items 1–4]

The Inspector shows tabs; the first one opens on a new click, the chosen tab is kept while the same item stays picked.

| What is picked | Tabs |
|---|---|
| a triangle (one or several selected, no step) | **Workflow** (the last one clicked) |
| a step, no workflow selected | **Step** · **Processor** — no assignment [user] |
| a step, workflows selected | **Step** · **Processor** · one tab per selected workflow **whose stream contains the step**, named after the workflow, with its colour dot [user + call] |
| a cache | **Cache** |
| a wire / entry arrow / cache line | **Link** (as today's link view) |
| a ghost | **Deleted** (read-only snapshot) |
| several steps/wires/caches/ghosts | the numbered pick list (as today) |

Every tab follows Studio's entity form [user: "show/hide all metadata of entity same as studio"]:
- the unique name (`name version`) and a kind line ("step · shared by a, b"; "assignment · belongs to daily");
- Name, Version, then **"▸ show all" / "▾ hide details"** revealing Id, Created at, Created by, Updated at, Updated by
  (read-only; instants as `YYYY-MM-DD HH:MM:SS.mmm UTC`; "—" when absent, e.g. not saved yet); one toggle state for
  the whole Inspector, remembered for the session [call: Studio has one global toggle];
- then Description and the kind's own fields.

**Step tab**: Name, Version, show all, Description, **Entry condition** with **Studio's picker** [user: item 5] — a
select-only combobox whose button and options show the letter pill + a short wire in the condition colour + the name,
✓ on the current one, keyboard as Studio's (Up/Down/Home/End/Enter/Space/Escape/Tab, a condition's letter picks it).
Then a read-only "Used by" line (workflows whose stream contains it).

**Processor tab**: the processor's Name, Version, show all, Description, Liveness; then the **three schemas one under
another** — "Input schema · name version", "Output schema · …", "Config schema · …" — each with its own show all,
name/version/description and its **definition** as pretty JSON; "none" for an empty slot. **No In/Out/Config
buttons** [user]. Editing the processor and its schema copies works as today (ProcessorSection logic).

**Workflow-named tab (assignment)**: the assignment of that workflow on this step — Name, Version, show all,
Description, **Payload** (pretty JSON), the config-schema check note ("✓ checked against … ; Save checks it again" or
the problems). No assignment yet: an empty Payload editor that creates one on first typing (today's behaviour) and a
"Remove assignment" action once it exists.

**Workflow tab**: Name, Version, show all, Description, Cron (+ its reading), entry steps as chips (✕ removes the
arrow), **caches as chips** (✕ unlinks; several allowed [user: "add multiple cache to workflow"] — linking is the
existing drag from the triangle's back to a cache, repeated per cache), its assignments list (as today, pretty JSON),
and "Payload keys in its stream" (step → ◆ N keys).

**Cache tab**: Name, Version, show all, Description, Root, Items (pretty JSON when it parses), Used by.

**Pretty JSON everywhere** [user: item 2]: schema definitions, payloads, cache items are shown laid out one field to
a line, two-space indent, as Studio's `prettyJson`; text that does not parse is shown as typed. Typing it back to the
same JSON (any layout) is not a change [call: Studio's `sameJson` rule, so pretty-printing alone never makes a row
unsaved].

## 6. Ghosts [user]

- A **ghost** is any step, wire, entry arrow, cache, cache line or triangle that was on the board earlier in this page
  session and is not on it now — deleted by the designer, by a workflow delete, or gone in a re-read (after Save,
  Take stored). Ghosts are kept in memory only: **a browser reload clears them**; Acto's own re-reads keep them
  [user: "up to reload the acto in browser"].
- Look: the item at its last location and shape, opacity ~0.32, a dashed grey `#94A3B8` outline, its name struck
  through, a "deleted · ghost" tag; ghost wires are grey, dotted. Ghosts are drawn under real items, cannot be wired
  or dragged.
- Ghosts **can be picked** (click; Ctrl+click for multi-select [user]). Toolbar: **Restore · Remove** [user].
  - **Restore** puts the item back as one undoable board edit: the same row if BaseAPI still has it (an unsaved
    delete — restoring makes it unchanged again), otherwise the snapshot as a new unsaved row (created on the next
    Save). A wire/arrow/cache line is restored only when both ends exist on the board; otherwise it is refused with
    "restore <name> first" [call: a link needs its two ends — no new rule, just the data]. A restored step comes back
    with its outgoing wires whose targets exist; a restored triangle with its entry arrows, cache lines and its
    assignments (as they were when it was deleted) whose ends exist.
  - **Remove** drops the ghost from the board for this session ("eliminate permanently") [user]. It changes nothing
    in BaseAPI. Remove is not an undo step [call].
- Undo of a delete brings the real item back, so its ghost disappears by itself.
- Ghosts are not in the Save count, the Kibana SVG, the minimap's marks, Fit or the chat's board read [call]. The minimap's extent may still reach a ghost: React Flow's `<MiniMap>` bounds skip only hidden nodes, and hiding a ghost would take it off the board [call, 2026-11-18].

## 7. Testing

Unit tests for every rule above (tabs per selection, chips, colours, motion, ghosts and restore), and the headed
Playwright suite extended in `src/Acto/e2e` to drive each in a real browser against throwaway `e2e-` rows only: the
three tab sets, show all/hide details, pretty JSON, the condition picker by mouse and keyboard, Ctrl+click of two
triangles and their two workflow tabs on a shared step, running-only animation (asserted on edge classes; a real
workflow is never started — a throwaway workflow's state is faked through the live store or a route stub [call]),
linking two caches and saving, ghosts appearing on delete, Restore, Remove, multi-select of ghosts, and ghosts gone
after a reload.

## 8. Left to the builder

Palette order beyond the first two colours; exact ghost opacity; how ghosts are stored (a seen-items map in the page
is the expected shape); whether the tab bar scrolls or wraps when many workflows are selected.

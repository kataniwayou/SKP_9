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

## 4. Selection [user: items 3, 4; replaced by rule 1, user, 2026-11-18]

- **Board look** (unchanged): a selected triangle's stream is marked — **nothing on the board fades any more** [user:
  faded is for deleted only]: the selected triangle, its tip arrows and its key chips carry its colour.
- **Key chips**: every step in a selected workflow's stream that has an assignment of that workflow shows a chip
  under the card: "◆ N keys" (N = top-level keys of the payload JSON; "◆ payload" when it is not an object) [user:
  "the keys in workflow's steps will appear"]. Several triangles can be selected; each gets its own colour from a
  fixed palette (pink `#FF0072`, purple `#7C3AED`, then teal, amber, blue, …) for its triangle, arrows, chips and tab
  dot, and with several selected a step shows one chip per workflow ("◆ 2 keys · daily") [call].
- **Rule 1 — what a click does** [user, 2026-11-18] (`selectPick`; `workflows` is always the picked triangles, in
  pick order, which gives their colours):
  - a plain click on an **unselected triangle** replaces every selected triangle; the selected steps stay;
    everything else (cache, wire, entry arrow, cache line, ghost) is dropped;
  - a plain click on an **unselected step** replaces every selected step; the selected triangles stay; everything
    else is dropped;
  - a plain click on an **unselected cache, wire, entry arrow, cache line or ghost** selects it alone (no triangles,
    no steps) — an entry arrow or cache line no longer selects its workflow;
  - **Ctrl+click** on any item toggles it in or out;
  - a plain click on an **already selected** item removes only that item;
  - a click on the **empty board** clears everything.
  - a **drop** from the toolbox selects only the new item, whatever was selected before, so the Inspector is on it at once [user, 2026-11-18].
  Unchanged: a drag never counts as a click (CLICK_SLOP), a NodeToolbar button press is not a click on its node,
  and a click on a node's handle (a connection gesture) is never a pick or an unpick [review, 2026-11-18].
  The chat's `pick` tool (`withPicks`) takes the list it is given as it is; its triangles are the selected workflows.
  A saved selection of the older shape (selected workflows that were not picks) is read with them as picked triangles.
- **Multi-select bar**: light bar + numbered badges for 2+ picks; the bar shows the actions common to everything
  picked. With 2+ triangles and nothing else picked it shows **Start · Stop · Delete** for all of them (Delete
  confirms once, listing every workflow) [call].

## 5. Inspector — tabs [user: items 1–4; replaced by rules 2 and 3, user, 2026-11-18]

The Inspector shows tabs; the first one opens on a new click, the chosen tab is kept while the same item stays picked.

**Rule 2 — what the Inspector shows** [user, 2026-11-18]:

| What is selected | Inspector |
|---|---|
| exactly one workflow, nothing else | its **Workflow** form |
| exactly one step, nothing else | **Step** · **Processor**, no assignment |
| one or more workflows and exactly one step, nothing else, **every** workflow's stream reaching the step [user, 2026-11-19] | **Step** · **Processor**, with **one assignment tab per workflow** under Step, in pick order and hue |
| workflows and one step where **any** workflow's stream does not reach the step [user, 2026-11-19: "consistency"] | the numbered pick list |
| exactly one cache / wire / entry arrow / cache line / ghost | its own tab: **Cache**, **Link** or **Deleted** |
| anything else (2+ workflows alone, 2+ steps, any other mix of 2+ items) | the numbered pick list of everything selected, triangles included |

**Rule 3 — parents and children** [user, 2026-11-18]: Step and Processor are the only parent tabs and work the same
way. The parent tab shows its own fields directly. Under it, a second, lighter tab row (role tablist "Step tabs" /
"Processor tabs") holds only its children: under Step one assignment tab per selected workflow (named after the workflow, with its
colour dot, in pick order) in the workflows-plus-one-step case, which rule 2 allows only when every one of their
streams holds the step [user, 2026-11-19]; under Processor its filled schema slots (Input schema / Output
schema / Config schema). No child is chosen at first; a child shows that assignment or schema; a click on the parent
tab already shown returns it to its own fields. A child row with no tabs is not drawn. Memory: a new pick opens Step
with no child; the chosen parent and child are kept while the same pick stays and they still exist; each parent keeps
its own chosen child [review, 2026-11-18].

Every tab follows Studio's entity form [user: "show/hide all metadata of entity same as studio"]:
- the unique name (`name version`) and a kind line ("step · shared by a, b"; "assignment · belongs to daily");
- Name, Version, then **"▸ show all" / "▾ hide details"** revealing Id, Created at, Created by, Updated at, Updated by
  (read-only; instants as `YYYY-MM-DD HH:MM:SS.mmm UTC`; "—" when absent, e.g. not saved yet); one toggle state for
  the whole Inspector, remembered for the session [call: Studio has one global toggle];
- then Description and the kind's own fields.

**One entity form for every tab** [user, 2026-11-18: "make the inspector consistent to all entities"]: Workflow, Step,
Processor, Schema, Assignment and Cache tabs all render, with the same components (`EntityBase` in tabs/shared.tsx):
1. the head (`EntityHead`): unique name `name version` and the kind line (`workflow · running`, `step · shared by a, b`,
   `processor · used by 2 steps`, `schema · config of FileFetcher`, `assignment · belongs to daily`, `cache · used by a`);
2. Name, Version; 3. "▸ show all"; 4. Description (multiline, as Studio's; blank = null);
5. the kind's own fields in Studio's FIELDS order: workflow Cron (+ reading); step Entry condition; assignment Payload
   (+ check note); processor Source hash, Instance id; schema Definition; cache Root, Items;
6. a **Related** separator and the related items, read-only or with their existing actions: workflow → Location, Entry
   steps, Caches, Assignments, Payload keys; step → Used by, Location; processor → Liveness, Input/Output/Config schema
   rows, Used by (its steps); cache → Used by, Location.
**Location** stays, and every board-item tab (Workflow, Step, Cache) shows it under Related [call, 2026-11-18].
Link and Deleted tabs use the same head and the same read-only rows (no fields); the Link tab's icon title is gone.
**Layout: the label above its value** [user, 2026-11-19: "all the labels of fields relocate above the value and not on left
side as today — same as studio", superseding 2026-11-18's two columns]: every field (`.fld`) and every read-only row
(`.ro` dt/dd) puts its label on its own line, muted 11.5 px, with the value the pane's full width under it (Studio's
`.field` / `.readout .rrow`).

**Step tab**: Name, Version, show all, Description, **Entry condition** with **Studio's picker** [user: item 5] — a
select-only combobox whose button and options show the letter pill + a short wire in the condition colour + the name,
✓ on the current one, keyboard as Studio's (Up/Down/Home/End/Enter/Space/Escape/Tab, a condition's letter picks it).
Then a read-only "Used by" line (workflows whose stream contains it), then **Next steps**: the step's wires out as
chips in the target's condition colour, ✕ removes that wire [user, 2026-11-19: "same as workflow inspector can delete
the wire/pointing to cache or entry step"]; the chips follow **Chips, one style** below.

**Processor's children** [user, 2026-11-18: "same as assignments are tabs in step, so schemas are tabs in
processor"; then "remove the duplicate"]: the schema tabs only (ids `schema:input`/`schema:output`/`schema:config`;
`processorTabsOf` in tabs.ts), smaller, lighter pills under the top tabs, same tokens in light and dark. A step
without a processor (or a processor with no schemas) has no child row; no processor shows "Processor: none".

**Processor tab (its own fields)** [user, 2026-11-18]: the processor's Name, Version, show all, Description, **Source hash** (text) and
**Instance id** (text, blank = null), editable as in Studio; then Related: Liveness, the slots as read-only rows
"Input schema" / "Output schema" / "Config schema" → `name version` or `none`, and "Used by" (the steps using it).
No schema editors here any more, and **no In/Out/Config buttons** [user].

**Schema child tab** (Input schema / Output schema / Config schema, under Processor) [user, 2026-11-18]: that schema's entity form — head
`name version`, kind line `schema · input of <processor name>` (output/config likewise), Name, Version, show all,
Description, **Definition** (pretty JSON). Name, Version and Description edits go to the processor's own copy
(`setSlotSchema`, unchanged). **The Definition is read-only** [user, 2026-11-19: "the processor schemas definitions are
readonly. if you change any schema you will need to restart the processor"; "not all the schema properties, only the
definition"]: disabled, with the note "The definition is read-only: a change needs the processor restarted."; the chat's
set_field refuses `definition` with the same reason. A schema whose definition is not read yet is shown, not edited.

**Workflow-named child tab of Step (assignment)** [user, 2026-11-18: a child of Step]: the assignment of that workflow on this step — Name, Version, show all,
Description, **Payload** (pretty JSON), the config-schema check note ("✓ checked against … ; Save checks it again" or
the problems). No assignment yet: Studio's **＋ Create** link [user, 2026-11-19: "populate on payload the json placeholders
same as studio"] makes one whose payload is laid out from the step's processor's config schema (`payloadSkeleton`, as
Studio: a required key as a `"<type>"` marker that the check names "still a placeholder", an optional one as its
default or its type's empty value; `{}` with no config schema or no properties), named as Studio names it:
`<step name>-assignment`, `1.0.0`. Until it exists there is **no Payload editor**, only the line and ＋ Create [user,
2026-11-19, as Studio]; "Remove assignment" (once it exists) takes the editor away and brings ＋ Create back.
A step whose processor has **no config schema** [user, 2026-11-19]: ＋ Create still makes `{}`, and a warning
(`.in-noschema`, the problem style) shows before and after it: "⚠ <processor> has no config schema, so this payload
can't be laid out or checked. Point a config schema to the processor (its Processor tab shows Config schema: none)."
Not shown when the processor has one, or the step has no processor. Save is not blocked (BaseAPI does not require one).

**New names, as Studio's** [user, 2026-11-19]: a new workflow `untitled`, `untitled-2`, …; a new cache `cache`,
`cache-2`, …; a new step its processor's name, then `-2`, …; a new assignment `<step name>-assignment`; all `1.0.0`.

**Workflow tab**: Name, Version, show all, Description, Cron (+ its reading), entry steps as chips (✕ removes the
arrow), **caches as chips** (✕ unlinks; several allowed [user: "add multiple cache to workflow"] — linking is the
existing drag from the triangle's back to a cache, repeated per cache), and an **Assignments** section: one chip per
assignment the workflow links — the step's condition colour, the step name, then muted `◆ N keys` / `◆ payload`, plus
` · not in its stream` when the workflow does not reach that step. No ✕, no Delete, no payload editor: an assignment is
not a connection, so it is removed and edited only under Step › workflow [user, 2026-11-18, kept 2026-11-19].

**Chips, one style** [user, 2026-11-19]: every related-item chip (entry steps, caches, assignments, a step's next
steps) is `LinkChip`: the name is a link to the item (hover: accent border, pointer) and never deletes anything; ✕
appears only on a connection — entry arrow, cache link, wire — and removes only that connection, never an item
[user, 2026-11-19: "the x mark only for remove the wiring not for delete entity"]. Opening —
entry step: this workflow with that step, Step tab; assignment: the same, Step › this workflow's assignment; cache:
the cache alone, Cache tab; next step: that step as a plain click on it would pick it (rule 1: selected workflows stay,
steps are replaced), Step tab. Every link also pans the board (zoom kept) so the step it opens — or the cache — sits in
the middle of the board, an assignment link included [user, 2026-11-19: "click on the link centerize the step"].

**Cache tab**: Name, Version, show all, Description, Root, Items (pretty JSON when it parses), Used by.

**Edits while saving**: every board edit is refused while the board saves (the board store's own guard; the UI's gestures
and the chat's tools both go through it, and the refusal goes to Output) [user, 2026-11-18].

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

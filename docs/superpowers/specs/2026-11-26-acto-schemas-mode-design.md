# Acto: Schemas mode (find and delete orphan schemas)

Date: 2026-11-26. Approved by the user the same day, from the mock
https://claude.ai/artifact/CPnMFvtSUX4ZEJHwY3eXJH ("with processors", option B colours).

## Why

Acto's board shows no schemas. Orphan schemas pile up in BaseAPI. For example, a slot edit gives a processor its own
schema copy, and the old row stays behind. Cleaning them up needs to see them, but showing every schema all the time
would overload the board. So schemas appear only in a mode that is switched on when needed.

## Rules (user, 2026-11-26)

1. **One toggle.** The board gets a **Schemas** button at the top right, beside **Board only**.
   - Off is today's board.
   - When orphans exist, the button carries a red count, whether the mode is on or off.
   - On, the button is filled with the accent colour.
   - The mode is remembered per browser (localStorage `acto.schemas`, `'1'` = on).
2. **Schemas are blocks on the board.** Each schema is a card with a stored place. While the mode is on it behaves like
   a step (rule 8).
3. **Processors are a holy cow.** Acto never deletes or copies a processor, and this mode never edits one. The only
   processors shown are those that no step uses but that reference at least one schema. Each one appears as a
   read-only card while the mode is on:
   - no toolbar;
   - Inspector fields disabled;
   - it can be dragged, and its place is stored.

   Once a step uses that processor, its card goes away. A processor no step uses that references no schema is not
   shown.
4. **Reference wires** join a schema to whoever uses it.
   - They start from each step whose processor uses the schema, one wire per step and slot, and from a processor card.
   - Drawn as a dotted line, no arrowhead, a dot at the schema end, and the slot letter in the middle: I = Input,
     O = Output, C = Config.
   - A wire is drawn from the data, never by hand. It cannot be picked or deleted.
   - Hovering a schema thickens its wires.
5. **Three states for a schema:**
   - **wired:** a processor that some step uses references it. It shows no tag.
   - **`held`:** only processors that no step uses reference it. It is wired to their cards and tagged `held`.
   - **`orphan`:** no processor references it. It has no wire and is tagged `orphan` in red.
6. **Delete only, orphans only.**
   - No Copy on schemas or processors.
   - An orphan's toolbar is **Delete**. Its ghost's toolbar is **Restore · Remove**.
   - Wired schemas, held schemas and processor cards have no toolbar.
   - Multi-pick bar: all orphans gives Delete n; all ghosts gives Restore n · Remove n. Any other mix, including any
     step, cache or triangle with a schema or processor, shows "no action in common".
   - Nothing reaches BaseAPI until Save, all or nothing (the existing push).
7. **Inspector = the step's entity form, read-only.**
   - Unique name and kind line, Name, Version, ▸ show all, Description.
   - For a schema: the read-only Definition, then **Related**.
     - Used by: step chips showing slot and processor. A chip picks that step.
     - Held by: processor chips; a chip picks that card.
     - Location.
   - For a processor: Source hash and Instance id, then Related: Steps (none), its schemas as chips, Location.
     Its child tabs are its schema slots, as on a step's Processor tab.
   - **Undo and Redo are disabled** in the Inspector header while a schema or processor is the focus. Ctrl+Z and Ctrl+Y
     still act on the board's one history.
8. **Schema and processor cards behave like steps:**
   - A drop onto another block is pushed aside (existing `pushAside`, 16px clear).
   - A nudge into another block is refused (`nudgeBlocked`).
   - 6px click slop, right-click box select, Ctrl+click multi-pick, Esc clears picks.
   - A deleted orphan's ghost drags like other ghosts.
   - While the mode is on, schema and processor cards are obstacles for every block, and every block is an obstacle
     for them. While it is off, they are not on the board.
9. **Turning the mode on settles hidden cards.**
   - A schema or processor card with no stored place, or one that now overlaps a block, is placed or pushed aside.
   - This is a layout change: it saves with the next Save and is **not** an undo step.
10. **Turning the mode off** hides schema cards, processor cards and reference wires, and drops their picks. The draft,
    ghosts and unsaved moves stay.

## Look (option B, React Flow core; constant in both themes like the cache, except where noted)

| Item | Light | Dark |
|---|---|---|
| Schema card | bg `#E6EEFB`, border `#0059DC`, ink `#0B3D91`, radius 3px, label `SCHEMA` | same card, border `#3D7CF0` |
| Processor card | bg `#1e1e1e`, border `#3c3c3c`, ink `#f8f8f8`, muted `#bebebe`, radius 3px, grey handles `#bebebe`, label `PROCESSOR`, tag `no step` | bg `#2b2b2b`, border `#727272` |
| Reference wire | `#0059DC`, dotted `1 4`, round caps, width 1.8 (2.6 lit) | `#7AA7FF` |
| `orphan` tag | white on `--danger` | same |
| `held` tag | `#334155` on `#E2E8F0` | same |
| Ghost | existing ghost look (faded, dashed) | existing |

Card sizes: schema 190 × 52, processor 210 × 64.

## Placing

- A schema with no stored place lands 140px below the first holder that references it, where holders are ordered steps
  first, then processor cards, each by id. It goes to the nearest free spot (`freeOffset`).
- A processor card lands 140px below the bottom of everything placed. An orphan with no holder lands in a column 320px
  right of everything placed. Both stack with a 40px gap, as `placeMissing` already does for unanchored rows.

## BaseAPI

- `SchemaEntity` and `ProcessorEntity` get `double? BoardX` and `double? BoardY`, as Step, Cache and Workflow did.
  - Their Create, Update and Read DTOs gain optional `double? BoardX = null, double? BoardY = null`.
  - Their mappers split into `UpdateFields` plus a wrapper, so an update without a location keeps the stored one.
  - The migration is `20261126120000_AddSchemaProcessorLocations`, nullable, with no backfill.
- No new endpoint. Moves go through `POST /model/apply` as updates.
  - A schema update carries its unchanged definition. The frozen-definition guard compares canonical JSON, so a move
    never trips it.
  - A processor update re-sends its stored fields with the new location.

## Acto

- **Rows:** `SchemaRow` and `ProcessorRow` get `at: Point | null`, read from `boardX` and `boardY`.
  `schemaBody` and `processorBody` send the location.
- **Dry runs:** a move of a schema or processor (an `at`-only change) does not count as affecting any workflow, so it
  doesn't trigger a workflow dry run.
- **Deleting:** deleting an orphan is a board edit that removes the schema row. The ghost store records a `schema`
  ghost, and `boardChanges` already sends schema deletes last.
- **Out of scope:** chat tools stay as they are. They neither list nor act on schema or processor cards; that is a
  follow-up.

# SKP Studio 11 — the Chat pane (Kimi builds workflows)

Date: 2026-10-23. Status: design, awaiting the user's approval.

## Intent

A new pane in SKP Studio where the user builds workflows by talking to the Kimi model, in plain words:

> "add a new step with processor X", "add another step and wire it to …", "on the step's assignment add the definition of …",
> "copy from this step's assignment and paste it on …"

The model is a proficient Studio workflow designer (the user, 2026-10-23): it knows Studio's entities, wiring rules and
drawing rules, and builds tidy workflows. It may do **every operation Studio offers the user, except run the wand**
(the AI drawing button). Whatever it does the user **sees on the canvas** as it happens.

## Goals

1. A dockable **Chat** pane, a tool window like Inspector, Toolbox and Output (`dock/ids.ts` `ToolId` gets `'chat'`):
   float, dock, auto hide, saved in the window layout like the others.
2. The model can perform every Studio operation (list below) by calling tools; each tool call is carried out by the
   studio through the same code path as the user's gesture, so the canvas, Inspector, Output, Undo and the
   "● design draft" mark behave exactly as if the user had done it.
3. Destructive operations wait for the user's yes in the chat (list below).
4. The model is expert in Studio design (section "The model's knowledge").
5. The conversation survives a refresh (standing rule: a refresh never loses anything).

## Non-goals

- The wand: the chat never presses it and has no tool for it.
- Window layout operations (float/dock/reset layout) are not chat tools.
- No new server component: the chat uses the wand's existing route `/ai/chat/completions` and `/ai/config`
  (nginx adds the key; vite proxies it in dev). No new cluster setting.
- No voice, no attachments.

## Anti-goals (a failure even if it technically works)

- A destructive operation carried out without the user's yes.
- A change the user cannot see on the canvas, or that cannot be reversed the way the same change by the user can.
- Messy drawings: steps piled at one spot, crossings, wires through blocks, short circuits.
- Losing the conversation, or the model's edits, on refresh.
- The model claiming it did something that did not happen: every claim must come from a tool result.

## Operations the chat may perform

Every operation in today's Studio (inventory taken from the code, 2026-10-23):

**Workflows** — list all workflows (as Load… lists them); open (load) one; create a new one; close; switch the active
document; Save (BaseApi dry run, applies when no errors; the chat reads back the errors); Start (F5) / Stop (Shift+F5);
Delete the workflow in BaseApi.

**Design (the active document, or a workflow the user names, opened first)** —
- add an empty step; add a step with a processor (a Toolbox processor drop on empty canvas); give a step a processor or
  replace it (processor drop on a step);
- add an empty cache; link an existing cache;
- wire: a step's output to a step's input, the workflow circle to an entry step, a wire's end as a junction on another
  wire of the same family (fan-in / fan-out trunk); set a wire's family through the step's entry condition;
- AutoConnect (a new step in a direction from a step, or a wire to the step there);
- move blocks; reshape a wire's route / reset route;
- pick (select) items; Copy and Paste (Ctrl+C / Ctrl+V: exact copy, new ids);
- delete picked steps, caches, wires;
- Undo, Redo, Discard design.

**Fields (the Inspector's editable fields, with drill-down)** — workflow: name, version, description, cron; step: name,
version, description, entry condition; assignment: create / remove, name, version, description, payload (JSON);
processor: name, version, description, source hash, instance id; schema (processor In / Out / Config): name, version,
description, definition (JSON; an edit makes a schema copy as today); cache: name, version, description, root, items
(dict); Revert entity.

**Reading ("preview and list all")** — list workflows, processors, caches, schemas (the Toolbox's lists and the Load
picker's list); read any entity's fields and read-only details; read the active design as a graph (blocks, wires, ends,
families — the wand's `graphOf` is the starting point); read Output's lines and pinned problems.

"Copy from … paste on …" covers both: the canvas Copy/Paste of blocks and wires, and copying a field's value from one
entity to another (read the field, write it to the other entity's field).

## Destructive operations — the user's yes first

The user confirmed this list (2026-10-23):

- Delete a workflow
- Delete steps, caches or wires
- Discard design
- Remove an assignment
- Stop a workflow
- Close a document that has unsaved changes

When the model calls one of these, the studio does **not** carry it out. The chat shows a message naming exactly what
will happen (e.g. "Delete workflow *Feed ingest 1.0.0* from BaseApi?") with **Yes** and **No**. Yes carries it out and
the model hears the result; No tells the model the user declined. The model's further actions wait while the question
is open (the user's own editing does not). Typing "yes"/"no" may also answer it.
- The chat's question replaces Studio's own pop-up for that operation, so the user is asked once (my call); for Delete
  workflow it carries the same warnings the `DeleteWarning` lists.
- Closing a document with unsaved changes offers Studio's three choices, **Save**, **Discard**, **Cancel**, as the close
  dialog does (my call).

## What the user sees

- Each tool call takes effect on the canvas the moment it runs, one at a time, so the user watches the workflow grow.
- The chat shows the conversation: the user's messages, the model's replies, and between them one compact line per
  action carried out ("+ step *fetch* with processor FileFetcher 1.2.0", "wired fetch → expand (Completed)",
  "payload of *expand*'s assignment set"), with a failed action shown as failed and why.
- While the model works the pane shows **the time** (elapsed seconds) and **the thinking tokens** arriving (the user,
  2026-10-23), in one status line styled like Claude Code's: an animated glyph, the activity word, then
  `(12s · ↓ 3.2k tokens · thinking)` — the arrow ↓ with the tokens received so far, counting up live as the stream
  arrives, and the activity (thinking / writing / the tool being carried out). Token counts come from the stream's
  `usage` when Kimi sends it, otherwise estimated from characters (as the wand's `StreamProgress` counts them). And a
  **Stop** button that cancels the request and
  stops further actions (actions already carried out stay, undoable). The input is disabled meanwhile.
- **The chat user never watches Output** (the user, 2026-10-23): the chat answers exactly what Output says. Checked in
  the code: every Output line goes through one place, the reducer's `log` path (`store/studioState.ts` ~559,
  `appendOutput`) — Save started / answered with BaseApi's own log and errors (`app/saveDesign.ts`), Start / Stop
  answers and timeouts, "<name> running / stopped" (`liveChanged`), Delete's lines (`app/deleteWorkflow.ts`), the
  "not available / not closed / not deleted" refusals (`App.tsx`) — and the pinned problems come from one hook
  (`panels/Output.tsx` `useProblems`: the design's short circuits, then the last Save's errors). So:
  - every Output line caused by a chat action, including ones that arrive later (BaseApi's answer, the workflow
    actually running / stopped), shows in the chat at that point, with the same words and the same level (error in
    red), and is in the tool's result so the model hears it too;
  - after each chat action, the document's current problems (the same list Output pins) are shown in the chat when
    they changed, and handed to the model;
  - my call: lines caused by the user's own gestures stay in Output only; the chat shows only its own.
- When the model opens or creates a workflow, that document becomes active so its canvas is in view.
- If `/ai/config` says the model is not configured, the pane says so (as the wand's tooltip does) and the input is off.

## The model's knowledge (system prompt)

The model is told, in the system prompt, everything a proficient Studio designer knows:

- the entities and their fields: workflow (cron), step (entry condition), processor (In/Out/Config schemas, source
  hash), assignment (payload), schema (definition), cache (root, items);
- families and entry conditions (`model/entryConditions.ts` CONDITIONS): a wire's colour is its family; a step's
  entry condition decides the family of wires into it;
- wiring rules: tail = output, head = input; junctions only within one family; no short circuits; loops and a step
  feeding itself are allowed (the user's "free style, short circuit only" rulings, 2026-10-20); a paste is an exact
  copy with new ids; BaseApi refuses a cache root already taken;
- the drawing rules (`ai/drawing.ts` `DRAWING_RULES`): left to right by depth, main path on one row, Failed below,
  fan-out/fan-in through trunks with junctions used wisely, equal gaps, no crossings — the model places what it adds
  by these rules (moving blocks is an ordinary Studio operation; this is not the wand);
- Save's dry run: after a Save the model reads BaseApi's errors and offers to fix them;
- the destructive list above, and that the wand is not available to it.

The current state is not pasted into every message: the model reads what it needs through the reading tools.

## How it works (decided parts)

- **Kimi tool calling** over the existing OpenAI-compatible route: each operation above is a tool (function) with a
  JSON schema. The studio runs an agent loop in the browser: send the conversation + tools, carry out the returned tool
  calls in order, append their results, ask again, until the model answers with text. A cap on rounds per user message
  (builder picks, e.g. 40) ends a runaway loop with a message.
- **One code path**: tools call the store actions and App handlers the UI uses (`StudioAction`s such as `toolDrop`,
  `autoConnect`, `design`, `editField`, `createAssignment`, `copy`/`paste`, `deletePicks`, `undo`; App's Save,
  Start/Stop, Load, New, Close, Delete). No parallel implementation of the design rules.
- Things are named by **name and version** in tool arguments where the user would name them, and by id where the model
  got an id from a read. An ambiguous name (several versions, pasted steps of one name) is an error result; the model
  then asks the user, never guesses, and its replies always say which entity it acted on (my call).
- **First task of the plan: prove Kimi tool calling** through `/ai/chat/completions` against the real model (tools
  accepted, `tool_calls` streamed, `reasoning_content` handed back in tool rounds). If it fails, the fallback is the
  wand's way: the model writes its tool calls as one JSON object in its reply text; the user sees no difference.
- Every tool returns a short result: success with the ids it created / touched, or an error with the reason (the
  same text Studio would show the user).
- Undo is the same as Studio's today (the user, 2026-10-23): each drawing action (blocks, wires, picks, paste, delete)
  is its own Undo step, as the user's gesture is; field edits and creating / removing an assignment have no Undo, as
  today, and are reversed by Revert entity or Discard design.
- **No lock** (the user, 2026-10-23): while the model works the user may keep editing the canvas and Inspector. Every
  tool acts on the studio's state at the moment it runs (never on what the model read earlier); an id that is gone or
  changed is an error result the model hears, and it reads again before going on. The user's and the model's edits
  share the one Undo history.
- The Inspector follows the model (builder-check call): a field tool shows the entity it edits in the Inspector
  (`editField` acts on the shown entity), so the user sees the field change.
- The chat is one conversation for the whole studio (not per workflow); a "New chat" button clears it.
- The conversation (messages, action lines, an open confirmation) is kept with the session in `sessionStorage`
  (`app/session.ts`), so a refresh keeps it. A request in flight at refresh is lost; the chat says so.

## Left to the builder

- Exact tool list and argument shapes; how coordinates are expressed for placement.
- Whether a Toolbox drop / AutoConnect placement is used first and the model then moves blocks, or the model gives
  positions directly.
- Streaming of the model's text into the chat, and the Stop/cancel details (reuse `readStream`, `AI_SILENCE_MS`).
- Chat pane look (follow the existing panes' style, `panels/panels.css`).
- Tests: unit tests for each tool against the store; Playwright e2e with a scripted fake `/ai/chat/completions`
  (as `e2e/aidrawing.spec.ts` does) covering a multi-step build, a confirmation Yes and No, refresh keeps the chat,
  and that no wand tool exists. Studio changes are verified with real Playwright runs before reporting (standing rule).

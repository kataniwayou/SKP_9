# Handover 2026-10-23: SKP Studio Chat pane (Kimi builds workflows) — deployed

Repo `C:\Users\UserL\source\repos\SK_P10`, branch `feature/molecule-studio`, **not pushed** (push only when the user asks).
Spec: `docs/superpowers/specs/2026-10-23-skp-studio-11-chat-pane-design.md`. Plan: `docs/superpowers/plans/2026-10-23-skp-studio-11-chat-pane.md`.

## What it is
A dockable **Chat** pane (next to Output) where the user types plain commands and Kimi (`kimi-k3` via the studio's `/ai/`
route, OpenAI tool calling) carries them out with every Studio operation except the wand: list/open/new/close/save/
start/stop/delete workflows; add steps (with processors), caches, wires, junctions, AutoConnect, move blocks, reset
route, pick/copy/paste, delete, undo/redo/discard; every Inspector field; create/remove assignments; read the design,
entities and Output. Code: `src/WorkflowStudio/src/chat/` (kimi.ts request, tools/*.ts, runTool, echo, useChat loop,
prompt.ts the model's Studio knowledge, ChatPane/StatusLine/chatStore).

- Destructive (stop, delete workflow, delete picked, discard design, remove assignment, close with unsaved changes) ask
  in the chat (Yes/No; close: Save/Discard/Cancel), replacing Studio's pop-up. The question pins its workflow id and is
  stored with the chat, so a refresh keeps it; no pin → refused, never the active document.
- Every Output line a chat action causes, and changed pinned problems, show in the chat with the same words and level.
- Status line like Claude Code: glyph, `(12s · ↓ 3.2k tokens · thinking)`, Stop. No lock: the user may edit meanwhile.
- Conversation kept in sessionStorage (+ localStorage mirror) under `skp.studio.chat`.
- `window.__studioJudge` (src/app/e2eJudge.ts): read-only judge for the real-model tests; on in dev, in a build only with `?e2e`.

## Commits
d04ac274 … 2229ce7a (15 commits after the plan 66148cb9). Deployed bundle **`index-B7Q2D6IW.js`** (2026-10-23).

## Tests
- Unit 1453/1453; typecheck clean.
- Browser suite 240 passed, 12 skipped, 0 failed (before deploy); deployed check against 18081: chat + blockdrag + routes 13/13.
- `e2e/chat.spec.ts` (mocked `/ai`, real mouse): build, confirmation, refresh, no lock, dock/float/New chat, Output echo.
- `e2e/chat-real.spec.ts` (`KIMI_REAL=1`, real model, costs money): 5 scenarios passed once with the final prompt
  (processor kafka-exporter 1.2.0). The model varies run to run: a second run of scenarios 2 and 5 is worth doing.
  Run with the cluster's KIMI_* env read via `kubectl -n skp exec deploy/workflow-studio -- printenv …` (never print the key).

## Decisions made without the user (check these)
- Reads (`read_entity`) don't move the Inspector; field edits do.
- During a chat Start/Stop wait (≤32 s) the user's own Output lines on that workflow may also be echoed.
- `delete_picked` after a refresh: Yes says "ask again" (picks aren't restored by the session).
- `set_field` lets an odd cron through like the Inspector (note in the result); invalid JSON/dict refused.
- No chat tool to hand-bend a wire (only `reset_route`); the spec listed "reshape a wire's route". Ask the user.
- No conversation trimming: a too-long chat gets "The conversation is too long for the model: start a New chat (HTTP 400)".

## Open / can wait
Wire-repair paths lack unit tests; Stop waits out a running tool; Clear Output mid-save drops echo lines; untrusted
entity text reaches the model (prompt guard only); `design.ts` ~690 lines; old e2e-9-* throwaways in BaseApi.

Never commit `k8s/31-workflow-studio.yaml` / `k8s/43-processor-analyst.yaml` (hold the Kimi key).
Deploy: as in the phase 4 handover (docker build → kind load → rollout restart → forward `svc/workflow-studio 18081:8080`).

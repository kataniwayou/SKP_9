# Handover — 2026-10-03 afternoon

Branch `feature/path-importer`, nothing pushed. Supersedes `docs/HANDOVER-2026-10-03.md`.
The user is restarting the computer (memory pressure: the WSL VM sat at its default 16 GB cap with
Chrome on top; see "Memory" below).

## After the restart -- one script

From PowerShell at the repo root:

```powershell
./tools/dev-up-after-restart.ps1 -StartSerial 559
```

It does, in order:

1. Starts the Docker containers if stopped: `desktop-control-plane`, `kind-cloud-provider`,
   `kind-registry-mirror`, and `skp-kafka`. skp-kafka has no restart policy; the script uses
   `docker start`, never `kafka-dev-broker.ps1 -Up`, which would destroy topics and offsets.
2. Waits up to 10 minutes for every pod in `skp` to be Ready.
3. Starts the nine supervised port-forwards (`tools/skp-forward-loop.ps1`, copied to `%TEMP%`).
   Logs go to `%TEMP%\skp-port-forwards\`. Ports already bound are skipped:

   | service | local -> remote |
   |---|---|
   | baseapi-service | 18080 -> 8080 |
   | prometheus | 19090 -> 9090 |
   | elasticsearch | 19200 -> 9200 |
   | otel-collector | 14317 -> 4317, 18889 -> 8889 |
   | redis | 6380 -> 6379 |
   | rabbitmq | 5673 -> 5672 |
   | **grafana** | **13000 -> 3000** |
   | **kibana** | **15601 -> 5601** |

4. Waits for BaseApi, Grafana and Kibana to answer.
5. Opens every dashboard in one Chrome window, one tab each. It lists them live from the Grafana
   search API (admin/admin) and Kibana saved objects. Today that is SKP BaseAPI, SKP Orchestrator,
   SKP Processor, SKP -- workflow step outcomes, and [Elastic Security] Detection rule monitoring.
   This uses plain Chrome, not Playwright. A Playwright version (`playwright-core`, headed system
   Chrome, persistent profile) is in an old scratchpad, under
   `...\Temp\claude\C--Users-UserL-source-repos-SK-P9\8989f30e-...\scratchpad\pw\open-dashboards.js`
   (`node open-dashboards.js`), if the tabs need scripting.
6. Starts the chain workflow `filefetcher-archiveexpander-chain` (`1a56b3ca-...`) unless
   `skp:live` already holds it. A Redis restart forgets it. A new start also moves the workflow
   start the Analyst's history limit is measured from.
7. Runs the endless feed in that window from serial **559** (`--cycles 0` = endless; Ctrl+C stops
   it). Flags: `-Cycles N`, `-NoFeed`, `-NoBrowser`.

`analyst-monitor` is **not** started by the script, and must not be started without fixing the
issue below. It costs money per fire.

The script was dry-run against the running stack on 2026-10-03 (`-NoFeed -NoBrowser`): every step
reported OK and skipped what was already up. It has not yet run after a real reboot.

## Resume here: the deployed BIT times out on dev

The operator-role plan (`docs/superpowers/plans/2026-10-03-analyst-operator-role.md`) is complete
through Task 10's free steps, and the live BIT passed locally. **Both dev fires failed inside the
preflight BIT, the same way:**

| fire | started | failed | after | where |
|---|---|---|---|---|
| declared #1 | 11:44:00Z | 12:09:27Z | 1527 s | `GroundTruthRehearsal.cs:77` (loss scenario) |
| declared #2 | 12:12:02Z | 12:36:44Z | 1484 s | `GroundTruthRehearsal.cs:77` (loss scenario) |

The judges and the quiet rehearsal pass. The **loss rehearsal** then hits
`GroundTruthRehearsal.WallClockSeconds = 600`, and its deadline cancels the model call in flight
(`the analysis was cancelled before it finished`). Single Kimi replies inside it took 263 s, 146 s,
221 s and 142 s. The local `AnalystBitLiveTests` run passed in 26m36s, so 600 s per scenario is at
the edge for v14 (more panels, history reads, classification). Twice in a row is a budget problem,
not bad luck. No verdict was saved, so every fire pays the full BIT again (about $1.50 each, about
$4.50 spent today including the local run).

**Proposed next step (needs the user's go-ahead -- it is a code change, a rebuild and a paid BIT):**
raise `GroundTruthRehearsal.WallClockSeconds` from 600 to 1200. Consider the assignment payload's
`wallClockSeconds` (600) as well, since the real investigation runs the same v14 prompt. Then
rebuild, `kind load`, repoint the `analyst` row's `sourceHash` (every Analyst edit moves it), roll
out, and fire again: once with the declared expectation (Quiet expected), then once without it
(Notable, deterministic, data expected). Fire procedure:
`bash tools/analyst-fire-once.sh <label>` (Git Bash; it saves the workflow JSON it PUTs under
`%TEMP%/analyst-fire`). It sets a one-shot cron 2 minutes ahead,
starts, waits for `running the step`, stops, and restores cron `0 9,39 * * * *`. Watch the analyst
logs with `--since-time` set **after** the fire. A since-time before it matches the previous
failure line, as happened once today.

Also still open for the user (from the plan's ledger): replay captures and scoring (not approved).
There are also three parked findings:

- the one-panel survivor exit, with suggested wording in the ledger
- the rehearsal's served-range label for window-only panels
- Prometheus history reads that sample single instants

## What is deployed on dev

- Analyst SourceHash `87e91aad8f7d2a4d6983ac73d4cc100518104487bdabf12c24bbbd254c490f9f`.
  Config schema `analyst-config` 2.0.0 `4a203429-8379-42fb-a674-c4242bb37619`; finding schema
  `analyst-finding` 4.0.0 `ebc7e9d3-b02c-4e62-bb02-fb86464793d9`.
- Assignment `2f1cc7d1-...` carries prompt v14 and `failure-causes` in `panelSet`, plus expectations
  `{maxFailedShare 0.65, maxCancelledShare 0.25, reason "dev endless feed: ..."}`. Original JSON is
  in the plan ledger folder (`task-10-report.md`).
- `analyst-monitor` is **stopped**, with cron `0 9,39 * * * *`. No v14 BIT verdict exists on dev.
- Chain workflow live (until the restart, see step 6).

## The plan's ledger

`.superpowers/sdd/2026-10-03-analyst-operator-role/progress.md` (git-ignored) holds every ruling,
deferred minor, parked finding and per-task line, plus the fire failures. Keep the folder until
Task 10 is finished. The final review is done, and its fix wave (F1-F9) is merged on the branch.

## Memory

The free RAM was about 3.6 GB of 32 GB. `vmmemWSL` held 16 GB private: the kind node used 7.3 GB,
with Elasticsearch 1.6 GB and Kibana 0.76 GB the largest, `skp-kafka` 1.2 GB, and the rest was the
VM's file cache. Chrome added about 5.2 GB. There is no `.wslconfig`, so WSL takes half the RAM by
default. Optional, untried here: `C:\Users\UserL\.wslconfig` with `[wsl2] memory=12GB` and
`[experimental] autoMemoryReclaim=gradual`. Claude Code reaps background jobs under memory
pressure. The feed, the Chrome window and a log watcher were all killed that way today.

## Untracked files (left alone deliberately)

`.playwright-mcp/`, `.wf-restore.json`, `tools/simulate-approved-feed.py` -- not this work's.

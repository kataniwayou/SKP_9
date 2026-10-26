# Handover 2026-10-26 — ObjectFetcher / ObjectPersister

## Where things stand

Branch `feature/molecule-studio`. Commits this session:

- `54a9e99f` studio: the chat agent commits design changes through `committed()` (rule 3, carried junctions), same as the canvas.
- `f8b55449` the locator key is `location` (was `filePath`); schema row `locator` (`95aa9da6-4c35-412c-9f67-0183f36739d7`) replaced `file-locator` (deleted). **Live and verified** with `simulate-endless-feed.py`.
- `72ecfffe` dev MinIO container built from source (`tools/minio-dev.ps1`, `tools/minio/Dockerfile`), running as `skp-minio`; the object pair's design spec.

Uncommitted: `docs/superpowers/plans/2026-10-26-object-fetcher-persister.md` (the plan, written, awaiting the user's review and choice of execution method) and this file.

## Next

1. User reviews the plan and picks **Native** (recommended) or **Subagent-driven** execution.
2. Execute the plan's 7 tasks. Open questions the user may answer at review:
   - copied workflow name: plan uses `objectfetcher-archiveexpander-chain` 1.0.0;
   - each good file is expected to produce both the `.zip` and `track01.xml` in `skp-out`.

## Read first

- Spec: `docs/superpowers/specs/2026-10-26-object-fetcher-persister-design.md`
- Plan: `docs/superpowers/plans/2026-10-26-object-fetcher-persister.md` (Global Constraints list the machine quirks)

## Live state

- Workflow `filefetcher-archiveexpander-chain` (`8cfdbcdb-…`) running on `{location}`.
- `simulate-endless-feed.py --start-serial 3332` was started as a background task of the previous session; check whether it still runs (`Get-CimInstance Win32_Process | ? CommandLine -match simulate-`). Its log: `%TEMP%\claude\C--Users-katan-source-repos-SK-P11\e4a576de-27db-4f9c-adef-5b3b1170e4d0\scratchpad\endless-feed.log`.
- `skp-minio` up: pods `http://skp-minio:9000`, host `http://localhost:19000`, console `:19001`; buckets `skp-in`, `skp-out`; users `objectfetcher` (read skp-in), `objectpersister` (write skp-out).

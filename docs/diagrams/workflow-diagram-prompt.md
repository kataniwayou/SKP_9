# Prompt — draw a workflow graph from the live cluster

Paste this, substituting the workflow name. It produces an HTML page published as an artifact.

```
Draw me the <workflow-name> workflow graph as an HTML page.

Read the wiring live from the API at http://localhost:18080 — the workflow
row, every step it reaches via entryStepIds/nextStepIds, every assignment,
and the schema rows those steps reference. Don't trust the docs or the
workflow's stored description; draw what the steps actually say.

The page should have: a schematic (inline SVG, success path left to right
with the schema row labelled on each edge, failure path drawn separately),
a step ledger table with each step's processor, entryCondition and real
assignment payload, and a short notes section for what the picture can't
carry.

Flag anything you find where the stored metadata contradicts the live rows.
```

## The two lines that earn their place

**"Don't trust the docs or the stored description."** `filefetcher-archiveexpander-chain`'s own
`description` field still reads `KafkaImporter -> FileFetcher -> ArchiveExpander -> ArchiveCollapser
-> FilePersister -> KafkaExporter`. `sk-normalizer` was inserted at hop 4 on 2026-09-12 and the text
was never updated. Without this line the drawing follows the description and silently loses a hop.

**"Flag anything where the stored metadata contradicts the live rows."** This turns the drawing into
a check rather than a picture. On the first run it caught assignment `42c5abdd…`, named
`sk-normalizer-sample-assignment` and described as "handler Sample: identity", carrying
`{"handler": "Acme"}`.

## Notes

- The design skills (`artifact-design`, `artifact-diagramming`) load on their own once the request is
  an HTML page with a diagram. Naming them is unnecessary.
- To get the same visual identity rather than a fresh treatment, add: `match the design of
  docs/diagrams/<file>.html`. Pointing at a committed file beats asking the model to remember.
- Port 18080 is the supervised BaseApi forward. If it refuses, check the forward before concluding
  the API is down.
- Capture *after* `POST /orchestration/start` re-projects, not straight after a PUT — an assignment
  edit lives in the database and stays invisible to the running orchestration until then.
- Processor and schema rows are shared across workflows. Editing one workflow's edges can change
  another workflow's picture, so redraw all of them rather than only the one you touched.

## Drawn so far

| workflow | page | artifact |
|---|---|---|
| `filefetcher-archiveexpander-chain` | [`filefetcher-archiveexpander-chain.html`](filefetcher-archiveexpander-chain.html) | https://claude.ai/code/artifact/da7795b5-c70c-4da4-bcdb-8dff262ad359 |

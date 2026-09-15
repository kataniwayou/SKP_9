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

A step has three outcomes, not two. Read the processor source for every
step you draw and find its Cancelled paths as well as its failure ones,
then show where a cancel goes — which, if no successor's entryCondition
admits it, is nowhere. Note any cache or whitelist address a payload
carries and say what is projected at it.

Flag anything you find where the stored metadata contradicts the live rows.

Before publishing, render the page in a browser and MEASURE the SVG with
getBBox — do not check the geometry by reading your own coordinates. Assert
that every failure edge starts exactly at the bottom edge of its box, that no
text overlaps another text or sits over a node box, that no line crosses a
label, and that nothing escapes the viewBox. Screenshot both themes.
```

## The four lines that earn their place

**"Don't trust the docs or the stored description."** `filefetcher-archiveexpander-chain`'s own
`description` field still reads `KafkaImporter -> FileFetcher -> ArchiveExpander -> ArchiveCollapser
-> FilePersister -> KafkaExporter`. It is now wrong twice over: `sk-normalizer` was inserted at hop 4
on 2026-09-12, and the AlphaBeta fork was added on 2026-09-14. Neither is mentioned. Without this
line the drawing follows the description and silently loses two features.

**"Flag anything where the stored metadata contradicts the live rows."** This turns the drawing into
a check rather than a picture. On the first run it caught assignment `42c5abdd…`, named
`sk-normalizer-sample-assignment` and described as "handler Sample: identity", carrying
`{"handler": "Acme"}`.

**"A step has three outcomes, not two."** Added 2026-09-15. The first drawing showed hop 4 as a
plain success box with a dashed failure edge, which is what the workflow rows say. The processor
source says otherwise: `AcmeHandler.Augment` throws `CancelledException` when the artist misses the
whitelist or is absent, and since every successor is `entryCondition 1 · Completed`, that branch
stops without taking either drawn edge. A cancel is invisible in the API rows — it exists only in
the handler — so a drawing sourced from the live graph alone will always miss it.

**"MEASURE the SVG with getBBox."** Added 2026-09-14, after a reader spotted that hop 4b's dashed
failure edge started 34px below the box it belongs to. Measuring the *rendered* page then found
**seven more** collisions the author had not seen: the schema labels sat inside the box band and
overlapped hop discs and processor names, because the gaps between boxes are 42px and
`archive-document` renders ~96px wide. Reading coordinates back from your own source cannot catch
either class of defect — one is a typo you will read past, the other depends on font metrics you do
not have.

## Checking the rendered page

`file://` is blocked in the Playwright browser, so serve the directory:

```
python -m http.server 8899 --bind 127.0.0.1     # from docs/diagrams/
```

**Send a charset or the screenshots lie.** `http.server` serves `text/html` with no charset, so every
em-dash and `·` renders as mojibake and you will waste a pass "fixing" text that is fine. The artifact
host injects a charset meta; the local server does not. Subclass `SimpleHTTPRequestHandler` and append
`; charset=utf-8` to the HTML content type.

Set the viewport wide (1440×1000) before screenshotting, or the figure is clipped by its own
horizontal scroller and you will review a cropped drawing.

The assertions worth running, all against `getBBox()` on the live DOM:

Test a `path` with its own segments, not its bbox: the bypass arc's bounding box swallows two labels
it never touches, and a bbox-only check reports three collisions that are not there. Split the `d`
into segments and test each.

| check | what a failure means |
|---|---|
| each vertical `.edge-fail` starts at the bottom edge of the box above it | an edge floating free of its node |
| no text bbox intersects another text bbox | labels colliding — the commonest defect |
| no label bbox intersects a node rect | the label band is in the wrong place |
| no line crosses a text bbox | a rule struck through a caption |
| `svg.getBBox()` stays inside the `viewBox` | clipped content at the edges |
| `documentElement.scrollWidth <= clientWidth` | the page scrolls sideways |
| every gate dot lies on a real edge segment and over no text | a marker floating beside its edge |
| each vertical stub starts at its box's bottom edge, bus drops excepted | same defect as the failure edges |
| no `.facts` cell leaves dead columns in its row | an odd fact count paints a grey band |

Then screenshot with `data-theme="dark"` set on the root as well as the default, and look at both.

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
- Delete the screenshots and the `.playwright-mcp/` directory afterwards; they land in the repo root,
  not in a temp folder.

## Drawn so far

| workflow | page | artifact |
|---|---|---|
| `filefetcher-archiveexpander-chain` | [`filefetcher-archiveexpander-chain.html`](filefetcher-archiveexpander-chain.html) | https://claude.ai/code/artifact/da7795b5-c70c-4da4-bcdb-8dff262ad359 |

Redrawn 2026-09-15 from a fresh live capture and republished to the same URL (version 4). What the
redraw changed, beyond the cancelled stub the prompt now asks for:

- **Hop 4's payload** gained `cacheAddress`, and the workflow gained a cache row.
- **Four schema edges came back.** The page had said "2 of 8 enforced"; live it is 7 of 8, the one
  still open being `kafka-exporter`, which declares no input schema. Gate dots on six edges plus the
  bypass arc.
- **The processor count was wrong.** "7 (two used twice)" does not reconcile with ten steps — there
  are eight rows. Nobody caught it by reading; it fell out of counting the live rows.

The lesson for the next redraw: a count in the facts strip is a claim, and the capture script should
print every number the page states so the two can be diffed. Three of the six facts were stale here
after one day.

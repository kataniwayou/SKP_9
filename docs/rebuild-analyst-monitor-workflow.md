# Rebuild the `analyst-monitor` workflow on a fresh BaseApi

You are an AI model on a machine with no access to the cluster this graph came from.
Everything you need is in this file. Follow it top to bottom.

**This workflow spends money on every fire.** Step 8 starts a cron that calls a paid model API
every five minutes, unattended, until someone stops it. Read Appendix D before you run step 8, not
after. Every step before step 8 is free and reversible.

## How to use this file

- Every request goes to the BaseApi you were given. Base URL below is written `{API}`.
- **Row ids are irrelevant.** The originals are deliberately not in this file. Each `POST`
  returns a new `id`; you record it against the slug the step names, and substitute it wherever
  a later body writes `<slug>`. Nothing else has to match.
- **One id is the exception, and it is not this graph's.** `targetWorkflowId` in section 6.1 is the
  id of a *different* workflow -- the one being watched. It is the one value in this file you cannot
  derive from this file. Read section 1.3.
- **Values are what must match.** Names, versions, descriptions, schema definitions, entry
  conditions and payloads are reproduced verbatim. Send them byte for byte, including the
  escaping inside `definition` and `payload`.
- Do the steps in order. The order is forced by foreign keys, not by taste.
- If a request fails, or if the chain runs and produces nothing, stop and read Appendix C.

## The graph you are building

Two steps, two processors -- **one of which this file does not create** -- two schemas, no cache,
one workflow, fired by cron every five minutes at second `0`.

```
analyst-monitor              (analyst, Always)          <-- entry step; cron dispatches it
  |
  +-> analyst-finding-export     (kafka-exporter -> skp-analyst-findings, PreviousCompleted)
```

That is the whole graph. Four things about it are easy to get wrong, and only one of them is
caught by the API:

- **The export edge is `entryCondition: 1`, not `4`.** This is the single most consequential
  integer in this file. Every sample step in the sibling document
  `rebuild-filefetcher-archiveexpander-chain.md` uses `4` (Always), and copying that habit here
  fires the exporter after an Analyst step that **failed or was cancelled** -- publishing a
  confident, empty finding to Kafka on exactly the runs where the Analyst either broke or
  deliberately found nothing. A cancel *is* the all-clear. It must not export.
- **There is no failure path and no `record-outcome`.** The sibling chain wires every step to an
  outcome recorder; this one wires nothing. That is deliberate -- a two-step monitor whose failures
  are already one query away does not need a fan-in -- but it means a failed or cancelled run
  leaves no row anywhere, only a step outcome in Elasticsearch and a log line. Appendix C2.
- **The Analyst investigates a different workflow than the one it runs under.** Its own executions
  live under *this* monitor's id; the workflow it reads is named on its payload. Nothing connects
  the two, and nothing checks the one you write. Section 1.3 and C1.
- **`kafka-exporter` is a processor row you must not create.** It is shared with the sibling chain
  and `sourceHash` is unique, so a second create is a `409`. Section 1.2.

## Step 1 -- preconditions

Before the first request, confirm all seven. Do not start without them.

1. **BaseApi is reachable and the database is migrated.**
   `GET {API}/api/v1/workflows` must return `200` and a JSON array. The entity routes are plural
   and version-segmented -- `/api/v1/schemas`, `/api/v1/processors`, `/api/v1/steps`,
   `/api/v1/assignments`, `/api/v1/workflows`.

2. **The two rows this file does not create already exist -- or you create them from the sibling
   document first.** The export step runs on `kafka-exporter`, which the sibling chain also uses,
   and the export assignment's payload is validated against `kafka-exporter-config`. Both are rows,
   not copies:
   - `GET {API}/api/v1/processors` and find the one whose `sourceHash` is
     `ba7df85269267a1032838c998a926f14ac5b8be14d2472e32675cd2c62c0343c`. Record its id as
     `<proc:kafka-exporter>`. **Do not create a second one** -- `sourceHash` is unique among rows
     with no `instanceId` (one row per `(SourceHash, InstanceId)`, counting "no instance" as a
     value), so the create returns `409` and the correct response is to go and find the row that
     already answers.
   - If this is a genuinely empty database and the sibling chain has not been built, create both
     rows from `rebuild-filefetcher-archiveexpander-chain.md` section 2.7
     (`kafka-exporter-config`) and section 3.5 (`kafka-exporter`) before continuing here, then come
     back. Nothing else from that file is needed.

3. **The workflow you are going to watch exists, and you have its id.**
   `GET {API}/api/v1/workflows`, find the one you intend to monitor -- for this deployment,
   `filefetcher-archiveexpander-chain` -- and record its id as `<target-workflow>`. Section 6.1
   writes it into a payload. **This is not the monitor's own id**, and writing the monitor's id
   there is a defect that produces no error anywhere: see C1.

4. **The `processor-analyst` service is deployed and running.** It does not create its own row.
   It asks the API, over the broker, for the row matching its embedded `sourceHash`, and
   **waits forever until it exists** -- a pod at `Running`/`NotReady` with zero restarts before
   step 3 is correct behaviour, not a fault. Its log reads
   `still no processor registered for source hash ...` until step 3 lands; readiness is gated on
   identity, so the pod goes `Ready` within a beat of step 3.

5. **Redis and the broker are up.** Step 8 reads per-replica liveness out of Redis; the
   processor's identity handshake goes over the broker.

6. **Elasticsearch and Prometheus are reachable from the Analyst pod.** This processor's whole
   input is panel reads: `Analyst__Panels__ElasticBaseUrl` and
   `Analyst__Panels__PrometheusBaseUrl` in `k8s/43-processor-analyst.yaml`. Neither is a row and
   no gate looks at either. An unreachable source is not a silent zero -- a panel read that fails
   is a trust flag the agent is told to treat as doubt about its own evidence -- but a deployment
   where *both* are unreachable produces a run that can conclude nothing, which lands as `Failed`
   rather than as a finding.

7. **The output topic exists, and the model account has credit -- or deliberately does not.**
   - `skp-analyst-findings` must exist on the broker. This repo does not rely on
     `auto.create.topics.enable`: it defaults on, but it is a broker setting this repo does not
     own, so a chain that depends on it breaks when someone else turns it off.
   - `Analyst__Model__ApiKey`, `__BaseUrl` and `__ModelId` come from the manifest, not from a row
     and not from this file. **Do not copy a key into a document.** If the account behind the
     configured key is spent, every run fails loudly -- non-2xx becomes
     `AnalysisImpossibleException` becomes a `Failed` step -- which is by design, and is the
     cheapest possible proof that the failure path reaches `Failed` instead of silence. Doing that
     once, deliberately, before funding, is worth more than reading this paragraph.

## Step 2 -- create the 2 schema rows

`POST /api/v1/schemas` once per row, in either order -- schemas reference nothing.

**These two `definition` values are derived, not retyped.** They are byte-identical to
`src/tests/BaseApi.Tests/Schemas/analyst-config.json` and `analyst-finding.json`, which
`AnalystConfigSchemaTests` and `AnalystFindingSchemaTests` read. That matters because a referenced
definition can never be edited: if the row and the fixture disagree on the first `POST`, the fix is
a new row plus re-pointing the processor, not an update. If those two files are on the machine you
are rebuilding on, prefer generating the string from them over trusting the escaping below.

### 2.1 `analyst-config`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "analyst-config",
  "version": "1.0.0",
  "description": "Analyst step payload: what to investigate, how far back, the panels it may read, and the three hard ceilings. The loop contract is compiled, so a payload edit cannot break the typed exit.",
  "definition": "{\n  \"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n  \"title\": \"Analyst step payload\",\n  \"type\": \"object\",\n  \"properties\": {\n    \"targetWorkflowId\": {\n      \"type\": \"string\",\n      \"format\": \"uuid\",\n      \"pattern\": \"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$\",\n      \"description\": \"The workflow to investigate. Scopes every query the agent issues; the Analyst's own executions live under the monitor workflow's id, so a query scoped here cannot see them. The pattern is what enforces UUID shape here -- ProcessorJsonSchemaValidator does not set RequireFormatValidation, so format:uuid alone validates any string. format is kept as correct, tool-readable documentation; do not delete pattern as 'redundant' with it.\"\n    },\n    \"windowMinutes\": {\n      \"type\": \"integer\",\n      \"minimum\": 1,\n      \"description\": \"How far back to look, matching what the dashboards show. The agent is stateless across dispatches, so this window is the only history it has.\"\n    },\n    \"prompt\": {\n      \"type\": \"string\",\n      \"minLength\": 1,\n      \"description\": \"The analytical judgment layer only. The loop contract -- the five stages, the tool protocol, the terminal tools -- is compiled, so a payload edit cannot break the typed exit.\"\n    },\n    \"panelSet\": {\n      \"type\": \"array\",\n      \"items\": { \"type\": \"string\", \"minLength\": 1 },\n      \"minItems\": 1,\n      \"description\": \"The panels this monitor may consult. This is the read boundary: the tool surface is the panel list.\"\n    },\n    \"maxIterations\": {\n      \"type\": \"integer\",\n      \"minimum\": 1,\n      \"description\": \"Hard ceiling on model turns. Exhaustion with no terminal tool call is a failed step, never a quiet one.\"\n    },\n    \"maxTokens\": {\n      \"type\": \"integer\",\n      \"minimum\": 1,\n      \"description\": \"Hard ceiling on accumulated tokens across the dispatch.\"\n    },\n    \"wallClockSeconds\": {\n      \"type\": \"integer\",\n      \"minimum\": 1,\n      \"description\": \"Hard ceiling on elapsed investigation time.\"\n    }\n  },\n  \"required\": [\n    \"targetWorkflowId\", \"windowMinutes\", \"prompt\", \"panelSet\",\n    \"maxIterations\", \"maxTokens\", \"wallClockSeconds\"\n  ],\n  \"additionalProperties\": false\n}\n"
}
```

Record the returned id as `<analyst-config>`.

Two properties in that definition are load-bearing in a way a reader is likely to undo:

- `targetWorkflowId` carries **both** `format: "uuid"` and a `pattern`. The pattern is what
  actually enforces the shape -- `ProcessorJsonSchemaValidator` does not set
  `RequireFormatValidation`, so `format: uuid` alone validates any string at all. Do not delete
  the pattern as redundant with the format. Keep the format: it is correct, tool-readable
  documentation.
- `additionalProperties: false` is set, so an extra field fails the payload gate as loudly as a
  missing one, and `required` names all seven properties.

### 2.2 `analyst-finding`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "analyst-finding",
  "version": "1.0.0",
  "description": "Analyst output document. Quiet and Indeterminate verdicts are deliberately absent: a quiet run cancels the step and an unanalysable one fails it, so neither reaches a document.",
  "definition": "{\n  \"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n  \"title\": \"Analyst finding\",\n  \"type\": \"object\",\n  \"properties\": {\n    \"verdict\": {\n      \"type\": \"string\",\n      \"enum\": [\"Drifting\", \"Notable\"],\n      \"description\": \"Quiet and Indeterminate are deliberately absent: a quiet run cancels the step and an unanalysable one fails it, so neither reaches a document.\"\n    },\n    \"window\": {\n      \"type\": \"object\",\n      \"properties\": {\n        \"from\": { \"type\": \"string\", \"format\": \"date-time\" },\n        \"to\": { \"type\": \"string\", \"format\": \"date-time\" },\n        \"samplesExamined\": { \"type\": \"integer\", \"minimum\": 0 }\n      },\n      \"required\": [\"from\", \"to\", \"samplesExamined\"],\n      \"additionalProperties\": false,\n      \"description\": \"The REALIZED window, not the configured one. Precision here is what lets two consecutive answers be compared, which is the only liveness signal a stateless agent has. format:date-time on from/to is documentation only -- ProcessorJsonSchemaValidator does not set RequireFormatValidation, so it is never enforced. No pattern is added either: unlike a hand-authored payload field, these values come from this processor's own serializer writing DateTimeOffset, so the only way they could be malformed is a bug in code we already test; the actual guarantee is the serializer, not this schema.\"\n    },\n    \"narrative\": { \"type\": \"string\", \"minLength\": 1 },\n    \"evidence\": {\n      \"type\": \"array\",\n      \"minItems\": 1,\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"panelId\": { \"type\": \"string\", \"minLength\": 1 },\n          \"layer\": { \"type\": \"string\", \"minLength\": 1 },\n          \"label\": { \"type\": \"string\", \"minLength\": 1 },\n          \"value\": { \"type\": \"string\" }\n        },\n        \"required\": [\"panelId\", \"layer\", \"label\", \"value\"],\n        \"additionalProperties\": false\n      }\n    },\n    \"ruledOut\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"hypothesis\": { \"type\": \"string\", \"minLength\": 1 },\n          \"disconfirmingCriterion\": { \"type\": \"string\", \"minLength\": 1 },\n          \"whatWasSeen\": { \"type\": \"string\", \"minLength\": 1 }\n        },\n        \"required\": [\"hypothesis\", \"disconfirmingCriterion\", \"whatWasSeen\"],\n        \"additionalProperties\": false\n      }\n    },\n    \"trace\": {\n      \"type\": \"array\",\n      \"minItems\": 1,\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"ordinal\": { \"type\": \"integer\", \"minimum\": 1 },\n          \"panelId\": { \"type\": \"string\", \"minLength\": 1 },\n          \"dataReturned\": { \"type\": \"boolean\" }\n        },\n        \"required\": [\"ordinal\", \"panelId\", \"dataReturned\"],\n        \"additionalProperties\": false\n      },\n      \"description\": \"How a reader tells 'checked and it was clean' from 'never looked'. Without it a wrong conclusion is unauditable.\"\n    },\n    \"promptHash\": { \"type\": \"string\", \"minLength\": 1 }\n  },\n  \"required\": [\"verdict\", \"window\", \"narrative\", \"evidence\", \"ruledOut\", \"trace\", \"promptHash\"],\n  \"additionalProperties\": false\n}\n"
}
```

Record the returned id as `<analyst-finding>`.

The `verdict` enum is exactly `Drifting` and `Notable`. `Quiet` and `Indeterminate` are absent on
purpose and adding them would be a design change, not a fix: a quiet run throws
`CancelledException` and an unanalysable one throws `FailedException`, so neither ever reaches a
document. A verdict enum that could express "nothing happened" would give the agent a way to
publish silence as a finding.

## Step 3 -- create the 1 processor row

`POST /api/v1/processors`. One row. The other processor this graph needs is
`<proc:kafka-exporter>`, found in section 1.2 and **not created here**.

Read Appendix A before you send `sourceHash` -- it is the one field you may not be able to copy,
and the value below is known to have drifted once already.

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "analyst",
  "version": "1.0.0",
  "description": "Reads the same Kibana and Grafana panels an operator reads, drives kimi-k3 through a five-stage investigation, and either writes a finding or says nothing. Read-only.",
  "sourceHash": "7f126f9e355b69083ec027e1c3178c9cbece289025176bcf6e7074274b2dacb4",
  "instanceId": null,
  "inputSchemaId": null,
  "outputSchemaId": "<analyst-finding>",
  "configSchemaId": "<analyst-config>"
}
```

Record the returned id as `<proc:analyst>`.

`inputSchemaId` is `null` because the Analyst is an entry step: cron dispatches it and nothing
feeds it. That null is also what lets the export edge pass the schema-edge gate -- see C4.

This row is what the waiting pods are looking for. Watch them resolve:

```
kubectl -n skp get pods -l app=processor-analyst
kubectl -n skp logs -l app=processor-analyst --tail=20
```

## Step 4 -- create the 2 steps, with no edges yet

`POST /api/v1/steps` with `nextStepIds: null` on both. A step cannot name a successor that does not
exist, so the edge goes in on a second pass.

`entryCondition` is an integer: `1` = PreviousCompleted, `2` = PreviousFailed,
`3` = PreviousCancelled, `4` = Always. Never omit it -- the DTOs are positional records and an
omitted field binds to `0` (PreviousProcessing), which both validators reject.

### 4.1 `analyst-monitor`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "analyst-monitor",
  "version": "1.0.0",
  "description": "investigates the filefetcher-archiveexpander-chain over the last 15 minutes",
  "processorId": "<proc:analyst>",
  "nextStepIds": null,
  "entryCondition": 4
}
```

Record the returned id as `<step:analyst-monitor>`.

`4` is correct here and means less than it looks like it does. An entry step has no predecessor, so
the outcome-shaped conditions have nothing to be evaluated against and are ignored on a fire; the
only condition an entry step's dispatch consults is `Never` (`5`), which is the operator's
per-entry-step freeze. `4` is the convention for "this is an entry step"; it is not what makes the
export edge dangerous.

### 4.2 `analyst-finding-export`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "analyst-finding-export",
  "version": "1.0.0",
  "description": "publishes the finding; gated on the Analyst having COMPLETED, not merely finished",
  "processorId": "<proc:kafka-exporter>",
  "nextStepIds": null,
  "entryCondition": 1
}
```

Record the returned id as `<step:analyst-finding-export>`.

**`1`, and this is the value to get right.** `PreviousCompleted` is the only condition under which
publishing is honest. Under `4` this step also fires when the Analyst **failed** -- the model was
unreachable, the account was spent, the panels could not be read -- and when it was **cancelled**,
which is the Analyst's way of saying it looked and found nothing worth an operator's evening. Both
would put a document on `skp-analyst-findings` whose absence of content reads exactly like an
all-clear. Under `2` or `3` it would publish only on those runs, which is the same mistake
inverted. Send `1`.

## Step 5 -- write the edge

`PUT /api/v1/steps/{id}`. The update DTO is a full replacement, not a patch: every field must be
resent exactly as created, with `nextStepIds` now filled in. A field omitted here is silently
reverted -- including `entryCondition`, which would bind to `0` and make the step permanently dead.

`analyst-finding-export` is a sink -- no `PUT`.

```http
PUT /api/v1/steps/<step:analyst-monitor>
Content-Type: application/json

{
  "name": "analyst-monitor",
  "version": "1.0.0",
  "description": "investigates the filefetcher-archiveexpander-chain over the last 15 minutes",
  "processorId": "<proc:analyst>",
  "nextStepIds": [
    "<step:analyst-finding-export>"
  ],
  "entryCondition": 4
}
```

Read it back and confirm both survived the replacement:

```http
GET /api/v1/steps/<step:analyst-monitor>
```

## Step 6 -- create the 2 assignments

`POST /api/v1/assignments`. One per step, no step without one. `payload` is a JSON **string**, not
an object -- the escaping below is part of the value.

### 6.1 `analyst-monitor-cfg` -> step `analyst-monitor`

**Substitute `<target-workflow>` from section 1.3 before sending.** It appears once, as
`targetWorkflowId`, and it is the id of the workflow being watched -- not this monitor's.

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "analyst-monitor-cfg",
  "version": "1.0.0",
  "description": "5-minute sweep; 15m window overlaps the cadence so nothing falls in a gap",
  "stepId": "<step:analyst-monitor>",
  "payload": "{\"targetWorkflowId\":\"1a56b3ca-e276-4815-87fa-5c2f48ab6dad\",\"windowMinutes\":15,\"prompt\":\"You are reviewing a document-processing chain. Decide whether anything in this window deserves an operator's attention tonight. Treat trust flags on panel reads as facts about the evidence, not about the system: an absent series, a partly-covered window, or a 'no data' that cannot be told apart from 'no problem' are all reasons to doubt your own reading rather than to conclude health. A single slow step is not a finding; a trend, a repeated failure, or a step-outcome mix that changed is. A dead-letter queue standing above zero is ALWAYS worth reporting, however small and however old: it is work this deployment threw away and has not dealt with, it produced no step outcome of any kind, and it will not resolve on its own. A queue missing from that panel entirely is not a queue that is empty. Read refused-messages as the other half of that number, not as a duplicate of it: dead-letter depth is a level with no attribution, refusals are events in this window scoped to this workflow, and the exception on a sample is why the message was refused. Depth above zero with no refusals in window is loss from before this window or from another workflow -- still worth reporting, but not evidence that anything is failing now; refusals in window mean this workflow is losing work now. Those two disagreeing is not a contradiction to resolve, and it is not a reason to doubt either panel: a refusal that carries no workflow id never reaches refused-messages at all, so that panel under-reports by construction and a zero on it never overrides a non-zero depth. A notParked refusal is not in any dead-letter queue -- it was redelivered, so do not tell an operator to go and look for it. run-boundaries says whether this workflow began and finished runs at all. Do NOT expect its two counts to be equal: one entry per fire against one terminal per branch end, so the healthy ratio belongs to the workflow and you cannot know it from one dispatch. The one unambiguous finding is entry above zero with terminal at zero -- the workflow is alive and nothing is completing -- and even then check drainedPolls first, because an importer that read nothing opens no lineage and correctly produces no terminal. Entry at zero means it did not fire at all. If nothing contributes, say so.\",\"panelSet\":[\"step-outcomes\",\"step-failures\",\"refused-messages\",\"run-boundaries\",\"queue-wait\",\"processor-liveness\",\"dead-letter-depth\"],\"maxIterations\":12,\"maxTokens\":400000,\"wallClockSeconds\":240}"
}
```

Record the returned id as `<asg:analyst-monitor-cfg>`.

The `targetWorkflowId` in that payload is the live id this file was written against. **Replace it
with `<target-workflow>`.** If you leave it, and that row does not exist on your database, you get
no error from anywhere -- see C1.

Four numbers in that payload are chosen against ceilings that are compiled, not configured:

- `wallClockSeconds: 240` sits deliberately under the 300-second cron interval, so one run cannot
  still be going when the next fires. Raise the cron interval before raising this.
- `maxTokens: 400000` sits well under the compiled `MaxTokenBudget` of `10_000_000`
  (`AnalystProcessor.cs:53`), which is itself paired with the manifest's `384Mi` memory limit
  rather than being a free number -- one dispatch accumulates its whole transcript in memory. A
  payload above the ceiling is refused by the processor, not by a gate.
- `maxIterations: 12` is the ceiling on model turns. Exhaustion with no terminal tool call is a
  **failed** step, never a quiet one.
- `windowMinutes: 15` overlaps the five-minute cadence on purpose. The agent is stateless across
  dispatches, so this window is the only history it has.

`panelSet` is the read boundary: the tool surface handed to the model *is* the panel list. The
seven named there are a subset of the nine in `PanelRegistry` -- `produce-duration` and
`consumer-duration-mean` are registered and deliberately not offered. Adding a panel widens what
the agent may read; a **typo** does not, and is caught: `panelSet` is schema-checked as "an array
of strings" only, so an unknown id passes the payload gate, and `AnalystProcessor` then validates
it against the registry and throws `FailedException` naming the unknown ids. That is a loud, clean
failure rather than an agent quietly reading six panels and concluding from them.

### 6.2 `analyst-finding-export-cfg` -> step `analyst-finding-export`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "analyst-finding-export-cfg",
  "version": "1.0.0",
  "description": "publishes the Analyst's finding document",
  "stepId": "<step:analyst-finding-export>",
  "payload": "{\"topic\":\"skp-analyst-findings\",\"deliveryTimeoutSeconds\":30}"
}
```

Record the returned id as `<asg:analyst-finding-export-cfg>`.

Two fields only. No broker list: that is org infrastructure arriving as `Kafka__BrokerList` from
deployment config, not a field a workflow author chooses.

## Step 7 -- create the workflow

`POST /api/v1/workflows`. Both id lists are junction writes, so both steps and both assignments
above must already exist.

```http
POST /api/v1/workflows
Content-Type: application/json

{
  "name": "analyst-monitor",
  "version": "1.0.0",
  "description": "Analyst -> KafkaExporter. Investigates filefetcher-archiveexpander-chain every five minutes and publishes any finding to skp-analyst-findings.",
  "entryStepIds": [
    "<step:analyst-monitor>"
  ],
  "assignmentIds": [
    "<asg:analyst-monitor-cfg>",
    "<asg:analyst-finding-export-cfg>"
  ],
  "cacheIds": null,
  "cronExpression": "0 */5 * * * *"
}
```

Record the returned id as `<workflow>`.

`cacheIds` is `null`: this graph projects no dictionary into L2. The sibling chain's cache is not
shared with it and must not be named here.

**`cronExpression` is six-field, seconds first.** `0 */5 * * * *` is second `0` of every fifth
minute. The validator accepts 5- or 6-field expressions and picks the format **by field count**,
which is what makes this field one keystroke from a disaster: `*/5 * * * * *` is also six fields
and means every 5 **seconds** -- twelve paid investigations a minute. Count the fields before you
send, and count them again after any edit.

## Step 8 -- start the workflow

**Stop. Read Appendix D.** Creating the rows above runs nothing and costs nothing. This request is
what begins spending money every five minutes, unattended, until someone issues the stop.

```http
POST /api/v1/orchestration/start
Content-Type: application/json

"<workflow>"
```

The body is the bare workflow id as a JSON string -- not an object, not a bare token.

A `202 Accepted` means the request was well-formed, all four gates passed, and the projection write
has been queued. It does **not** mean the projection is written yet; give it a few seconds before
expecting the first fire.

A `422` means a gate refused the graph, and each names the offending rows. There are four gates but
**five** gate names a `422` can carry: the cycle gate's walk also refuses a `nextStepIds` entry
that resolves to no step and reports that as `missingStep` rather than `cycle`.

To take it down again: `POST /api/v1/orchestration/stop` with the same body. On a workflow that
costs money per fire, the stop is part of the procedure, not a footnote -- a monitor left running
after a rebuild verification is the most expensive way to forget something.

## Appendix A -- `sourceHash`, the one field you may not be able to copy

`sourceHash` is not a label. It is the processor's code identity, and it is how a running processor
finds its own row: it asks for the row carrying the hash embedded in its own assembly, and waits
forever if none exists. A wrong value does not error -- it hangs, silently, forever.

The hash is a SHA-256 fold over the concrete processor project's own `.cs` files, with line endings
normalised to LF and paths ordinal-sorted, so it is **identical on Windows and Linux for identical
sources**. The fold covers only the concrete processor's own files, so a framework-only change does
not move it. That gives you two cases:

- **The offline machine builds `Processor.Analyst` from the same sources, unmodified.** The hash in
  step 3 is correct as written. Copy it.
- **The sources differ at all, or you cannot verify they are the same.** The hash in step 3 is
  wrong and will hang the processor forever. Read the real value from the built assembly instead,
  from its `AssemblyMetadata("SourceHash", ...)` attribute, and send that.

```
dotnet build SK_P.sln -c Release | grep SourceHash
```

**Provenance, and a worked example of this going wrong.** The value in step 3 was re-derived on
**2026-09-28** from a `Release` build of this repo, and both the `Debug` and `Release` builds agree
on it. It is **not** the value in `docs/task-16-analyst-monitor.http`, which this document is
otherwise derived from: that file was generated on 2026-09-26 and carries
`29ea6590a4a9221647b34059081f87bd8bc5d483bc3949168739c5af1f5595c1`, read out of the built image at
the time and correct then. Four commits touched `src/Processor.Analyst/` afterwards -- among them
the refusals panel, the run-boundary panel and the panel-drift rule -- and the fold moved with them.
Nothing announced that. The `.http` file still returns `201` on every request, its counts still
match, and the graph still starts, because **no gate reads a `sourceHash`** -- only a processor
does, by waiting. If you are rebuilding from that file rather than this one, re-derive the hash
before you trust it.

## Appendix B -- verifying the rebuild

Four checks, in order. The first three do not need the model account to have credit.

**B1. Counts.** `GET` each collection and confirm the rows this file added: **2** new schemas,
**1** new processor, **2** steps, **2** assignments, **1** workflow, and **no** new cache. The
processor and schema collections will also hold the sibling chain's rows if it is built; count what
you added, not what is there.

**B2. The graph is what you meant.** Read the workflow back, resolve each id to a name, and
confirm:

- exactly one entry step, `analyst-monitor`, with `entryCondition: 4`
- `analyst-monitor` names exactly one successor, `analyst-finding-export`
- **`analyst-finding-export` has `entryCondition: 1`** -- the one check worth doing twice
- `analyst-finding-export` has an empty `nextStepIds`
- both steps have exactly one assignment pointing at them
- `analyst-finding-export`'s `processorId` is the *existing* `kafka-exporter` row, not a new one:
  there must still be exactly one processor row whose `sourceHash` is `ba7df852...`
- the workflow's `cacheIds` is empty and its `cronExpression` has **six** fields

**B3. The payload names the right workflow.** This is the check no gate performs. Read the
assignment back, parse its `payload`, and confirm `targetWorkflowId` is the id of the workflow you
intend to watch -- `GET {API}/api/v1/workflows/<that id>` must return the *target*, not the monitor.
A monitor pointed at itself is well-formed, passes every gate, starts cleanly, and reports nothing
of interest forever. C1.

**B4. It starts.** A `202` from step 8 proves the cycle gate, the schema-edge gate, the payload gate
and the liveness gate all accepted the graph -- and, through the cycle gate's walk, that the edge
you wrote in step 5 resolves. It proves nothing about B3, and nothing about whether the model
account has credit.

Then **stop it again** unless you intend it to keep running, and confirm the stop landed. A
verification run that leaves the cron armed bills for the oversight.

## Appendix C -- the ways this fails

**C1. The monitor runs, costs money, and reports nothing -- because it is watching the wrong
workflow.** The one defect in this file with no error anywhere. `targetWorkflowId` scopes every
query the agent issues; point it at a workflow with no records in the window and every panel reads
empty, which the agent correctly reports as nothing to say, which is a `CancelledException`, which
is a cancelled step, which under `entryCondition: 1` publishes nothing. No error, no document, no
finding, a bill every five minutes, and a monitor that looks healthy in every panel an operator
would check.

Three ways to write it wrong, none of them caught:

- **The monitor's own id.** The most natural mistake, because every other id in this file is this
  graph's. The Analyst's own executions do live under the monitor's id, so the queries return
  *something* -- the agent reading its own mirror. Every processor here ships `Service:Name`
  `"processor"`, the Analyst included, so the panel queries' `must_not(orchestrator)` clause does
  not exclude it.
- **A well-formed id of a row that does not exist.** The `pattern` in `analyst-config` enforces
  UUID *shape*, and nothing resolves the id against the workflow table.
- **A wrong JSON type** -- an unquoted or non-string value. `ConfigSchemaConformance` compares the
  shape of the config *record* to the definition and has no opinion on `Guid`, so this is caught
  only by publish-time payload validation, not by the schema gate.

B3 is the only check that catches any of them.

**C2. A run fails or cancels and leaves no trace you thought to look for.** This graph has no
`record-outcome` step, so there is no row to read and no failures topic to drain. A failed run's
evidence is its step outcome in Elasticsearch and its log line; a **cancelled** run's evidence is
thinner still, because a cancel is not a failure and is logged at Information while failures are
Warnings. A log query filtered to Warning and above shows a clean system that is reporting nothing.
When in doubt, count fires against findings: the cron is deterministic, so 288 fires a day against
N documents on `skp-analyst-findings` is the whole story.

**C3. `422` naming a count of unhealthy processors.** The liveness gate reads per-replica
registrations out of Redis and requires at least one present, healthy and fresh replica for **every**
processor in the graph -- the Analyst *and* `kafka-exporter`. Precondition 4 and Appendix A coming
due: a processor that never found its row never registered, and will never say so on its own. If
this fires, read the Analyst pod's own log for the identity wait before touching the graph.

**C4. `422` naming a mismatched schema edge -- which should not happen here, and what it means if it
does.** The schema-edge gate compares the parent processor's `outputSchemaId` against the child's
`inputSchemaId` and demands the **same row id**, not the same content. On this graph's one edge the
parent's output is `<analyst-finding>` and the child `kafka-exporter`'s input is `null`, and a null
on either side passes. So this gate is satisfied by the null, not by agreement. If you see this
`422`, someone has given `kafka-exporter` a non-null `inputSchemaId` -- which the sibling document's
Appendix D warns about, because that row is shared and narrowing it breaks workflows that are not
this one.

**C5. `422` naming a payload that does not conform.** The payload gate validates each assignment's
`payload` against its processor's `configSchemaId` definition. `additionalProperties: false` is set
on both schemas, so an extra field fails as loudly as a missing one, and `analyst-config` requires
all seven properties. A `panelSet` entry that is not a registered panel id is **not** caught here --
it is an array of strings and passes -- and is caught by the processor instead, as a `Failed` step
naming the unknown ids.

**C6. `409` on the processor create.** You created `kafka-exporter` a second time instead of finding
the row that already holds `ba7df852...`. `sourceHash` is unique among rows with no `instanceId`.
Delete the duplicate and re-point the step; do not paper over it with a second row, because the
schema-edge gate compares ids and two byte-identical rows are two different rows.

**C7. The workflow starts, the cron is armed, and it never fires.** A workflow needs a cron **and**
an explicit start; with only one of the two the orchestrator logs nothing and looks broken. If step
8 returned `202` and nothing has fired after five minutes, re-read the `cronExpression` field count:
a 5-field expression is accepted and means something different from what you meant.

**C8. Every run fails the moment it starts thinking.** Non-2xx from the model API becomes
`AnalysisImpossibleException` becomes a `Failed` step. The usual cause is a spent account, and it
is the expected state of this deployment as written -- see precondition 7. It is loud on purpose: an
Analyst that could not run must not be indistinguishable from an Analyst that found nothing.

**C9. The prompt in the row is not the prompt the pods are using.** A running workflow reads the L2
projection from its start time, so editing the assignment changes nothing until the workflow is
restarted: the pods keep using the old prompt while the row shows the new one, and nothing reports
the disagreement. Edit the payload, **stop**, **start**, then confirm the `promptHash` on the next
finding changed. That hash is what makes a prompt change confirmable at all.

## Appendix D -- cost, and the one lever that matters

Read this before step 8.

Every five minutes is **288 investigations a day**. Thinking is always on and billed as output. A
modest 30k-in/3k-out run is a few cents, which is single-digit dollars a day and low hundreds a
month; a heavier 100k-in/10k-out run is several times that. Those figures move with the vendor's
pricing and are not worth reproducing precisely in a document that will be read later -- derive them
from the current rate and the token counts the findings report.

**The cron is by far the biggest lever.** `0 */30 * * * *` is 6x cheaper than the interval in step 7.
`0 0 * * * *` is 12x. Nothing about the graph changes; you are buying resolution, and a monitor that
reports every thirty minutes is still a monitor. Decide the interval on what an operator will
actually act on overnight, then set it once -- not the other way round.

Two smaller levers, both already set conservatively in section 6.1: `maxIterations` bounds turns and
`maxTokens` bounds accumulated tokens per dispatch. Both are ceilings on the worst case, not
targets, so lowering them makes runs fail rather than making them cheap. Change the cron.

**Before funding the account, run it broken once.** With a spent key every fire ends `Failed`
loudly, which costs nothing and proves the failure path reaches `Failed` instead of silence. That is
the cheapest test in this file and the only one that exercises C8.

# Rebuild the `analyst-monitor` workflow on a fresh BaseApi

You are an AI model on a machine with no access to the cluster this graph came from.
Everything you need is in this file. Follow it top to bottom.

**This workflow spends money on every fire.** Step 8 starts a cron that calls a paid model API
twice an hour, unattended, until someone stops it. Read Appendix D before you run step 8, not
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
one workflow, fired by cron twice an hour, at minutes `:09` and `:39`.

```
analyst-monitor              (analyst, Always)          <-- entry step; cron dispatches it
  |
  +-> analyst-finding-export     (kafka-exporter -> skp-analyst-findings, PreviousCompleted)
```

That is the whole graph. Four things about it are easy to get wrong, and only one of them is
caught by the API:

- **The export edge is `entryCondition: 1`, not `4`.** This is the single most consequential
  integer in this file. Every completed Analyst run is published -- a finding, or a `Quiet` or
  `Inconclusive` verdict -- and the Analyst never cancels. The one run that must NOT be published is
  a **failed** one: a facility broke and there is no document. Every sample step in the sibling
  document `rebuild-filefetcher-archiveexpander-chain.md` uses `4` (Always), and copying that habit
  here fires the exporter after a failure, where it receives no input and fails in turn.
- **There is no failure path and no `record-outcome`.** The sibling chain wires every step to an
  outcome recorder; this one wires nothing. That is deliberate -- a two-step monitor whose failures
  are already one query away does not need a fan-in -- but it means a failed run leaves no row and
  no document anywhere, only a step outcome in Elasticsearch and a log line. Appendix C2.
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
     `56c32dfb727f56bfc2109a122f7a20f1c49334b4e49213bec853b9e2d5ed8297`. Record its id as
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
  "version": "3.0.0",
  "description": "Analyst output document v3: every run whose facilities worked is published. Drifting/Notable carry correlated insights; Quiet (nothing correlated into anything wrong) and Inconclusive (evidence judged unbelievable) carry a reason instead. A facility failure fails the step and publishes nothing.",
  "definition": "{\n  \"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n  \"title\": \"Analyst finding v3\",\n  \"type\": \"object\",\n  \"properties\": {\n    \"verdict\": {\n      \"type\": \"string\",\n      \"enum\": [\n        \"Drifting\",\n        \"Notable\",\n        \"Quiet\",\n        \"Inconclusive\"\n      ],\n      \"description\": \"Drifting and Notable carry at least one insight. Quiet means the analysis ran and nothing correlated into anything wrong; Inconclusive means the model judged the evidence it got back unbelievable. All four are published: every run whose facilities worked completes and exports a document, and only a facility failure fails the step and publishes nothing.\"\n    },\n    \"target\": {\n      \"type\": \"object\",\n      \"properties\": {\n        \"workflowId\": {\n          \"type\": \"string\",\n          \"format\": \"uuid\"\n        },\n        \"name\": {\n          \"type\": [\n            \"string\",\n            \"null\"\n          ]\n        }\n      },\n      \"required\": [\n        \"workflowId\",\n        \"name\"\n      ],\n      \"additionalProperties\": false,\n      \"description\": \"The workflow investigated. name is read from L2 at export time and is null when it could not be read; workflowId is authoritative.\"\n    },\n    \"window\": {\n      \"type\": \"object\",\n      \"properties\": {\n        \"from\": {\n          \"type\": \"string\",\n          \"format\": \"date-time\"\n        },\n        \"to\": {\n          \"type\": \"string\",\n          \"format\": \"date-time\"\n        },\n        \"samplesExamined\": {\n          \"type\": \"integer\",\n          \"minimum\": 0\n        }\n      },\n      \"required\": [\n        \"from\",\n        \"to\",\n        \"samplesExamined\"\n      ],\n      \"additionalProperties\": false,\n      \"description\": \"The REALIZED window, not the configured one. Precision here is what lets two consecutive answers be compared, which is the only liveness signal a stateless agent has. format:date-time on from/to is documentation only -- ProcessorJsonSchemaValidator does not set RequireFormatValidation, so it is never enforced. No pattern is added either: unlike a hand-authored payload field, these values come from this processor's own serializer writing DateTimeOffset, so the only way they could be malformed is a bug in code we already test; the actual guarantee is the serializer, not this schema.\"\n    },\n    \"reason\": {\n      \"type\": [\n        \"string\",\n        \"null\"\n      ],\n      \"description\": \"Why there is no insight: set on Quiet and Inconclusive, null on Drifting and Notable.\"\n    },\n    \"insights\": {\n      \"type\": \"array\",\n      \"minItems\": 0,\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"claim\": {\n            \"type\": \"string\",\n            \"minLength\": 1\n          },\n          \"why\": {\n            \"type\": \"string\",\n            \"minLength\": 1\n          },\n          \"panels\": {\n            \"type\": \"array\",\n            \"minItems\": 2,\n            \"uniqueItems\": true,\n            \"items\": {\n              \"type\": \"string\",\n              \"minLength\": 1\n            }\n          }\n        },\n        \"required\": [\n          \"claim\",\n          \"why\",\n          \"panels\"\n        ],\n        \"additionalProperties\": false\n      },\n      \"description\": \"What the analyst inferred, never what a panel showed. Each insight correlates at least two panels into a cause, a consequence or a contradiction no single panel shows; the readings themselves live in evidence. Non-empty exactly on Drifting and Notable.\"\n    },\n    \"evidence\": {\n      \"type\": \"array\",\n      \"minItems\": 0,\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"panelId\": {\n            \"type\": \"string\",\n            \"minLength\": 1\n          },\n          \"layer\": {\n            \"type\": \"string\",\n            \"minLength\": 1\n          },\n          \"label\": {\n            \"type\": \"string\",\n            \"minLength\": 1\n          },\n          \"value\": {\n            \"type\": \"string\"\n          }\n        },\n        \"required\": [\n          \"panelId\",\n          \"layer\",\n          \"label\",\n          \"value\"\n        ],\n        \"additionalProperties\": false\n      }\n    },\n    \"ruledOut\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"hypothesis\": {\n            \"type\": \"string\",\n            \"minLength\": 1\n          },\n          \"disconfirmingCriterion\": {\n            \"type\": \"string\",\n            \"minLength\": 1\n          },\n          \"whatWasSeen\": {\n            \"type\": \"string\",\n            \"minLength\": 1\n          }\n        },\n        \"required\": [\n          \"hypothesis\",\n          \"disconfirmingCriterion\",\n          \"whatWasSeen\"\n        ],\n        \"additionalProperties\": false\n      }\n    },\n    \"trace\": {\n      \"type\": \"array\",\n      \"minItems\": 1,\n      \"items\": {\n        \"type\": \"object\",\n        \"properties\": {\n          \"ordinal\": {\n            \"type\": \"integer\",\n            \"minimum\": 1\n          },\n          \"panelId\": {\n            \"type\": \"string\",\n            \"minLength\": 1\n          },\n          \"dataReturned\": {\n            \"type\": \"boolean\"\n          }\n        },\n        \"required\": [\n          \"ordinal\",\n          \"panelId\",\n          \"dataReturned\"\n        ],\n        \"additionalProperties\": false\n      },\n      \"description\": \"How a reader tells 'checked and it was clean' from 'never looked'. Without it a wrong conclusion is unauditable.\"\n    },\n    \"usage\": {\n      \"type\": \"object\",\n      \"properties\": {\n        \"calls\": {\n          \"type\": \"integer\",\n          \"minimum\": 0\n        },\n        \"inputTokens\": {\n          \"type\": \"integer\",\n          \"minimum\": 0\n        },\n        \"outputTokens\": {\n          \"type\": \"integer\",\n          \"minimum\": 0\n        },\n        \"elapsedSeconds\": {\n          \"type\": \"integer\",\n          \"minimum\": 0\n        },\n        \"budget\": {\n          \"type\": \"object\",\n          \"properties\": {\n            \"maxIterations\": {\n              \"type\": \"integer\",\n              \"minimum\": 1\n            },\n            \"maxTokens\": {\n              \"type\": \"integer\",\n              \"minimum\": 1\n            },\n            \"wallClockSeconds\": {\n              \"type\": \"integer\",\n              \"minimum\": 1\n            }\n          },\n          \"required\": [\n            \"maxIterations\",\n            \"maxTokens\",\n            \"wallClockSeconds\"\n          ],\n          \"additionalProperties\": false\n        },\n        \"dispatch\": {\n          \"type\": [\n            \"object\",\n            \"null\"\n          ],\n          \"properties\": {\n            \"calls\": {\n              \"type\": \"integer\",\n              \"minimum\": 0\n            },\n            \"inputTokens\": {\n              \"type\": \"integer\",\n              \"minimum\": 0\n            },\n            \"outputTokens\": {\n              \"type\": \"integer\",\n              \"minimum\": 0\n            }\n          },\n          \"required\": [\n            \"calls\",\n            \"inputTokens\",\n            \"outputTokens\"\n          ],\n          \"additionalProperties\": false\n        }\n      },\n      \"required\": [\n        \"calls\",\n        \"inputTokens\",\n        \"outputTokens\",\n        \"elapsedSeconds\",\n        \"budget\",\n        \"dispatch\"\n      ],\n      \"additionalProperties\": false,\n      \"description\": \"calls/tokens/elapsedSeconds are the investigation's own spend, the thing budget limits. dispatch is everything the dispatch spent at the model, the fitness gate included, which the budget does not cover; null only where no meter is wired.\"\n    },\n    \"promptHash\": {\n      \"type\": \"string\",\n      \"minLength\": 1\n    }\n  },\n  \"required\": [\n    \"verdict\",\n    \"target\",\n    \"window\",\n    \"reason\",\n    \"insights\",\n    \"evidence\",\n    \"ruledOut\",\n    \"trace\",\n    \"usage\",\n    \"promptHash\"\n  ],\n  \"allOf\": [\n    {\n      \"if\": {\n        \"properties\": {\n          \"verdict\": {\n            \"enum\": [\n              \"Drifting\",\n              \"Notable\"\n            ]\n          }\n        }\n      },\n      \"then\": {\n        \"properties\": {\n          \"insights\": {\n            \"minItems\": 1\n          },\n          \"evidence\": {\n            \"minItems\": 1\n          },\n          \"reason\": {\n            \"type\": \"null\"\n          }\n        }\n      },\n      \"else\": {\n        \"properties\": {\n          \"insights\": {\n            \"maxItems\": 0\n          },\n          \"reason\": {\n            \"type\": \"string\",\n            \"minLength\": 1\n          }\n        }\n      }\n    }\n  ],\n  \"additionalProperties\": false\n}\n"
}
```

Record the returned id as `<analyst-finding>`.

This is **version 3.0.0**. Version 1.0.0 carried a free-text `narrative`; version 2.0.0 had only
the two finding verdicts. Older rows may exist on a database rebuilt from an older copy of this
file, but nothing references them and nothing should.

**The step result reports whether the facilities worked, never what the model concluded**, and
every run whose facilities worked is published:

| verdict | when | `insights` | `reason` |
|---|---|---|---|
| `Drifting` / `Notable` | at least one correlated insight | 1 or more | `null` |
| `Quiet` | the analysis ran; nothing correlated into anything wrong | empty | what killed each hypothesis |
| `Inconclusive` | the model judged the evidence the sources returned unbelievable | empty | why |

All four are a **Completed** step and a document on `skp-analyst-findings`. A payload, model or
panel source that did not work -- or a reply that is not a valid result -- throws `FailedException`:
a **Failed** step and no document. The Analyst never cancels. So a fire with no document on the
topic means the monitor did not run, never that it found nothing; `Quiet` is the all-clear, and it
is published. The `allOf` at the end of the definition enforces the pairing in the table: a finding
must have an insight and no reason, the other two a reason and no insight.

Three fields carry the contract beyond the verdict:

- **`insights`** is the point of a finding. Each insight is a `claim`, the `why` that connects it,
  and the `panels` it correlates -- **at least two, distinct**, and every one of them must have
  actually been read (the processor checks the panels against its own trace and refuses the
  finding otherwise). A reading restated, or a list of what is healthy, is not an insight: the
  operator already has the dashboards. The same rule governs `reason`: it says what killed each
  hypothesis, not what was healthy.
- **`target`** is the workflow investigated: `workflowId` from the payload, and `name` read from L2
  at export time -- `null` if that read fails, because a display name must never cost a document.
- **`usage`** is what the run cost. `calls`, `inputTokens`, `outputTokens` and `elapsedSeconds` are
  the investigation's own spend, which is what `budget` (copied from the payload) limits. `dispatch`
  is everything the dispatch spent at the model, the fitness gate included -- which runs before the
  investigation and **outside** its budget, so it is usually the larger number. Appendix D.

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
  "sourceHash": "cfc12ba191b57e5a6e9b675b43329a9b6270055598c88f888f97d8251bf926ae",
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
publishing is honest, and since the Analyst never cancels, it fires on every run that produced a
document -- findings, `Quiet` and `Inconclusive` alike. Under `4` this step also fires when the
Analyst **failed** -- the model was unreachable, the account was spent, a panel source could not be
reached -- and receives no document, so the export fails in turn and a facility failure turns into
two failures in the boards. Under `2` it would publish only on failures, which is the mistake
inverted; `3` never fires at all. Send `1`.

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
  "payload": "{\"prompt\": \"You are reviewing a document-processing chain to decide whether anything in this window deserves an operator's attention tonight. Work through five stages in order. Do not begin a stage before the one before it is finished. No stage but the last may decide that something is or is not worth reporting; the earlier stages observe, judge the evidence, plan, and gather, and nothing else.\\n\\nSTAGE 1 - RESEARCH. Orient yourself before explaining anything, and do it with exactly ONE read: step-outcomes. Record what it returned - the value, how much of the window it covers, and whether it returned a series at all. Form no hypothesis during this stage: observations first, explanations later.\\n\\nRead nothing else here, and this restraint is mechanical rather than stylistic. A panel you read in this stage can never afterwards serve as a disconfirming criterion, because a criterion whose evidence is already in hand was written after the answer was known. Every panel you spend a read on now is a panel you have disqualified as evidence. step-outcomes is spent deliberately, to tell you where to look; the other six stay unread and therefore stay usable. A panel you did not read is not a panel that said nothing.\\n\\nSTAGE 2 - VALIDATE. Decide whether evidence can be believed, and never carry an observation forward until you have. This stage defines a rule you apply to EVERY observation at the moment you make it: to the stage 1 read now, and to each stage 4 read as it arrives. It is not a one-time pass over stage 1, because most of the evidence does not exist yet - classify each later read the instant you have it, before it can influence anything. Every observation, whenever it is made, falls into exactly one of these five cases, and they are exhaustive:\\n\\n(a) BELIEVABLE - the panel returned a value, it covers the window, and the value means what it says.\\n(b) DEMONSTRABLY NOTHING - the panel returned no series, and another believable observation shows the thing it measures did not happen.\\n(c) UNREADABLE ABSENCE - the panel returned no series, and you cannot tell \\\"nothing happened\\\" apart from \\\"nothing was reported\\\".\\n(d) UNREADABLE READING - the panel returned a value, but the value cannot be believed: it covers only part of the window, it is scoped to something other than what you are asking about, or its read carries a trust flag.\\n(e) DEMONSTRABLY NOT REPORTING - the panel returned no series, and another believable observation shows the thing it measures DID happen. The absence is then a fact about the instrument, not about the system.\\n\\nTreat trust flags on panel reads as facts about the evidence, not about the system. For every observation in case (c), (d) or (e) you must STOP using it as evidence about the system: you may not carry it forward, you may not read it as health, and you may not guess which way it falls. A queue missing from the dead-letter panel entirely is case (c) unless another believable observation makes it case (e); either way it is not a queue that is empty.\\n\\nSTAGE 3 - PLAN. Now, and only now, write down every hypothesis worth testing, each with its disconfirming criterion: the specific observation that would KILL that hypothesis. Fix each criterion by asking what would have to be true for the hypothesis to be false, and fix it without tailoring it to what stage 1 happened to record. Once written, do not weaken, widen or reword it; comparing it against the evidence happens in stage 5 and nowhere earlier. A hypothesis with no stated criterion that could kill it is not admissible and must be dropped here and now.\\n\\nA criterion may only name a panel you have not yet read. step-outcomes was spent in stage 1 and is therefore disqualified: it may inform which hypotheses are worth raising, but it may never be the evidence that kills one. If the only criterion you can state for a hypothesis names an already-read panel, that hypothesis is not admissible either - drop it, or find a criterion on a panel still unread.\\n\\nTwo hypotheses are always planned and never skipped:\\n\\n1. THIS DEPLOYMENT THREW WORK AWAY IN THIS WINDOW. Two things kill it. Either every queue listed on the dead-letter depth panel read zero, as a case (a) observation; or every queue above zero held the same depth from the start of the window to its end, as a case (a) observation, while refused-messages showed no parked refusal and run-boundaries showed fires finishing - then nothing was thrown away in this window and the depth is a backlog from before it. A depth that grew during the window is never killed this way, and neither a small depth nor the panel being case (c), (d) or (e) kills it.\\n2. AN INSTRUMENT THAT SHOULD REPORT IS NOT REPORTING. The only thing that kills it: every panel you read in stage 4 yielded a case (a) or case (b) observation. Scope this criterion to the unread panels only; step-outcomes is excluded from it, having been spent in stage 1.\\n\\nOther hypotheses worth planning include: a trend in step outcomes, a repeated failure, a step-outcome mix that changed, and the workflow not firing at all. A single slow step is not a hypothesis worth planning; a trend, a repeated failure, or a changed mix is.\\n\\nSTAGE 4 - EXECUTE. Gather exactly the evidence each stated criterion calls for, hypothesis by hypothesis. Classify every read against the stage 2 taxonomy as you make it, and record the case alongside the value; an unclassified reading may not be used in stage 5. Reach no conclusion here; only collect, read and classify. The rules below define what each datum means in this deployment. They are definitions of meaning, not verdicts: none of them decides that anything is worth reporting, and that decision belongs to stage 5 alone.\\n\\n- Dead-letter depth is a level with no attribution. Refused-messages are events in this window scoped to this workflow, and the exception on a sample is why the message was refused. They are two halves of one picture, not duplicates of each other.\\n- Refused-messages under-reports by construction: a refusal carrying no workflow id never reaches that panel at all. A zero on it therefore never overrides a non-zero depth, and the two disagreeing is not a contradiction to resolve nor a reason to disbelieve either panel.\\n- Because of that under-reporting, depth above zero with no refusals in window leaves the age and ownership of that work unknown. It is consistent with work lost before this window or belonging to another workflow, but does not establish it; record the age and ownership as unknown unless a case (a) observation settles them. A depth that sat flat from the start of the window to its end is such an observation for age: that work was lost before the window.\\n- Among refusals in window, a refusal whose template is a park denotes work lost now. A notParked refusal was redelivered: it denotes no loss and it sits in no dead-letter queue. Exclude notParked refusals before reading the refusal count as loss.\\n- run-boundaries: entry is the fires that entered in this window; terminal is every branch end of those fires, however far they fanned out. Terminals of fires that entered before the window are not counted. There is no fixed ratio between the two: terminals per fire follow from this workflow's graph and from how many records each fire imported, so a busy window and an idle one read very differently and both are healthy. The one unambiguous finding is entry above zero with terminal at zero - fires go out and nothing ends. Never explain that away with drainedPolls: an importer poll that finds nothing reports Cancelled, which is that fire's terminal, so a fire with no terminal is work that started and did not finish. Entry at zero means the workflow did not fire.\\n- THE GRAPH OF THIS WORKFLOW (filefetcher-archiveexpander-chain, as of 2026-10-01) decides what the business panels should show. Each record the importer reads follows one path: a good record forks at sk-normalizer-sample into two branches that both end at split-exporter, so it ends twice; a record that fails at any step goes to record-outcome and then export-outcome and ends once; a record that is cancelled (its artist is not on the whitelist) ends once, where it was cancelled. An importer poll that reads nothing ends once, as Cancelled.\\n- From that graph: run-boundaries terminal, minus step-outcomes Failed, minus step-outcomes Cancelled, is twice the number of good records, so it is even and not negative. A few either way can come from runs that straddle the window edges; a larger shortfall is branches that started and did not end.\\n- From that graph: step-outcomes Completed is not a success rate. A good record contributes eleven Completed records, because the steps after the fork run twice, and every failure adds two more in record-outcome and export-outcome, so the Completed share moves with the mix of records, not with health.\\n- The graph is the definition as it stands now. A run uses the definition from its workflow's last start, so a recent edit can put the graph ahead of the run. What a step does inside it, such as which step can cancel and why, is not in the graph.\\n\\nSTAGE 5 - VERIFY. Judge each hypothesis from stage 3 against the disconfirming criterion you stated for it there, not against a criterion you have since adjusted. A hypothesis whose criterion was met is dead: say so and drop it. A surviving hypothesis is reportable only if every observation it rests on was case (a), with one exception: the instrumentation hypothesis is reportable on case (e) evidence, because a proven reporting failure is what that hypothesis is about. A hypothesis that survives only on case (c) or case (d) evidence is not a finding and contributes nothing.\\n\\nA surviving hypothesis becomes a finding only as an insight: an inference that correlates at least two panels into a cause, a consequence, or a contradiction that no single panel shows. A reading restated is not an insight, and neither is a list of what is healthy - the operator already has the dashboards. If what survives cannot be correlated into an insight, report no finding.\\n\\nYou must be able to end here with nothing. If every hypothesis is dead, then nothing contributes: say so plainly and report no finding. Concluding that the window is quiet is a valid and expected result, not a failure to find something.\", \"panelSet\": [\"step-outcomes\", \"step-failures\", \"refused-messages\", \"run-boundaries\", \"queue-wait\", \"processor-liveness\", \"dead-letter-depth\"], \"maxTokens\": 1500000, \"maxIterations\": 12, \"windowMinutes\": 15, \"targetWorkflowId\": \"1a56b3ca-e276-4815-87fa-5c2f48ab6dad\", \"wallClockSeconds\": 600}"
}
```

Record the returned id as `<asg:analyst-monitor-cfg>`.

The `targetWorkflowId` in that payload is the live id this file was written against. **Replace it
with `<target-workflow>`.** If you leave it, and that row does not exist on your database, you get
no error from anywhere -- see C1.

**The prompt is `tools/analyst-prompt-v9.txt`**, verbatim. If that file is on the machine you are
rebuilding on, prefer generating the payload from it over trusting the escaping above. Every prompt
edit changes the `promptHash` the fitness gate (the BIT) caches on, so the first dispatch after an
edit -- and the first on every freshly started pod -- pays for the gate again. Appendix D.

Four numbers in that payload are chosen against ceilings that are compiled, not configured:

- `wallClockSeconds: 600` bounds the **investigation only**, as one total for every model turn and
  panel read together -- not per model response. There is no per-response timeout: the model client
  runs with an infinite HTTP timeout on purpose, and this deadline is the only thing that ends a call
  early, by cutting whichever call is in flight when it passes. 240 was tried first and was too
  tight for this model: on 2026-10-01 an investigation was cut mid-call at exactly 240 seconds and
  the step failed. The fitness gate runs before the investigation and outside this budget -- on a
  fresh pod it has taken about ten minutes on its own -- so a whole dispatch can run for twenty.
  That is why fires are thirty minutes apart, not five: a shorter interval can have the next fire
  arrive while the last is still running.
- `maxTokens: 1500000` sits under the compiled `MaxTokenBudget` of `10_000_000`
  (`AnalystProcessor.cs`), which is itself paired with the manifest's `384Mi` memory limit rather
  than being a free number -- one dispatch accumulates its whole transcript in memory. A payload
  above the ceiling is refused by the processor, not by a gate.
- `maxIterations: 12` is the ceiling on model turns. Exhaustion with no terminal tool call is a
  **failed** step, never a quiet one.
- `windowMinutes: 15` is the window each dispatch reads, measured back from when the investigation
  starts -- not from the fire, which the gate can precede by minutes. The agent is stateless across
  dispatches, so this window is the only history it has; with fires thirty minutes apart, half of
  each half-hour is read by nothing.

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
  "description": "Analyst -> KafkaExporter. Investigates filefetcher-archiveexpander-chain every thirty minutes and publishes any finding to skp-analyst-findings.",
  "entryStepIds": [
    "<step:analyst-monitor>"
  ],
  "assignmentIds": [
    "<asg:analyst-monitor-cfg>",
    "<asg:analyst-finding-export-cfg>"
  ],
  "cacheIds": null,
  "cronExpression": "0 9,39 * * * *"
}
```

Record the returned id as `<workflow>`.

`cacheIds` is `null`: this graph projects no dictionary into L2. The sibling chain's cache is not
shared with it and must not be named here.

**`cronExpression` is six-field, seconds first.** `0 9,39 * * * *` is second `0` of minutes 9 and
39 of every hour. The validator accepts 5- or 6-field expressions and picks the format **by field count**,
which is what makes this field one keystroke from a disaster: `*/9 * * * * *` is also six fields
and means every 9 **seconds** -- several paid investigations a minute. Count the fields before you
send, and count them again after any edit.

## Step 8 -- start the workflow

**Stop. Read Appendix D.** Creating the rows above runs nothing and costs nothing. This request is
what begins spending money twice an hour, unattended, until someone issues the stop.

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
**2026-10-01**, when the finding contract moved to v3, and agreed two independent ways: it is what the
live row holds, and it is what the fold in `SourceHash.targets` computes over `src/Processor.Analyst`.
It has moved five times in a week -- `29ea6590...` (2026-09-26, in `docs/task-16-analyst-monitor.http`),
`7f126f9e...` (2026-09-28), `28bbcd10...`, `c2196668...` (finding v2) and now `cfc12ba1...`
(finding v3, no-finding verdicts published) -- and nothing announced any of it.
Every request in this file still returns `201` with a stale value, its counts still match, and the
graph still starts, because **no gate reads a `sourceHash`** -- only a processor does, by waiting. If
you are rebuilding from an older copy of this file or from that `.http` file, re-derive the hash
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
  there must still be exactly one processor row whose `sourceHash` is `56c32dfb...`
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
empty, which the agent correctly reports as nothing to say -- a `Quiet` verdict, published. No
error, a well-formed all-clear on the topic every half hour, a bill for each, and a monitor that
looks healthy in every panel an operator would check. `target.workflowId` on each document names
what it actually watched, so the topic itself shows the mistake to anyone who reads that field.

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

**C2. A run fails and leaves no trace you thought to look for.** This graph has no
`record-outcome` step, so there is no row to read and no failures topic to drain. A failed run's
evidence is its step outcome in Elasticsearch and its log line, and **nothing on the topic** -- the
Analyst publishes a document on every run that worked, so a fire with no document is a failure or
a fire that never happened. When in doubt, count fires against documents: the cron is
deterministic, so 48 fires a day against 48 documents on `skp-analyst-findings` is a healthy day,
and every missing one is a run to look for in the step outcomes.

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
the row that already holds `56c32dfb...`. `sourceHash` is unique among rows with no `instanceId`.
Delete the duplicate and re-point the step; do not paper over it with a second row, because the
schema-edge gate compares ids and two byte-identical rows are two different rows.

**C7. The workflow starts, the cron is armed, and it never fires.** A workflow needs a cron **and**
an explicit start; with only one of the two the orchestrator logs nothing and looks broken. If step
8 returned `202` and nothing has fired by the next `:09` or `:39`, re-read the `cronExpression` field count:
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

Twice an hour is **48 dispatches a day**. Thinking is always on and billed as output. Each document
reports its own cost in `usage` -- read `usage.dispatch`, not the investigation's own figures, because
the fitness gate is outside the budget and is often most of the bill. On 2026-10-01 single dispatches
ran 364k-551k tokens over 27-30 model calls; the largest of those included a fresh gate on a pod that
had just restarted. A dispatch that fails publishes nothing, so its cost is only in the pod's log
line `the dispatch spent N call(s), ...`. Prices move with the vendor and are not worth reproducing
here -- derive them from the current rate and those counts.

**The gate is paid once per prompt per pod.** Its verdict is cached in memory and dies with the
process, so every rollout, every pod restart and every prompt edit pays it again, on each replica.
Batch prompt edits, and do not restart the Analyst to "refresh" anything.

**The cron is still the biggest lever.** `0 9 * * * *` is half the cost of the interval in step 7.
Nothing about the graph changes; you are buying resolution, and a monitor that reports hourly is
still a monitor. Decide the interval on what an operator will actually act on overnight, then set it
once -- not the other way round.

Two smaller levers, both set in section 6.1: `maxIterations` bounds turns and `maxTokens` bounds
accumulated tokens per investigation. Both are ceilings on the worst case, not targets, so lowering
them makes runs fail rather than making them cheap. Change the cron.

**Before funding the account, run it broken once.** With a spent key every fire ends `Failed`
loudly, which costs nothing and proves the failure path reaches `Failed` instead of silence. That is
the cheapest test in this file and the only one that exercises C8.

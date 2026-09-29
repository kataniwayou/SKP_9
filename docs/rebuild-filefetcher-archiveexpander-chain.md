# Rebuild the `filefetcher-archiveexpander-chain` workflow on a fresh BaseApi

You are an AI model on a machine with no access to the cluster this graph came from.
Everything you need is in this file. Follow it top to bottom.

## How to use this file

- Every request goes to the BaseApi you were given. Base URL below is written `{API}`.
- **Row ids are irrelevant.** The originals are deliberately not in this file. Each `POST`
  returns a new `id`; you record it against the slug the step names, and substitute it wherever
  a later body writes `<slug>`. Nothing else has to match.
- **Values are what must match.** Names, versions, descriptions, schema definitions, entry
  conditions and payloads are reproduced verbatim. Send them byte for byte, including the
  `--` sequences and the escaping inside `definition` and `payload`.
- Do the steps in order. The order is forced by foreign keys, not by taste: a step needs its
  processor, a processor needs its schemas, an assignment needs its step, the workflow needs
  both. Step 5 exists because a fan-in cannot be written in one pass.
- If a request fails, stop and read Appendix C before retrying. Most failures here are one of
  nine known shapes and retrying unchanged fixes none of them.

## The graph you are building

Ten steps, eight processors, ten schemas, one cache, one workflow, fired by cron every 30 seconds
at `:05` and `:35`.

The cache is the one row that is not part of the graph and still belongs to it: a named
dictionary the workflow references, projected into L2 when the workflow starts and deleted when
it stops. Nothing walks to it from a step. `sk-normalizer`'s Acme handler reaches it by the root
named on its own step payload, composing the rest of the address from the workflow id its dispatch
already carries.

The success path runs left to right. Every step on it also has a second edge, to
`record-outcome` — which records whatever outcome dispatched it and never learns which one, so the
edge below is taken only when that step fails because THIS chain wires it at `entryCondition: 2`:

```
split-importer            (kafka-importer, Always)
  └─> split-filefetcher        (file-fetcher)
       └─> split-archiveexpander    (archive-expander)
            └─> sk-normalizer-sample     (sk-normalizer, handler Acme)
                 ├─> sk-normalizer-alphabeta  (sk-normalizer, handler AlphaBeta)
                 │     └─> split-archivecollapser
                 └─> split-archivecollapser   (archive-collapser)
                      └─> split-filepersister     (file-persister)
                           └─> split-exporter         (kafka-exporter -> skp-documents)

  every step above --(on failure)--> record-outcome (outcome-recorder)
                                       └─> export-outcome (kafka-exporter -> skp-failures)
```

Three things about this shape are easy to get wrong and are checked by the API at start:

- `split-archivecollapser` is reached from **two** parents — `sk-normalizer-sample` directly and
  `sk-normalizer-alphabeta` after it. That is a diamond, not a cycle, and it is intentional.
- `record-outcome` is a fan-in from eight parents — every step on the success path. It is the reason
  the edges are written in a second pass. Not nine: `export-outcome` is `record-outcome`'s own child
  and points at nothing, so it is the one step on the graph that does not name it.
- `sk-normalizer` appears **twice**, as two steps on one processor row. Do not create the
  processor twice — `sourceHash` is unique and the second create returns 409.

## Step 1 — preconditions

Before the first request, confirm all five. Do not start without them.

1. **BaseApi is reachable and the database is migrated.**
   `GET {API}/api/v1/workflows` must return `200` and a JSON array. A `404` means the route
   prefix is wrong: the entity routes are plural and version-segmented — `/api/v1/schemas`,
   `/api/v1/processors`, `/api/v1/steps`, `/api/v1/assignments`, `/api/v1/workflows`.

2. **The database has none of these rows yet.** All six lists should be empty — the five entity
   routes above plus `/api/v1/caches` — or at least free of a processor whose `sourceHash`
   matches one in step 3 and of a cache whose `root` matches step 6b. If rows exist from a
   previous attempt, delete them in reverse dependency order (workflow, assignments, steps,
   processors, schemas, caches) — schema, processor and cache deletes are all `RESTRICT`, so a
   half-built graph will refuse to unwind out of order and tell you which reference is holding
   it. The cache comes last because the workflow's junction row is what pins it.

3. **The eight processor services are deployed and running.** They do not create their own rows.
   Each one asks the API, over the broker, for the row matching its embedded `sourceHash`, and
   **waits forever until it exists** — a processor sitting at `Running`/`NotReady` with zero
   restarts before step 3 is correct behaviour, not a fault. After step 3 they resolve and
   register. Before that, step 8 cannot succeed.

4. **Redis and the broker are up.** Step 8 reads per-replica liveness out of Redis; the
   processors' identity handshake goes over the broker.

5. **The output folder exists and the three topics exist.** Neither is a row, so no gate looks at
   either and step 8 returns `202` without them — both fail later, per document, and neither failure
   resembles its cause.
   - `/mnt/skp-files/out`, the folder §6.9 writes into, **must already exist on the FilePersister
     pod's mount.** The processor refuses to create it, because an absent folder means the volume is
     not mounted rather than that a directory is missing: `FolderPath '…' does not exist; this
     processor does not create it`. Every persist then fails and takes the `record-outcome` edge.
   - `skp-paths`, `skp-documents` and `skp-failures` must exist on the broker. This repo does not
     rely on `auto.create.topics.enable` — it defaults on, but it is a broker setting this repo does
     not own, so a chain that depends on it breaks when someone else turns it off. An absent
     `skp-paths` presents exactly as C6: the cron fires, nothing is imported, and nothing anywhere
     is an error.

## Step 2 — create the 10 schema rows

`POST /api/v1/schemas` once per row, in any order — schemas reference nothing. Record the returned `id` against the slug in the left column; every later body needs it.

### 2.1 `file-locator`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "file-locator",
  "version": "1.0.0",
  "description": "KafkaImporter output = FileFetcher input: the absolute path of one file. Does NOT assert absoluteness -- Path.IsPathFullyQualified is platform-dependent and no regex approximates it.",
  "definition": "{\"type\": \"object\", \"$schema\": \"https://json-schema.org/draft/2020-12/schema\", \"required\": [\"filePath\"], \"properties\": {\"filePath\": {\"type\": \"string\", \"minLength\": 1}}, \"additionalProperties\": false}"
}
```

Record the returned id as `<file-locator>`.

### 2.2 `kafka-importer-config`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "kafka-importer-config",
  "version": "1.0.0",
  "description": "KafkaImporter step payload: which topic to drain, under which group, and the two bounds the framework's ImporterConfig enforces. The broker is NOT here -- it is an address, so it lives in Kafka__BrokerList in the manifest.",
  "definition": "{\"type\": \"object\", \"$schema\": \"https://json-schema.org/draft/2020-12/schema\", \"required\": [\"topic\", \"consumerGroup\", \"messageCount\", \"idleTimeoutSeconds\"], \"properties\": {\"topic\": {\"type\": \"string\", \"minLength\": 1}, \"messageCount\": {\"type\": \"integer\", \"minimum\": 1}, \"consumerGroup\": {\"type\": \"string\", \"minLength\": 1}, \"idleTimeoutSeconds\": {\"type\": \"integer\", \"minimum\": 1}}, \"additionalProperties\": false}"
}
```

Record the returned id as `<kafka-importer-config>`.

### 2.3 `file-envelope`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "file-envelope",
  "version": "1.0.0",
  "description": "FileFetcher output = ArchiveExpander input: the file identity plus base64 content",
  "definition": "{\"type\": \"object\", \"$schema\": \"https://json-schema.org/draft/2020-12/schema\", \"required\": [\"fileName\", \"extension\", \"sizeBytes\", \"createdUtc\", \"modifiedUtc\", \"content\"], \"properties\": {\"content\": {\"type\": \"string\"}, \"fileName\": {\"type\": \"string\", \"minLength\": 1}, \"extension\": {\"type\": \"string\"}, \"sizeBytes\": {\"type\": \"integer\", \"minimum\": 0}, \"createdUtc\": {\"type\": [\"string\", \"null\"]}, \"modifiedUtc\": {\"type\": [\"string\", \"null\"]}}, \"additionalProperties\": false}"
}
```

Record the returned id as `<file-envelope>`.

### 2.4 `file-fetcher-config`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "file-fetcher-config",
  "version": "1.0.0",
  "description": "FileFetcher step payload: everything knowable from FileInfo before the file is opened. allowedExtensions entries carry a leading dot or are the '*.*' sentinel; absent, null or empty widens to ['*.*']. minimumSizeBytes 0 disables the floor.",
  "definition": "{\"type\": \"object\", \"$schema\": \"https://json-schema.org/draft/2020-12/schema\", \"required\": [\"minimumSizeBytes\", \"maximumSizeBytes\"], \"properties\": {\"maximumSizeBytes\": {\"type\": \"integer\", \"minimum\": 1}, \"minimumSizeBytes\": {\"type\": \"integer\", \"minimum\": 0}, \"allowedExtensions\": {\"type\": [\"array\", \"null\"], \"items\": {\"type\": \"string\", \"minLength\": 1}}}, \"additionalProperties\": false}"
}
```

Record the returned id as `<file-fetcher-config>`.

### 2.5 `archive-document`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "archive-document",
  "version": "3.0.0",
  "description": "ArchiveExpander output = ArchiveCollapser input: one self-referencing node, any depth. Supersedes archive-document v2.0.0, which unrolled the same shape to a fixed depth 2 and is frozen. The depth ceiling is now MaxDepth alone -- there is no second number for a step payload to disagree with.",
  "definition": "{\"$ref\": \"#/$defs/node\", \"$defs\": {\"node\": {\"type\": \"object\", \"required\": [\"metadata\", \"content\"], \"properties\": {\"content\": {\"type\": [\"string\", \"array\", \"null\"], \"items\": {\"$ref\": \"#/$defs/node\"}}, \"metadata\": {\"$ref\": \"#/$defs/metadata\"}}, \"additionalProperties\": false}, \"metadata\": {\"type\": \"object\", \"required\": [\"name\", \"extension\", \"sizeBytes\", \"createdUtc\", \"modifiedUtc\", \"entryCount\"], \"properties\": {\"name\": {\"type\": \"string\", \"minLength\": 1}, \"extension\": {\"type\": \"string\"}, \"sizeBytes\": {\"type\": \"integer\", \"minimum\": 0}, \"createdUtc\": {\"type\": [\"string\", \"null\"]}, \"entryCount\": {\"type\": \"integer\", \"minimum\": 0}, \"modifiedUtc\": {\"type\": [\"string\", \"null\"]}}, \"additionalProperties\": false}}, \"$schema\": \"https://json-schema.org/draft/2020-12/schema\"}"
}
```

Record the returned id as `<archive-document>`.

### 2.6 `archive-expander-config`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "archive-expander-config",
  "version": "1.0.0",
  "description": "ArchiveExpander step payload: how many levels of archive to expand. Absent means 1. The upper bound is NOT stated here -- MaxSupportedDepth is a compile-time constant checked before a file is opened, and repeating it in a frozen schema row is the coupling archive-document v2.0.0 had.",
  "definition": "{\"type\": \"object\", \"$schema\": \"https://json-schema.org/draft/2020-12/schema\", \"required\": [], \"properties\": {\"maxDepth\": {\"type\": \"integer\", \"minimum\": 1}}, \"additionalProperties\": false}"
}
```

Record the returned id as `<archive-expander-config>`.

### 2.7 `kafka-exporter-config`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "kafka-exporter-config",
  "version": "1.0.0",
  "description": "KafkaExporter step payload: the destination topic and the delivery timeout the cached producer is built with. The broker is not here, for the same reason it is absent from the importer's.",
  "definition": "{\"type\": \"object\", \"$schema\": \"https://json-schema.org/draft/2020-12/schema\", \"required\": [\"topic\", \"deliveryTimeoutSeconds\"], \"properties\": {\"topic\": {\"type\": \"string\", \"minLength\": 1}, \"deliveryTimeoutSeconds\": {\"type\": \"integer\", \"minimum\": 1}}, \"additionalProperties\": false}"
}
```

Record the returned id as `<kafka-exporter-config>`.

### 2.8 `sk-normalizer-config-v4`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "sk-normalizer-config-v4",
  "version": "4.0.0",
  "description": "SKNormalizer step payload. Supersedes sk-normalizer-config-v3 3.0.0, which declared cacheAddress -- the full L2 address, authored by hand into the step payload. The record now declares cacheRoot, the dictionary's NAME alone, and composes skp:{workflowId}:cache:{root} from the workflow id the dispatch already carries. A referenced definition cannot be edited, so renaming a property needs a new row.",
  "definition": "{\"type\": \"object\", \"title\": \"SKNormalizer step payload\", \"$schema\": \"https://json-schema.org/draft/2020-12/schema\", \"required\": [\"handler\"], \"properties\": {\"handler\": {\"enum\": [\"Acme\", \"AlphaBeta\", \"Sample\"], \"type\": \"string\", \"description\": \"The provider handler to apply. One of the names this processor version carries.\"}, \"cacheRoot\": {\"type\": [\"string\", \"null\"], \"description\": \"The NAME of one projected dictionary for whitelist lookups, not its address. Must match a cache Root bound to this workflow through WorkflowCaches; nothing validates that, and a mismatch is a deterministic failed step naming this root. Declared here because ConfigSchemaConformance compares the record's shape to this definition at startup, so every property on the config record must be described.\"}}, \"additionalProperties\": false}"
}
```

Record the returned id as `<sk-normalizer-config-v4>`.

**Why the payload names a root and not an address.** The address is
`skp:{workflowId}:cache:{root}`, and the workflow id half is the workflow's own. Putting the whole
address on the payload meant an operator transcribed that id into JSON by hand, and nothing anywhere
kept the copy equal to the id it came from — not the four gates in step 8, none of which inspects a
cache address, and not the payload gate, which evaluates the payload against this definition and so
passes any string at all. Recreate the workflow and the payload quietly names a dictionary that will
never be projected. The processor now composes the address from the id its dispatch already carries,
so the only half left to author is the name.

**`cacheRoot` must be declared here or the replica will not start.**
`ConfigSchemaConformance.Check` compares the *shape of the config record* against the definition at
startup, not against any payload. A build of `sk-normalizer` whose `SKNormalizerConfig` declares
`CacheRoot`, pointed at a row that still declares `cacheAddress`, fails conformance and publishes
UNHEALTHY — and `ProcessorLivenessValidator` then refuses every workflow using it.

**If v3 is already live, it cannot be edited into this.** Definitions are frozen once referenced, so
the fix is this new row, the processor's `configSchemaId` re-pointed at it (§3.6), and a restart.
Only the processor row carries a `configSchemaId`; a step does not, so there is exactly one row to
re-point. Note that both workflows on this processor are affected, `sc-chain` as well as this chain —
the schema hangs off the processor, which they share.

### 2.9 `archive-collapser-config`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "archive-collapser-config",
  "version": "1.0.0",
  "description": "ArchiveCollapser step payload: empty. The processor takes no decisions from a step -- what to pack is entirely the document's shape. Registered rather than left null so an empty payload is a stated contract instead of an absence, and so a field added later has somewhere to land.",
  "definition": "{\"type\": \"object\", \"$schema\": \"https://json-schema.org/draft/2020-12/schema\", \"required\": [], \"properties\": {}, \"additionalProperties\": false}"
}
```

Record the returned id as `<archive-collapser-config>`.

### 2.10 `file-persister-config`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "file-persister-config",
  "version": "1.0.0",
  "description": "FilePersister step payload: the folder written into. Absolute, and it must already exist -- the processor refuses to create it, because an absent folder means the volume is not mounted. The file NAME is not here; it rides the envelope.",
  "definition": "{\"type\": \"object\", \"$schema\": \"https://json-schema.org/draft/2020-12/schema\", \"required\": [\"folderPath\"], \"properties\": {\"folderPath\": {\"type\": \"string\", \"minLength\": 1}}, \"additionalProperties\": false}"
}
```

Record the returned id as `<file-persister-config>`.


## Step 3 — create the 8 processor rows

`POST /api/v1/processors`. Substitute each `<schema-slug>` with the id recorded in step 2. Read Appendix A before you send `sourceHash` — it is the one field you may not be able to copy.

### 3.1 `kafka-importer`

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "kafka-importer",
  "version": "2.2.0",
  "description": "reads a topic, one lineage per record; broker from Kafka__BrokerList, not the payload",
  "sourceHash": "dcd83ec93cfada86eaf477a43a565914de8112fab3d62d54c628f417de56ac62",
  "instanceId": null,
  "inputSchemaId": null,
  "outputSchemaId": "<file-locator>",
  "configSchemaId": "<kafka-importer-config>"
}
```

Record the returned id as `<proc:kafka-importer>`.

### 3.2 `file-fetcher`

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "file-fetcher",
  "version": "1.0.0",
  "description": "path in, file bytes plus identity out",
  "sourceHash": "8fa4fe0b9c527cb7f50ab79a91bd2d07769cc2569277de8583333ec56c749f22",
  "instanceId": null,
  "inputSchemaId": "<file-locator>",
  "outputSchemaId": "<file-envelope>",
  "configSchemaId": "<file-fetcher-config>"
}
```

Record the returned id as `<proc:file-fetcher>`.

### 3.3 `outcome-recorder`

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "outcome-recorder",
  "version": "1.0.0",
  "description": "records that a step reached a terminal outcome and where to look; carries no reason and no payload",
  "sourceHash": "f772623e05972790328e14bd58b30339a5a84abb10717e751bd10f9f480af63d",
  "instanceId": null,
  "inputSchemaId": null,
  "outputSchemaId": null,
  "configSchemaId": null
}
```

Record the returned id as `<proc:outcome-recorder>`.

### 3.4 `archive-expander`

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "archive-expander",
  "version": "1.0.0",
  "description": "envelope in, structured document out",
  "sourceHash": "cfefe29785ad7a7089e7616fc2f3ffcee33e48f9909a14a11a459ab2bb070157",
  "instanceId": null,
  "inputSchemaId": "<file-envelope>",
  "outputSchemaId": "<archive-document>",
  "configSchemaId": "<archive-expander-config>"
}
```

Record the returned id as `<proc:archive-expander>`.

### 3.5 `kafka-exporter`

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "kafka-exporter",
  "version": "1.2.0",
  "description": "produces a branch to a topic and ends the lineage; broker from Kafka__BrokerList, not the payload. Input is file-locator, the mirror of what KafkaImporter emits -- so a topic this writes is a topic an importer can read.",
  "sourceHash": "ba7df85269267a1032838c998a926f14ac5b8be14d2472e32675cd2c62c0343c",
  "instanceId": null,
  "inputSchemaId": null,
  "outputSchemaId": null,
  "configSchemaId": "<kafka-exporter-config>"
}
```

Record the returned id as `<proc:kafka-exporter>`.

### 3.6 `sk-normalizer`

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "sk-normalizer",
  "version": "1.0.0",
  "description": "Applies one provider handler, named on the step payload, to the {metadata, content} tree ArchiveExpander produces, and emits a tree of the same contract. Input and output both point at the shared archive-document row: the handler changes contents, never the document's shape.",
  "sourceHash": "8e656abb119e8af86bd75a56df8ab69ae4094eb571849c6308d8f0e5eb8f8585",
  "instanceId": null,
  "inputSchemaId": "<archive-document>",
  "outputSchemaId": "<archive-document>",
  "configSchemaId": "<sk-normalizer-config-v4>"
}
```

Record the returned id as `<proc:sk-normalizer>`.

### 3.7 `archive-collapser`

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "archive-collapser",
  "version": "1.0.0",
  "description": "Packs an ArchiveExpander document back into one archive; emits the raw-file envelope",
  "sourceHash": "57496c6e0b3bef184f1a567b17ac3636b77f67ef8214b5e1070ae6585a76d3e2",
  "instanceId": null,
  "inputSchemaId": "<archive-document>",
  "outputSchemaId": "<file-envelope>",
  "configSchemaId": "<archive-collapser-config>"
}
```

Record the returned id as `<proc:archive-collapser>`.

### 3.8 `file-persister`

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "file-persister",
  "version": "1.0.0",
  "description": "writes the envelope's file into a configured folder and reports the absolute path; the mirror of file-fetcher",
  "sourceHash": "7352167c645248d37626532c029ec947a0edf24e44e176dfb19243a01c34c6d2",
  "instanceId": null,
  "inputSchemaId": "<file-envelope>",
  "outputSchemaId": "<file-locator>",
  "configSchemaId": "<file-persister-config>"
}
```

Record the returned id as `<proc:file-persister>`.


## Step 4 — create the 10 steps, with no edges yet

`POST /api/v1/steps` with `nextStepIds: null` on every one. A step cannot name a successor that does not exist, and this graph has a fan-in (`record-outcome`) that 8 of its own parents point at, so the edges cannot be written on creation in any order. They go in on the second pass, step 5.

`entryCondition` is an integer: `1` = PreviousCompleted, `2` = PreviousFailed, `4` = Always. Never omit it — the field is positional and an omitted one binds to `0` (PreviousProcessing), which both validators reject.

### 4.1 `split-importer`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "split-importer",
  "version": "1.0.0",
  "description": "paths in",
  "processorId": "<proc:kafka-importer>",
  "nextStepIds": null,
  "entryCondition": 4
}
```

Record the returned id as `<step:split-importer>`.

### 4.2 `split-filefetcher`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "split-filefetcher",
  "version": "1.0.0",
  "description": "path to envelope",
  "processorId": "<proc:file-fetcher>",
  "nextStepIds": null,
  "entryCondition": 1
}
```

Record the returned id as `<step:split-filefetcher>`.

### 4.3 `record-outcome`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "record-outcome",
  "version": "1.0.0",
  "description": "records that a step reached a terminal outcome and where to look",
  "processorId": "<proc:outcome-recorder>",
  "nextStepIds": null,
  "entryCondition": 2
}
```

Record the returned id as `<step:record-outcome>`.

### 4.4 `split-archiveexpander`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "split-archiveexpander",
  "version": "1.0.0",
  "description": "envelope to document",
  "processorId": "<proc:archive-expander>",
  "nextStepIds": null,
  "entryCondition": 1
}
```

Record the returned id as `<step:split-archiveexpander>`.

### 4.5 `export-outcome`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "export-outcome",
  "version": "1.0.0",
  "description": "puts the outcome record on skp-failures and ends the lineage",
  "processorId": "<proc:kafka-exporter>",
  "nextStepIds": null,
  "entryCondition": 1
}
```

Record the returned id as `<step:export-outcome>`.

### 4.6 `sk-normalizer-sample`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "sk-normalizer-sample",
  "version": "1.0.0",
  "description": "Applies a provider handler to the expanded document. Wired with the Sample handler, which is identity, so this step is a proven no-op for the chain's existing fixtures while exercising the real processor.",
  "processorId": "<proc:sk-normalizer>",
  "nextStepIds": null,
  "entryCondition": 1
}
```

Record the returned id as `<step:sk-normalizer-sample>`.

### 4.7 `split-archivecollapser`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "split-archivecollapser",
  "version": "1.0.0",
  "description": "Packs the expander's document back into one archive",
  "processorId": "<proc:archive-collapser>",
  "nextStepIds": null,
  "entryCondition": 1
}
```

Record the returned id as `<step:split-archivecollapser>`.

### 4.8 `sk-normalizer-alphabeta`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "sk-normalizer-alphabeta",
  "version": "1.0.0",
  "description": "Lifts Acme's standardized XML out and makes it the whole document. Runs AFTER the Acme step on its output, so an Acme failure skips it; emits a leaf-root .xml that ArchiveCollapser carries through unpacked.",
  "processorId": "<proc:sk-normalizer>",
  "nextStepIds": null,
  "entryCondition": 1
}
```

Record the returned id as `<step:sk-normalizer-alphabeta>`.

### 4.9 `split-filepersister`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "split-filepersister",
  "version": "1.0.0",
  "description": "writes the collapsed file to /mnt/skp-files/out and hands the exporter its path",
  "processorId": "<proc:file-persister>",
  "nextStepIds": null,
  "entryCondition": 1
}
```

Record the returned id as `<step:split-filepersister>`.

### 4.10 `split-exporter`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "split-exporter",
  "version": "1.0.0",
  "description": "documents out",
  "processorId": "<proc:kafka-exporter>",
  "nextStepIds": null,
  "entryCondition": 1
}
```

Record the returned id as `<step:split-exporter>`.


## Step 5 — write the edges

`PUT /api/v1/steps/{id}` once per step that has successors. The update DTO is a full replacement, not a patch: every field must be resent exactly as created, with `nextStepIds` now filled in. One step is a sink and is skipped.

### 5.1 `split-importer` → split-filefetcher, record-outcome

```http
PUT /api/v1/steps/<step:split-importer>
Content-Type: application/json

{
  "name": "split-importer",
  "version": "1.0.0",
  "description": "paths in",
  "processorId": "<proc:kafka-importer>",
  "nextStepIds": [
    "<step:split-filefetcher>",
    "<step:record-outcome>"
  ],
  "entryCondition": 4
}
```

### 5.2 `split-filefetcher` → split-archiveexpander, record-outcome

```http
PUT /api/v1/steps/<step:split-filefetcher>
Content-Type: application/json

{
  "name": "split-filefetcher",
  "version": "1.0.0",
  "description": "path to envelope",
  "processorId": "<proc:file-fetcher>",
  "nextStepIds": [
    "<step:split-archiveexpander>",
    "<step:record-outcome>"
  ],
  "entryCondition": 1
}
```

### 5.3 `record-outcome` → export-outcome

```http
PUT /api/v1/steps/<step:record-outcome>
Content-Type: application/json

{
  "name": "record-outcome",
  "version": "1.0.0",
  "description": "records that a step reached a terminal outcome and where to look",
  "processorId": "<proc:outcome-recorder>",
  "nextStepIds": [
    "<step:export-outcome>"
  ],
  "entryCondition": 2
}
```

### 5.4 `split-archiveexpander` → sk-normalizer-sample, record-outcome

```http
PUT /api/v1/steps/<step:split-archiveexpander>
Content-Type: application/json

{
  "name": "split-archiveexpander",
  "version": "1.0.0",
  "description": "envelope to document",
  "processorId": "<proc:archive-expander>",
  "nextStepIds": [
    "<step:sk-normalizer-sample>",
    "<step:record-outcome>"
  ],
  "entryCondition": 1
}
```

`export-outcome` is a sink — no PUT.

### 5.5 `sk-normalizer-sample` → split-archivecollapser, record-outcome, sk-normalizer-alphabeta

```http
PUT /api/v1/steps/<step:sk-normalizer-sample>
Content-Type: application/json

{
  "name": "sk-normalizer-sample",
  "version": "1.0.0",
  "description": "Applies a provider handler to the expanded document. Wired with the Sample handler, which is identity, so this step is a proven no-op for the chain's existing fixtures while exercising the real processor.",
  "processorId": "<proc:sk-normalizer>",
  "nextStepIds": [
    "<step:split-archivecollapser>",
    "<step:record-outcome>",
    "<step:sk-normalizer-alphabeta>"
  ],
  "entryCondition": 1
}
```

### 5.6 `split-archivecollapser` → split-filepersister, record-outcome

```http
PUT /api/v1/steps/<step:split-archivecollapser>
Content-Type: application/json

{
  "name": "split-archivecollapser",
  "version": "1.0.0",
  "description": "Packs the expander's document back into one archive",
  "processorId": "<proc:archive-collapser>",
  "nextStepIds": [
    "<step:split-filepersister>",
    "<step:record-outcome>"
  ],
  "entryCondition": 1
}
```

### 5.7 `sk-normalizer-alphabeta` → record-outcome, split-archivecollapser

```http
PUT /api/v1/steps/<step:sk-normalizer-alphabeta>
Content-Type: application/json

{
  "name": "sk-normalizer-alphabeta",
  "version": "1.0.0",
  "description": "Lifts Acme's standardized XML out and makes it the whole document. Runs AFTER the Acme step on its output, so an Acme failure skips it; emits a leaf-root .xml that ArchiveCollapser carries through unpacked.",
  "processorId": "<proc:sk-normalizer>",
  "nextStepIds": [
    "<step:record-outcome>",
    "<step:split-archivecollapser>"
  ],
  "entryCondition": 1
}
```

### 5.8 `split-filepersister` → split-exporter, record-outcome

```http
PUT /api/v1/steps/<step:split-filepersister>
Content-Type: application/json

{
  "name": "split-filepersister",
  "version": "1.0.0",
  "description": "writes the collapsed file to /mnt/skp-files/out and hands the exporter its path",
  "processorId": "<proc:file-persister>",
  "nextStepIds": [
    "<step:split-exporter>",
    "<step:record-outcome>"
  ],
  "entryCondition": 1
}
```

### 5.9 `split-exporter` → record-outcome

```http
PUT /api/v1/steps/<step:split-exporter>
Content-Type: application/json

{
  "name": "split-exporter",
  "version": "1.0.0",
  "description": "documents out",
  "processorId": "<proc:kafka-exporter>",
  "nextStepIds": [
    "<step:record-outcome>"
  ],
  "entryCondition": 1
}
```


## Step 6 — create the 10 assignments

`POST /api/v1/assignments`. One per step, no step without one. `payload` is a JSON **string**, not an object — the escaping below is part of the value.

### 6.1 `split-importer-cfg` → step `split-importer`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "split-importer-cfg",
  "version": "1.0.0",
  "description": "own consumer group; batch sized for the live suite's concurrent producers",
  "stepId": "<step:split-importer>",
  "payload": "{\"topic\": \"skp-paths\", \"messageCount\": 25, \"consumerGroup\": \"skp-splitchain\", \"idleTimeoutSeconds\": 10}"
}
```

Record the returned id as `<asg:split-importer-cfg>`.

### 6.2 `split-filefetcher-cfg` → step `split-filefetcher`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "split-filefetcher-cfg",
  "version": "1.0.0",
  "description": "zip only",
  "stepId": "<step:split-filefetcher>",
  "payload": "{\"maximumSizeBytes\": 33554432, \"minimumSizeBytes\": 0, \"allowedExtensions\": [\".zip\"]}"
}
```

Record the returned id as `<asg:split-filefetcher-cfg>`.

### 6.3 `record-outcome` → step `record-outcome`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "record-outcome",
  "version": "1.0.0",
  "description": "no payload: nothing this processor records is a workflow author's choice",
  "stepId": "<step:record-outcome>",
  "payload": "{}"
}
```

Record the returned id as `<asg:record-outcome>`.

### 6.4 `split-archiveexpander-cfg` → step `split-archiveexpander`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "split-archiveexpander-cfg",
  "version": "1.0.0",
  "description": "expand up to 4 levels",
  "stepId": "<step:split-archiveexpander>",
  "payload": "{\"maxDepth\": 4}"
}
```

Record the returned id as `<asg:split-archiveexpander-cfg>`.

### 6.5 `export-outcome` → step `export-outcome`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "export-outcome",
  "version": "1.0.0",
  "description": "the failures topic",
  "stepId": "<step:export-outcome>",
  "payload": "{\"topic\": \"skp-failures\", \"deliveryTimeoutSeconds\": 30}"
}
```

Record the returned id as `<asg:export-outcome>`.

### 6.6 `sk-normalizer-sample-assignment` → step `sk-normalizer-sample`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "sk-normalizer-sample-assignment",
  "version": "1.0.0",
  "description": "handler Sample: identity. Acme would reject these fixtures -- they are nested outer-*.zip archives, not the wav+json pairs Acme pairs by basename.",
  "stepId": "<step:sk-normalizer-sample>",
  "payload": "{\"handler\": \"Acme\", \"cacheRoot\": \"chain-artists\"}"
}
```

Record the returned id as `<asg:sk-normalizer-sample-assignment>`.

**This payload is complete, and it used to require a second pass.** While the payload carried the
full address, it could not be written here at all: the address embeds the workflow id, the workflow
does not exist until step 7, and the assignment must exist before the workflow that references it.
There was no ordering that worked, so this row was created short and a step 7b came back to stamp the
address on afterwards. Naming the root instead removes the dependency — `chain-artists` is knowable
now — and step 7b with it.

**`chain-artists` must match the cache row created in step 6b and named by the workflow in step 7.**
Nothing checks that, at start or before: a root naming no cache bound to this workflow is a
deterministic failed step at the first Acme lookup, naming both the composed address and this root.
See Appendix C7.

**The other `sk-normalizer` step needs no root.** §6.8 runs the AlphaBeta handler, which consults no
whitelist. A missing root is only a defect for a handler that reaches for a list, which is why that
step keeps running with a bare `{"handler": "AlphaBeta"}`.

### 6.7 `split-archivecollapser-assignment` → step `split-archivecollapser`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "split-archivecollapser-assignment",
  "version": "1.0.0",
  "description": "ArchiveCollapser step payload holds nothing by design",
  "stepId": "<step:split-archivecollapser>",
  "payload": "{}"
}
```

Record the returned id as `<asg:split-archivecollapser-assignment>`.

### 6.8 `sk-normalizer-alphabeta-assignment` → step `sk-normalizer-alphabeta`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "sk-normalizer-alphabeta-assignment",
  "version": "1.0.0",
  "description": "handler AlphaBeta: pass Acme's rendered XML through as a one-file document",
  "stepId": "<step:sk-normalizer-alphabeta>",
  "payload": "{\"handler\": \"AlphaBeta\"}"
}
```

Record the returned id as `<asg:sk-normalizer-alphabeta-assignment>`.

### 6.9 `split-filepersister-cfg` → step `split-filepersister`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "split-filepersister-cfg",
  "version": "1.0.0",
  "description": "the mirror folder: input files come from in/, output files land in out/",
  "stepId": "<step:split-filepersister>",
  "payload": "{\"folderPath\": \"/mnt/skp-files/out\"}"
}
```

Record the returned id as `<asg:split-filepersister-cfg>`.

### 6.10 `split-exporter-cfg` → step `split-exporter`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "split-exporter-cfg",
  "version": "1.0.0",
  "description": "documents topic",
  "stepId": "<step:split-exporter>",
  "payload": "{\"topic\": \"skp-documents\", \"deliveryTimeoutSeconds\": 30}"
}
```

Record the returned id as `<asg:split-exporter-cfg>`.


## Step 6b — create the artist whitelist cache

`sk-normalizer`'s Acme handler gates the artist on a whitelist and publishes the whitelist's value
rather than the provider's. A workflow that names no cache still starts, but every Acme item on it
then fails with a payload defect — see §6.6 and C7.

The dictionary is key/value: the key is the artist exactly as the provider's sidecar writes it, the
value is the spelling the standardized XML will carry.

```http
POST /api/v1/caches
Content-Type: application/json

{
  "name": "chain-artist-whitelist",
  "version": "1.0.0",
  "description": "Artists this chain is allowed to publish. Key is the artist as the provider wrote it; value is the spelling the standardized XML carries.",
  "root": "chain-artists",
  "items": "{\"SKP Live Suite\": \"SKP Live Suite (Approved)\"}"
}
```

Record the returned id as `<cache:chain-artists>`, and the root as `chain-artists`.

**`root` is unique across the whole table**, not per workflow, and it is the half of the L2 address
an operator types. A duplicate is a `409` naming `root`.

**No colon in the root or in any key.** The address is built by concatenation, so root `a` with key
`b:c` and root `a:b` with key `c` are the same string — one dictionary would answer for the other.
The API refuses both at create and update.

## Step 7 — create the workflow

`POST /api/v1/workflows`. Both id lists are junction writes, so every step and assignment above must already exist.

```http
POST /api/v1/workflows
Content-Type: application/json

{
  "name": "filefetcher-archiveexpander-chain",
  "version": "1.0.0",
  "description": "KafkaImporter -> FileFetcher -> ArchiveExpander -> ArchiveCollapser -> FilePersister -> KafkaExporter (symmetric: file-locator in, file-locator out)",
  "entryStepIds": [
    "<step:split-importer>"
  ],
  "assignmentIds": [
    "<asg:split-importer-cfg>",
    "<asg:split-filefetcher-cfg>",
    "<asg:record-outcome>",
    "<asg:split-archiveexpander-cfg>",
    "<asg:export-outcome>",
    "<asg:sk-normalizer-sample-assignment>",
    "<asg:split-archivecollapser-assignment>",
    "<asg:sk-normalizer-alphabeta-assignment>",
    "<asg:split-filepersister-cfg>",
    "<asg:split-exporter-cfg>"
  ],
  "cacheIds": [
    "<cache:chain-artists>"
  ],
  "cronExpression": "5,35 * * * * *"
}
```

Record the returned id as `<workflow>`.

`cacheIds` is a third junction beside `entryStepIds` and `assignmentIds`. Every cache it names is
projected into L2 when the workflow starts and removed when it stops.

## Step 8 — start the workflow

Creating the rows does not run anything. A workflow only fires once it has been started, and
start is where the graph is validated as a whole.

```http
POST /api/v1/orchestration/start
Content-Type: application/json

"<workflow>"
```

The body is the bare workflow id as a JSON string — not an object, not a bare token.

A `202 Accepted` means the request was well-formed, all four gates passed, and the projection
write has been queued. It does **not** mean the projection is written yet; give it a few seconds
before expecting the first cron fire.

A `422` means a gate refused the graph. Each names the offending rows. There are four gates but
**five** gate names a `422` can carry: the cycle gate's walk also refuses a `nextStepIds` entry
that resolves to no step, and reports that as `missingStep` rather than `cycle`. Appendix C tells
you which mistake produces which.

To take it down again: `POST /api/v1/orchestration/stop` with the same body.

## Step 9 — publish the diagram (optional, and not part of the graph)

The workflow row carries one more column than step 7 writes: `diagram`, an SVG served at
`GET {API}/api/v1/workflows/<workflow>.svg`. It is not a graph entity, no gate looks at it, and a
workflow with none runs exactly as well — `GET` answers `200` with a placeholder rather than `404`,
so a missing diagram reads as an un-enriched workflow rather than a wrong id. A rebuild that stops
at step 8 is complete and correct; it just has no picture, and the dashboard panel that embeds this
URL will show the placeholder.

The drawing is never authored by hand and never copied into this file, because it is derived: it is
read from the live graph at publish time, which is what keeps it honest about the ten hops the
stored `description` still describes as six.

```
python kibana/publish-diagram.py filefetcher-archiveexpander-chain_1.0.0 --api {API}
```

The argument is the `EntityName` — `<name>_<version>` — not the id. Add `--dry-run` to draw and gate
without publishing. The gate refuses to publish a drawing with an undrawn or unlabelled edge, or one
that escapes its own viewBox, so a `GATE FAILED` here is about the picture and never about the graph
you just built.

`kibana/` is not in the offline `ship/` baseline. If the folder is absent on the machine you are
rebuilding on, skip this step: there is nothing to reconstruct and nothing downstream depends on it.

## Appendix A — `sourceHash`, the one field you may not be able to copy

`sourceHash` is not a label. It is the processor's code identity, and it is how a running
processor finds its own row: it asks for the row carrying the hash embedded in its own assembly,
and waits forever if none exists. A wrong value does not error — it hangs, silently, forever.

The hash is a SHA-256 fold over the concrete processor project's own `.cs` files, with line
endings normalised to LF and paths ordinal-sorted, so it is **identical on Windows and Linux for
identical sources**. That gives you two cases:

- **The offline machine builds the same processor sources, unmodified.** The hashes in step 3 are
  correct as written. Copy them.
- **The sources differ at all** — even a comment, even whitespace that is not a line ending —
  **or you cannot verify they are the same.** The hashes in step 3 are wrong and will hang every
  processor. Read the real value from each built processor instead, from the
  `AssemblyMetadata("SourceHash", …)` attribute on its own assembly, and send that. The fold
  covers only the concrete processor's own files, so a framework-only change does not move it.

Only the eight values change. Nothing else in step 3 depends on them.

**Provenance, because this is the one section that goes stale silently.** The eight values in step 3
were last re-derived on **2026-09-28**, and agreed two independent ways: they are what the live rows
hold, and they are what a `Release` build of this repo prints. Seven of the eight had drifted from
an earlier edit of this file and were wrong — which is exactly the failure this appendix warns
about, landing on the appendix's own author. Nothing about a wrong value is visible at rebuild time:
every request in step 3 still returns `201`, every count in B1 still matches, and the graph still
starts, because no gate reads a `sourceHash` — only a processor does, by waiting. To re-derive them
without trusting this file, build the solution and read the line each processor project prints:

```
dotnet build SK_P.sln -c Release | grep SourceHash
```

That is the same fold the assembly carries, so it answers for the sources you actually have rather
than for the sources this file was written against.

## Appendix B — verifying the rebuild

Three checks, in order. The first two do not need the processors to be running.

**B1. Counts.** `GET` each collection and confirm: 10 schemas, 8 processors, 10 steps,
10 assignments, 1 cache, 1 workflow. A short count means a `POST` failed and was not noticed.

**B2. The graph is isomorphic.** Read the workflow, walk `entryStepIds` and each step's
`nextStepIds`, and compare the *shape* against the diagram in *The graph you are building* — resolve each id back to the step's name and
check the edge sets by name. Confirm specifically:

- exactly one entry step, `split-importer`, with `entryCondition: 4`
- `record-outcome` has `entryCondition: 2` and is named by eight parents — the eight success-path
  steps, and not `export-outcome`, which is its child
- `split-archivecollapser` is named by two parents
- `export-outcome` has an empty `nextStepIds`
- every other step has `entryCondition: 1`
- every one of the 10 steps has exactly one assignment pointing at it

**B3. It starts.** A `202` from step 8 is the real proof: it means the cycle gate, the schema-edge
gate, the payload gate and the liveness gate all accepted the graph you built. Nothing short of
that check exercises all four. The cycle gate's walk carries a fifth refusal with it — a
`nextStepIds` entry naming no existing step is refused as `missingStep` — so a `202` also proves
every edge you wrote in step 5 resolves.

**B4. The dictionary reached L2.** A `202` does **not** cover this — no gate looks at a cache, so
a workflow with a misspelled address, or with no cache at all, starts exactly as cleanly as a
correct one and fails later, per document, inside the handler. Read the projection back instead.
A few seconds after step 8, against the same Redis the processors use:

```
redis-cli KEYS  'skp:<workflow>:cache:*'
redis-cli GET   'skp:<workflow>:cache:chain-artists'
redis-cli GET   'skp:<workflow>:cache:chain-artists:SKP Live Suite'
```

Expect two keys, the root answering `["SKP Live Suite"]` — a JSON array of the key names, not the
dictionary — and the entry answering `SKP Live Suite (Approved)`. The root is written even for an
empty dictionary, as `[]`, and that is what lets a processor tell "projected but empty" from
"never projected". An absent root with the workflow running means the cache was never named in
step 7; check the workflow's `cacheIds`.

Then `POST /api/v1/orchestration/stop` and re-run the `KEYS`: both keys must be gone. A cache
that outlives its workflow is the one state this design does not allow, and cleanup reads the key
list out of the root to do it — so a root you edited by hand in Redis will strand its entries.

## Appendix C — the nine ways this fails

**C1. `422` naming a mismatched schema edge.** The schema-edge gate compares the parent
processor's `outputSchemaId` against the child processor's `inputSchemaId` and demands they are
**the same row id**, not the same content. A byte-identical duplicate schema row fails. This is
why step 2 creates exactly ten rows and step 3 reuses them: `archive-document` is the output of
`archive-expander`, the input *and output* of `sk-normalizer`, and the input of
`archive-collapser` — one row, four references. If you created a second copy of a schema by
accident, delete it and repoint, do not paper over it.

`sk-normalizer`'s input and output being the same row is forced, not stylistic: the AlphaBeta
step's parent is the Acme step on the same processor, so parent-output must equal child-input.
A tighter input schema for that processor is refused by this gate even when its text is
identical.

**C2. `422` naming a payload that does not conform.** The payload gate validates each assignment's
`payload` against its processor's `configSchemaId` definition. `additionalProperties: false` is
set on all of them, so an extra field fails as loudly as a missing one. Note that
`sk-normalizer-config-v4` pins `handler` to an enum of exactly `Acme`, `AlphaBeta`, `Sample` —
a handler name outside that list is refused here, at start, rather than at dispatch.

**C3. `422` naming a count of unhealthy processors.** The liveness gate reads per-replica
registrations out of Redis and requires at least one present, healthy and fresh replica for every
processor in the graph. This is precondition 3 and Appendix A coming due: a processor that never
found its row never registered, and it will never say so on its own. If this fires, check the
processors' own logs for the identity wait before touching the graph.

**C4. `400` on a step create with no `entryCondition`.** The DTOs are positional records, so an
omitted `entryCondition` binds to `0` — `PreviousProcessing` — which nothing in this system ever
reports, meaning the step could never be entered. Both step validators reject it explicitly for
that reason. Always send the integer.

**C5. `409` on a processor create.** `sourceHash` is unique among rows with no `instanceId`.
You get this by creating `sk-normalizer` twice, because two steps use it. Eight processor rows,
ten steps.

**C6. The chain starts, validates, fires on its cron — and nothing happens.** No error anywhere,
and every pod healthy. The entry step is a Kafka importer, so a chain with an unreachable broker
simply has nothing to import; the importer logs `1/1 brokers are down` at rdkafka's own level and
retries forever, which is by design and is easy to read past.

On a kind cluster the specific trap is address family, not reachability. The dev broker container
joins the `kind` network with both an IPv4 and an IPv6 address, Docker's embedded DNS answers with
the IPv6 one, and the pod network has no IPv6 route — so the client resolves the name successfully
and then cannot route to it. The symptom is `Failed to connect to broker at [skp-kafka.kind]:9092:
Network is unreachable`, and the word that matters is *unreachable* rather than *refused*: refused
would mean nothing is listening, unreachable means nothing can get there.

Confirm it by comparing what the container has with what the pod resolves:

```
docker inspect skp-kafka --format '{{range .NetworkSettings.Networks}}IPv4={{.IPAddress}} IPv6={{.GlobalIPv6Address}}{{end}}'
kubectl exec -n skp deploy/processor-kafkaimporter -- getent hosts skp-kafka
```

Pin the IPv4 on the two pods that talk to the broker. `hostAliases` fixes both the bootstrap address
and the `INTERNAL` listener the broker advertises afterwards, which a `Kafka__BrokerList` edit would
not:

```
kubectl patch deploy processor-kafkaimporter -n skp --type=json   -p '[{"op":"add","path":"/spec/template/spec/hostAliases","value":[{"ip":"<ipv4>","hostnames":["skp-kafka","skp-kafka.kind"]}]}]'
```

…and the same for `processor-kafkaexporter`. **The address is the container's current IPv4 and it
changes when the container is recreated**, which is why this is a documented step rather than a line
in `k8s/34-processor-kafkaimporter.yaml`: a manifest carrying a stale IP would fail exactly like the
IPv6 case, with a different cause.

**C7. The chain runs, and Acme documents quietly stop arriving.** The whitelist has three
failure shapes and only one of them is an error you can search for.

- **No `cacheRoot` on the payload** — §6.6's payload was copied short. The step ends `Failed` with
  *"step payload rejected: this handler gates a field on a whitelist, but the payload names no
  cacheRoot"*, and takes the `record-outcome` edge like any other failure. Loud, and correct:
  refusing every document instead would read in the logs exactly like a whitelist that approves
  nobody.
- **A root naming no projected dictionary** — a typo in the root, or the workflow never named the
  cache in step 7. Also `Failed`, with *"no whitelist is projected at 'skp:…'. This workflow binds no
  cache with root '…'"*. The workflow id half can no longer be the cause — it is composed from the
  dispatch rather than authored — so the root is the only half left to doubt. This is the one B4
  catches before a document ever arrives.
- **An artist that is not on the list, or a sidecar naming no artist at all** — the step ends
  **`Cancelled`**, which is neither of the above. No successor in this graph declares
  `entryCondition: 3`, so the branch simply stops: nothing is collapsed, nothing is persisted,
  and `record-outcome` does **not** fire — it is wired here at `entryCondition: 2`, and a cancel is
  not a failure. There is no record to find and no error to grep. The rejected name survives in
  exactly one place: the log line `the author cancelled the branch: {Reason}`, written at
  **Information** while the two failure shapes above are Warnings. A log query filtered to Warning
  and above shows you a clean system that is dropping documents.

The third shape is the expected one in normal operation — it is what the gate is for — so treat
"fewer documents than inputs, no errors anywhere" as a whitelist question first. Step 6b ships
one approved artist, `SKP Live Suite`; every other artist in your fixtures cancels until you add
it with a `PUT /api/v1/caches/<cache:chain-artists>`.

**C8. `422` naming a missing step, from a gate you did not know you had.** The gate name is
`missingStep`, not `cycle`, and the detail reads *"Step '…' references missing child step '…'"*.
It comes out of the cycle gate's own walk rather than a validator of its own, which is why step 8
describes four gates and five gate names. Two mistakes produce it, both in step 5: a `nextStepIds`
entry left as a literal `<step:slug>` placeholder that was never substituted, and an id copied from
a row that a failed earlier attempt deleted. An entry step id that resolves to nothing is the same
refusal with an all-zero parent id — that one means step 7's `entryStepIds` is wrong, not step 5.
Neither can reach the schema-edge gate, so a `422` here says nothing about whether the rest of the
graph is sound.

**C9. A mid-chain step stalls the lineage, and now says so.** Distinct from C6, which is the
importer having nothing to import. A non-terminal processor reports its outcome only by sending a
branch; one that returns normally, sends nothing and does not declare `EndsLineage` ends the
lineage with no outcome of any kind, so the orchestrator never advances and no successor — not even
`record-outcome` — fires. This used to be byte-identical in the record to a healthy step. It is now
logged at **Error**: *"the step returned without sending a branch — no StepOutcome will be
reported…"*. Search for it before suspecting the graph, because the graph is not the cause: this is
an author bug in the processor, and no gate can see it at start. The line carries no
`attributes.Result` on purpose — there is no outcome to count — so it joins the run by execution and
step id but does not appear in any outcome-distribution panel. A **source** is exempt: an importer's
drained poll legitimately opens no lineage, so the diagnostic cannot fire on `kafka-importer` and
C6's silence is still C6's silence.

## Appendix D — the stale descriptions, reproduced deliberately

The assignment `sk-normalizer-sample-assignment` is named for the `Sample` handler and its
description says "handler Sample: identity", but its payload is `{"handler": "Acme"}`. That is
what the live row holds, and the payload is what executes. It is reproduced here as-is because
this file copies values, not intentions. If you want the graph to agree with itself, change the
name and description — never the payload, which is load-bearing for the AlphaBeta step
downstream, whose whole job is to lift out the XML the Acme handler renders.

**The step row carries the same stale sentence, and is the easier one to miss.** §4.6's
`description` reads "Wired with the Sample handler, which is identity, so this step is a proven
no-op" — describing the same handler the payload contradicts, one row earlier in the rebuild and
three sections away from the payload that settles it. It is copied verbatim for the same reason.
Two rows are therefore stale about one fact: the step in §4.6 and the assignment in §6.6. Only the
payload in §6.6 executes.

There is no second pass in which to quietly improve it. The payload is written once, in §6.6, and
the stale description is copied alongside it rather than corrected — inventing a better one would
make this appendix false on your machine while it stays true on ours.

`kafka-exporter`'s `description` in §3.5 is stale about a different fact, and this one describes a
field sitting three lines below it. It says "Input is file-locator, the mirror of what KafkaImporter
emits", while the row's `inputSchemaId` is `null`. Send the `null`.

**The trap here is that "correcting" it appears to work.** Put `<file-locator>` on that row and this
graph still starts: both of the exporter's parent edges pass the schema-edge gate — the one from
`split-filepersister` because its output is `file-locator` and the ids then match, and the one from
`record-outcome` because its processor's output is `null` and a null on either side passes. Nothing
refuses the edit, so nothing tells you it was an edit. What it actually does is narrow the input of a
processor row that other workflows share: `kafka-exporter` carries two steps in this chain alone, and
any other workflow that hands it a branch from a processor with a non-null output must now match
`file-locator` exactly or fail its own start. The description is a sentence about what the topic
contains, not an unfilled slot — the `null` is the contract.

The workflow's own `description` field is likewise stale in the same way: it lists a six-hop
chain and mentions neither `sk-normalizer` nor the AlphaBeta fork nor the failure path. It is
copied verbatim for fidelity. Do not read it as the specification — *The graph you are building* is.

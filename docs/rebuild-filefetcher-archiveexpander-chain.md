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
  five known shapes and retrying unchanged fixes none of them.

## The graph you are building

Ten steps, eight processors, ten schemas, one workflow, fired by cron every 30 seconds at
`:05` and `:35`.

The success path runs left to right. Every step on it also has a second edge, to
`record-failure`, taken only when that step fails:

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

  every step above --(on failure)--> record-failure (failure-recorder)
                                       └─> export-failure (kafka-exporter -> skp-failures)
```

Three things about this shape are easy to get wrong and are checked by the API at start:

- `split-archivecollapser` is reached from **two** parents — `sk-normalizer-sample` directly and
  `sk-normalizer-alphabeta` after it. That is a diamond, not a cycle, and it is intentional.
- `record-failure` is a fan-in from all nine other steps. It is the reason the edges are written
  in a second pass.
- `sk-normalizer` appears **twice**, as two steps on one processor row. Do not create the
  processor twice — `sourceHash` is unique and the second create returns 409.

## Step 1 — preconditions

Before the first request, confirm all four. Do not start without them.

1. **BaseApi is reachable and the database is migrated.**
   `GET {API}/api/v1/workflows` must return `200` and a JSON array. A `404` means the route
   prefix is wrong: the entity routes are plural and version-segmented — `/api/v1/schemas`,
   `/api/v1/processors`, `/api/v1/steps`, `/api/v1/assignments`, `/api/v1/workflows`.

2. **The database has none of these rows yet.** All five lists above should be empty, or at
   least free of a processor whose `sourceHash` matches one in step 3. If rows exist from a
   previous attempt, delete them in reverse dependency order (workflow, assignments, steps,
   processors, schemas) — schema and processor deletes are `RESTRICT`, so a half-built graph
   will refuse to unwind out of order and tell you which reference is holding it.

3. **The eight processor services are deployed and running.** They do not create their own rows.
   Each one asks the API, over the broker, for the row matching its embedded `sourceHash`, and
   **waits forever until it exists** — a processor sitting at `Running`/`NotReady` with zero
   restarts before step 3 is correct behaviour, not a fault. After step 3 they resolve and
   register. Before that, step 8 cannot succeed.

4. **Redis and the broker are up.** Step 8 reads per-replica liveness out of Redis; the
   processors' identity handshake goes over the broker.

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

### 2.8 `sk-normalizer-config-v2`

```http
POST /api/v1/schemas
Content-Type: application/json

{
  "name": "sk-normalizer-config-v2",
  "version": "2.0.0",
  "description": "SKNormalizer step payload: which provider handler to apply. Supersedes sk-normalizer-config 1.0.0, whose enum predates AlphaBeta; a referenced definition cannot be edited, so a new handler needs a new row. The enum is exactly the handlers this build registers, so a workflow naming an absent handler is refused at publish rather than failing at dispatch. Also declares cacheAddress, unread by this build, because ConfigSchemaConformance checks the config record's shape, not any payload -- the property has to be described here as soon as it exists on the record.",
  "definition": "{\"type\": \"object\", \"title\": \"SKNormalizer step payload\", \"$schema\": \"https://json-schema.org/draft/2020-12/schema\", \"required\": [\"handler\"], \"properties\": {\"handler\": {\"enum\": [\"Acme\", \"AlphaBeta\", \"Sample\"], \"type\": \"string\", \"description\": \"The provider handler to apply. One of the names this processor version carries.\"}, \"cacheAddress\": {\"type\": [\"string\", \"null\"], \"description\": \"The full L2 address of one projected dictionary for whitelist lookups. Nothing reads it yet. Declared in the schema because ConfigSchemaConformance checks record shape at startup, so every property on the config record must be described here even before any payload sets it.\"}}, \"additionalProperties\": false}"
}
```

A deployment carrying the `CacheAddress` property on `SKNormalizerConfig` needs this schema row —
`ConfigSchemaConformance.Check` compares the record's shape against the definition, not against any
payload, so the property has to be declared here the moment it exists on the record, before any
operator authors it into a step. If this row is already live without `cacheAddress`, it cannot be
edited: definitions are frozen, so the fix is a new schema row, both sides re-pointed to it (the
processor's `configSchemaId` and the workflow steps naming the old one), and a restart. Skip that and
the replica fails startup conformance against the old row and publishes UNHEALTHY.

Record the returned id as `<sk-normalizer-config-v2>`.

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
  "sourceHash": "5845e6092ad7e663c101337abc02c12b0a3c3a91f0dd3f85ccba783ba2c4a146",
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
  "sourceHash": "027294898cf4b0d2b7ec2572da9e3ca58d19b0f36d73f0f807984a9989ad0a5e",
  "instanceId": null,
  "inputSchemaId": "<file-locator>",
  "outputSchemaId": "<file-envelope>",
  "configSchemaId": "<file-fetcher-config>"
}
```

Record the returned id as `<proc:file-fetcher>`.

### 3.3 `failure-recorder`

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "failure-recorder",
  "version": "1.0.0",
  "description": "records that a step failed and where to look; carries no reason and no payload",
  "sourceHash": "ab61472514e78199ca25ed17276369c738447626df1bd443b63f8cd94b8f212a",
  "instanceId": null,
  "inputSchemaId": null,
  "outputSchemaId": null,
  "configSchemaId": null
}
```

Record the returned id as `<proc:failure-recorder>`.

### 3.4 `archive-expander`

```http
POST /api/v1/processors
Content-Type: application/json

{
  "name": "archive-expander",
  "version": "1.0.0",
  "description": "envelope in, structured document out",
  "sourceHash": "86a8c25b0031b21917e36334f636171c128ab521027ec7d54c7526d67fa226b8",
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
  "sourceHash": "c734986e5cbd0d12e96823c9d3bbff8d7f660bd4db67e7e1d24bc21148f729af",
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
  "sourceHash": "0b6759dd7740417ae77dd7d294df997816989f6b3331a1465eebf90b42a9b12c",
  "instanceId": null,
  "inputSchemaId": "<archive-document>",
  "outputSchemaId": "<archive-document>",
  "configSchemaId": "<sk-normalizer-config-v2>"
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
  "sourceHash": "4e5a9b96ad34aa3a6156c9f2b323f34e192fbdf607bcb4b406799772ae0599f3",
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
  "sourceHash": "f34b8ebf7132db2519e67408b07329221381cee5de2a70e3940703fb64156581",
  "instanceId": null,
  "inputSchemaId": "<file-envelope>",
  "outputSchemaId": "<file-locator>",
  "configSchemaId": "<file-persister-config>"
}
```

Record the returned id as `<proc:file-persister>`.


## Step 4 — create the 10 steps, with no edges yet

`POST /api/v1/steps` with `nextStepIds: null` on every one. A step cannot name a successor that does not exist, and this graph has a fan-in (`record-failure`) that 8 of its own parents point at, so the edges cannot be written on creation in any order. They go in on the second pass, step 5.

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

### 4.3 `record-failure`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "record-failure",
  "version": "1.0.0",
  "description": "records that a step failed and where to look",
  "processorId": "<proc:failure-recorder>",
  "nextStepIds": null,
  "entryCondition": 2
}
```

Record the returned id as `<step:record-failure>`.

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

### 4.5 `export-failure`

```http
POST /api/v1/steps
Content-Type: application/json

{
  "name": "export-failure",
  "version": "1.0.0",
  "description": "puts the failure record on skp-failures and ends the lineage",
  "processorId": "<proc:kafka-exporter>",
  "nextStepIds": null,
  "entryCondition": 1
}
```

Record the returned id as `<step:export-failure>`.

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

### 5.1 `split-importer` → split-filefetcher, record-failure

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
    "<step:record-failure>"
  ],
  "entryCondition": 4
}
```

### 5.2 `split-filefetcher` → split-archiveexpander, record-failure

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
    "<step:record-failure>"
  ],
  "entryCondition": 1
}
```

### 5.3 `record-failure` → export-failure

```http
PUT /api/v1/steps/<step:record-failure>
Content-Type: application/json

{
  "name": "record-failure",
  "version": "1.0.0",
  "description": "records that a step failed and where to look",
  "processorId": "<proc:failure-recorder>",
  "nextStepIds": [
    "<step:export-failure>"
  ],
  "entryCondition": 2
}
```

### 5.4 `split-archiveexpander` → sk-normalizer-sample, record-failure

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
    "<step:record-failure>"
  ],
  "entryCondition": 1
}
```

`export-failure` is a sink — no PUT.

### 5.5 `sk-normalizer-sample` → split-archivecollapser, record-failure, sk-normalizer-alphabeta

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
    "<step:record-failure>",
    "<step:sk-normalizer-alphabeta>"
  ],
  "entryCondition": 1
}
```

### 5.6 `split-archivecollapser` → split-filepersister, record-failure

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
    "<step:record-failure>"
  ],
  "entryCondition": 1
}
```

### 5.7 `sk-normalizer-alphabeta` → record-failure, split-archivecollapser

```http
PUT /api/v1/steps/<step:sk-normalizer-alphabeta>
Content-Type: application/json

{
  "name": "sk-normalizer-alphabeta",
  "version": "1.0.0",
  "description": "Lifts Acme's standardized XML out and makes it the whole document. Runs AFTER the Acme step on its output, so an Acme failure skips it; emits a leaf-root .xml that ArchiveCollapser carries through unpacked.",
  "processorId": "<proc:sk-normalizer>",
  "nextStepIds": [
    "<step:record-failure>",
    "<step:split-archivecollapser>"
  ],
  "entryCondition": 1
}
```

### 5.8 `split-filepersister` → split-exporter, record-failure

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
    "<step:record-failure>"
  ],
  "entryCondition": 1
}
```

### 5.9 `split-exporter` → record-failure

```http
PUT /api/v1/steps/<step:split-exporter>
Content-Type: application/json

{
  "name": "split-exporter",
  "version": "1.0.0",
  "description": "documents out",
  "processorId": "<proc:kafka-exporter>",
  "nextStepIds": [
    "<step:record-failure>"
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

### 6.3 `record-failure` → step `record-failure`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "record-failure",
  "version": "1.0.0",
  "description": "no payload: nothing this processor records is a workflow author's choice",
  "stepId": "<step:record-failure>",
  "payload": "{}"
}
```

Record the returned id as `<asg:record-failure>`.

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

### 6.5 `export-failure` → step `export-failure`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "export-failure",
  "version": "1.0.0",
  "description": "the failures topic",
  "stepId": "<step:export-failure>",
  "payload": "{\"topic\": \"skp-failures\", \"deliveryTimeoutSeconds\": 30}"
}
```

Record the returned id as `<asg:export-failure>`.

### 6.6 `sk-normalizer-sample-assignment` → step `sk-normalizer-sample`

```http
POST /api/v1/assignments
Content-Type: application/json

{
  "name": "sk-normalizer-sample-assignment",
  "version": "1.0.0",
  "description": "handler Sample: identity. Acme would reject these fixtures -- they are nested outer-*.zip archives, not the wav+json pairs Acme pairs by basename.",
  "stepId": "<step:sk-normalizer-sample>",
  "payload": "{\"handler\": \"Acme\"}"
}
```

Record the returned id as `<asg:sk-normalizer-sample-assignment>`.

**This payload is incomplete on purpose, and step 7b finishes it.** The Acme handler needs a
`cacheAddress`, and that address embeds the workflow id — which does not exist until step 7. There
is no ordering that lets you write it here: the assignment must exist before the workflow that
references it, and the address must exist after. Step 7b is the second half.

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
then fails with a payload defect — see §6.6 and C6.

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
    "<asg:record-failure>",
    "<asg:split-archiveexpander-cfg>",
    "<asg:export-failure>",
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

## Step 7b — stamp the whitelist address onto the Acme payload

Now that `<workflow>` exists, the address can be written. It is
`skp:{workflowId}:cache:{root}` — here, `skp:<workflow>:cache:chain-artists`.

```http
PUT /api/v1/assignments/<asg:sk-normalizer-sample-assignment>
Content-Type: application/json

{
  "name": "sk-normalizer-sample-assignment",
  "version": "1.0.0",
  "description": "handler Acme, gated on the chain-artists whitelist.",
  "stepId": "<step:sk-normalizer-sample>",
  "payload": "{\"handler\": \"Acme\", \"cacheAddress\": \"skp:<workflow>:cache:chain-artists\"}"
}
```

**`cacheAddress` must be declared in the processor's config schema or the replica will not start.**
`ConfigSchemaConformance` compares the *shape of the config record* against the schema at startup,
not against any payload, so `sk-normalizer-config-v2` (§2.8) is the version that carries it. A build
of `sk-normalizer` whose `SKNormalizerConfig` has the property, pointed at a schema that does not
declare it, fails conformance and publishes UNHEALTHY — and `ProcessorLivenessValidator` then
refuses every workflow using it.

**The other `sk-normalizer` step needs no address.** §6.8 runs the AlphaBeta handler, which consults
no whitelist. A missing address is only a defect for a handler that reaches for a list, which is why
that step keeps running with a bare `{"handler": "AlphaBeta"}`.

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

A `422` means one of the four gates refused the graph. Each names the offending rows. Appendix C
tells you which mistake produces which.

To take it down again: `POST /api/v1/orchestration/stop` with the same body.

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

## Appendix B — verifying the rebuild

Three checks, in order. The first two do not need the processors to be running.

**B1. Counts.** `GET` each collection and confirm: 10 schemas, 8 processors, 10 steps,
10 assignments, 1 workflow. A short count means a `POST` failed and was not noticed.

**B2. The graph is isomorphic.** Read the workflow, walk `entryStepIds` and each step's
`nextStepIds`, and compare the *shape* against the diagram in *The graph you are building* — resolve each id back to the step's name and
check the edge sets by name. Confirm specifically:

- exactly one entry step, `split-importer`, with `entryCondition: 4`
- `record-failure` has `entryCondition: 2` and is named by nine parents
- `split-archivecollapser` is named by two parents
- `export-failure` has an empty `nextStepIds`
- every other step has `entryCondition: 1`
- every one of the 10 steps has exactly one assignment pointing at it

**B3. It starts.** A `202` from step 8 is the real proof: it means the cycle gate, the schema-edge
gate, the payload gate and the liveness gate all accepted the graph you built. Nothing short of
that check exercises all four.

## Appendix C — the six ways this fails

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
`sk-normalizer-config-v2` pins `handler` to an enum of exactly `Acme`, `AlphaBeta`, `Sample` —
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

## Appendix D — one inconsistency, reproduced deliberately

The assignment `sk-normalizer-sample-assignment` is named for the `Sample` handler and its
description says "handler Sample: identity", but its payload is `{"handler": "Acme"}`. That is
what the live row holds, and the payload is what executes. It is reproduced here as-is because
this file copies values, not intentions. If you want the graph to agree with itself, change the
name and description — never the payload, which is load-bearing for the AlphaBeta step
downstream, whose whole job is to lift out the XML the Acme handler renders.

The workflow's own `description` field is likewise stale in the same way: it lists a six-hop
chain and mentions neither `sk-normalizer` nor the AlphaBeta fork nor the failure path. It is
copied verbatim for fidelity. Do not read it as the specification — *The graph you are building* is.

# FileFetcher output schema

`output.json` is the envelope this processor puts on the wire, and it is registered against the
processor identity as the output schema. `Processor.ArchiveExpander/schema/input.json` is a
byte-identical copy registered as the next step's input schema.

## What it asserts

- Six keys, `additionalProperties: false`. A key nobody agreed on must not travel silently — in
  particular `filePath`, which is deliberately absent from the envelope.
- Every key is REQUIRED and present, including the two timestamps that are frequently null. The
  serializer is configured `DefaultIgnoreCondition.Never` for exactly this reason.
- `content` is a base64 string. An empty file is `""`, which is why there is no `minLength` on it.
- `extension` has no `minLength` either: a file with no dot in its name has `FileInfo.Extension` of
  `""`, and such a file is legal under the `*.*` whitelist.
- `fileName` DOES carry `minLength: 1`. There is no such thing as a file without a name, and
  ArchiveExpander's root metadata node requires one.

## Why two copies rather than one shared file

The two processors are separate assemblies with no project reference between them, and each image
must carry its own schema so it can be registered from the image. They are duplicated for the same
reason `ProcessorJsonSchemaValidator` duplicates `JsonSchemaConfig`: the assemblies must not
reference each other. **The two must stay in sync.** `EnvelopeContractTests` is what catches a
divergence — it validates one processor's output against the other's registered input schema.

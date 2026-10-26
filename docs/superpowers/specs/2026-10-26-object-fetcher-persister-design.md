# ObjectFetcher and ObjectPersister — Design

**Date:** 2026-10-26
**Status:** Implemented and verified end to end 2026-10-26. Prerequisites done: the `locator` rename (`f8b55449`, live)
and the dev MinIO container (`tools/minio-dev.ps1`, running).
**Introduces:** `src/Processor.ObjectFetcher/`, `src/Processor.ObjectPersister/`, and two manifests
(`44-processor-objectfetcher.yaml`, `45-processor-objectpersister.yaml`).
**Depends on:** `BaseProcessor.Core` unchanged. `Processor.FileFetcher` and `Processor.FilePersister`
stay, side by side with these two. The registered `locator` row, already live.
**Modelled on:** `2026-09-09-file-reader-design.md`, `2026-09-10-filefetcher-archiveexpander-split-design.md`,
and the code of `Processor.FileFetcher` / `Processor.FilePersister` as of `f8b55449`.

## 1. The decision

> **ObjectFetcher and ObjectPersister are FileFetcher and FilePersister with the mounted volume
> replaced by the S3 API.** ObjectFetcher receives `{"location": "s3://bucket/key"}`, checks the
> object *dry* — extension and size, from a `HEAD` request, without downloading it — downloads it,
> and sends the same `file-envelope` FileFetcher sends. ObjectPersister receives that envelope, writes
> the bytes to `s3://bucket/prefix/<fileName>`, and reports `{"location": "s3://…"}`.

Both are plain downstream transforms, exactly as their file counterparts: an input, an output, one
branch per input, on the dispatch's own execution id. Neither is an edge.

**Both ends of both pairs speak two shared shapes, and that is the point of the design.**

- The **envelope** (`file-envelope`, unchanged) is what ObjectFetcher emits and ObjectPersister
  consumes, so every processor between the two ends — ArchiveExpander, SKNormalizer,
  ArchiveCollapser — is wireable unchanged.
- The **locator** (`locator`, `{location}`) is what KafkaImporter forwards, both fetchers read and
  both persisters write. It was `file-locator` / `{filePath}` until 2026-10-26 and was renamed for
  this design (`f8b55449`): `location` is true of an absolute path and of an `s3://` URI alike, so one
  row serves both pairs, the importer feeds either fetcher, and either persister's output closes the
  Kafka loop.

Storage is a property of the two ends only.

## 2. One client, two targets

The processors use **`AWSSDK.S3`** and nothing MinIO-specific. The target is chosen by configuration
alone:

| | kind / MinIO (test) | AWS S3 (target) |
|---|---|---|
| `S3__ServiceUrl` | `http://skp-minio:9000` | unset |
| `S3__ForcePathStyle` | `true` | unset (`false`) |
| `S3__Region` | `us-east-1` (MinIO ignores it; SigV4 needs one) | the bucket's region |
| credentials | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` as plain env | IRSA / Pod Identity |

**No credential is ever read by our code.** `AmazonS3Client` is constructed with an
`AmazonS3Config` and **no credentials argument**, so the SDK's default credential chain resolves
them: environment variables on kind, the web-identity token (IRSA) or Pod Identity on EKS. The same
binary, the same code path; only the manifest differs. IRSA needs `AWSSDK.SecurityToken`, which the
SDK loads by reflection and nothing else pulls in, so both processors reference it explicitly.

**No Kubernetes Secret, by decision.** The MinIO dev credentials are plain `env` values in the
manifests, as they are in `tools/minio-dev.ps1`. They protect a throwaway container on a laptop and
nothing else. In AWS there are no static keys at all, so there is nothing to put in a Secret either.

**"Passes on MinIO ⇒ passes on S3" holds for the API surface, not the deployment.** DevOps' position
is accepted for the code: `HEAD`/`GET`/`PUT`, error codes, ETags and checksums behave the same. What a
MinIO run cannot prove is IAM policy, KMS key grants and the network path to S3; those are manifest
and account configuration, and §11 lists what DevOps owns there.

## 3. The location — one `s3://` URI

```json
{ "location": "s3://skp-in/feeds/acme/orders.zip" }
```

The locator's one field, read by ObjectFetcher and written by ObjectPersister. ObjectPersister's step
payload names its destination the same way (`destinationUri`, §5).

**Which processor owns a location is decided by its form, and each refuses the other's by name.**
FileFetcher already refuses an `s3://` location as ObjectFetcher's (`f8b55449`); ObjectFetcher refuses
anything that is not `s3://` as FileFetcher's. Neither falls through to a generic "malformed" — an
operator who wired the wrong fetcher is told which one to wire.

**Parsed by hand, not by `System.Uri`.** `Uri` lower-cases the host, percent-decodes the path and
treats `?` and `#` as query and fragment. All three are legal, meaningful characters in an S3 key, so
`Uri` would silently address a different object. The parse is:

1. The string starts with `s3://` (scheme compared case-insensitively). Otherwise → refused as
   FileFetcher's (ObjectFetcher) or as a bad payload (ObjectPersister).
2. The bucket is everything up to the first `/` after the scheme. It must satisfy S3 bucket naming:
   3–63 characters, lower-case letters, digits, `.` and `-`, starting and ending with a letter or
   digit. Otherwise → rejected, quoting the bucket.
3. The key is everything after that `/`, **verbatim** — no decoding, no normalisation.

For ObjectFetcher the key must be non-empty, must not end in `/` (that names a "folder" marker, not
an object), and must be at most 1024 UTF-8 bytes. For ObjectPersister's `destinationUri` the key is a
**prefix**: it may be empty (`s3://skp-out` or `s3://skp-out/` both mean the bucket root), and a
non-empty prefix without a trailing `/` has one appended — `s3://skp-out/acme` and
`s3://skp-out/acme/` are the same instruction, as `part` and `.part` are for FilePersister's suffix.

**One parser, duplicated, not shared.** The two processors are separate assemblies that must not
reference each other — the same arrangement as `Locator` today. `ObjectUri` is a small internal record
with a `TryParse`, copied into both, and the tests pin both copies to one table of cases.

## 4. ObjectFetcher

### Steps, in order

1. **Config first.** Identical rules to FileFetcher: `allowedExtensions` (absent/empty widens to
   `*.*`), `minimumSizeBytes ≥ 0`, `maximumSizeBytes ≥ 1`, min ≤ max, and max ≤ the pod ceiling
   `ObjectFetcher__MaxObjectSizeBytes` (default 32 MiB) — not clamped, failed by name.
   `ExtensionWhitelist` is copied verbatim.
2. **Parse the input** as `Locator(location)` and the URI per §3. The parse exception is swallowed,
   as in FileFetcher: its text quotes upstream content.
3. **Dry inspection — `HeadObject`.** Metadata only; nothing is downloaded. It yields
   `ContentLength`, `LastModified` and `ETag`.
   - 404 → `reading <uri> failed: it does not exist`. (A `HEAD` has no body, so a missing bucket and a
     missing key are indistinguishable here; the message says "bucket or key".)
   - 403 → `reading <uri> failed: access denied`. Without `s3:ListBucket`, S3 answers a missing key
     with 403, which is why §11 asks for that permission (the dev MinIO user has it; verified: a
     missing key reads "does not exist", not "access denied").
   - Extension (from the key's last segment) against the whitelist → rejected.
   - Size against floor and ceiling → rejected.
4. **Read — `GetObject` with `EtagToMatch` set to the `HEAD`'s ETag.** If the object was replaced
   between the inspection and the read, S3 answers 412 and the step fails
   (`it changed between inspection and read`) instead of returning bytes the checks never saw. The
   body is copied into a `byte[]` of exactly `ContentLength`; a body longer than that fails the step
   rather than growing the buffer.
5. **Build the envelope** and `SendToPostAsync` once.

### The envelope, field by field

The registered `file-envelope` schema, unchanged:

| field | from |
|---|---|
| `fileName` | the key's last `/`-segment, e.g. `orders.zip` |
| `extension` | `Path.GetExtension(fileName)`, e.g. `.zip`; `""` when none |
| `sizeBytes` | `HeadObject.ContentLength` |
| `createdUtc` | **always `null`** — S3 records no creation time, and the schema already admits null |
| `modifiedUtc` | `HeadObject.LastModified`, UTC |
| `content` | the bytes, base64 on the wire (as today) |

**No location in the envelope**, by the same rule as FileFetcher's: the location is something the
workflow author chose, and every hop between the two ends stays location-independent. The URI
appears only in the failure messages and is never logged on success. The success log line has
FileFetcher's shape: `fetched {FileName} ({Extension}), {SizeBytes} bytes, modified {ModifiedUtc}`.

## 5. ObjectPersister

### Steps, in order

1. **Config first.** `destinationUri` present, parsed per §3 → otherwise `step payload rejected`.
2. **Parse the envelope** as FilePersister does (`PersistableFile`, every field nullable; no content
   → malformed; empty content is a valid zero-byte object).
3. **`SafeName`, copied verbatim.** The file name is still the one piece of upstream data that reaches
   the destination address. In S3 a `/` in the name would not escape a directory — it would silently
   write under a different prefix — and the rule that prevents both is the same rule.
4. **Key** = prefix + name; over 1024 UTF-8 bytes → rejected.
5. **`PutObject`**, from a `MemoryStream` over the bytes, with `ContentLength` known.
   - `NoSuchBucket` → `step payload rejected: bucket '<b>' does not exist; this processor does not
     create it`. The mirror of FilePersister's refusal to create a missing folder: a bucket is
     provisioned infrastructure, and auto-creating one would put data somewhere with none of the
     policy, encryption or lifecycle the real bucket carries. This is detected from the `PUT`'s own
     error, not a `HeadBucket` per dispatch, so the happy path costs one request.
   - 403 → `writing <uri> failed: access denied`.
   - anything else → `writing <uri> failed: <SDK message>`.
6. **Report** `{"location": "s3://bucket/key"}` and `SendToPostAsync` once. The log line:
   `persisted {FileName} ({Extension}), {SizeBytes} bytes, to {FilePath}` — FilePersister's exact
   template, field name included, so one dashboard query covers both persisters.

### What is deliberately absent

- **No staging name, no rename, no `TempExtension` option.** FilePersister stages because a file in a
  mounted folder is visible under its final name while it is still being written. An S3 `PUT` is
  atomic: the object does not exist until it is complete, then it exists whole. Staging would also
  cost a server-side copy plus a delete, since S3 has no rename, and that pair is *not* atomic.
- **No multipart upload.** The envelope is bounded by ObjectFetcher's (or FileFetcher's) ceiling,
  32 MiB by default, far below the 5 GiB single-`PUT` limit. Multipart becomes a design question only
  if that ceiling moves past ~100 MiB, and that would be a memory redesign anyway (§9).
- **No timestamps or metadata headers.** FilePersister restores none either; S3 sets `LastModified`.
- **Overwrite is the behaviour**, as with FilePersister: re-running a workflow over the same input
  lands in the same state. On a versioned bucket that is a new version, which is the bucket owner's
  choice, not this processor's.
- **No read permission needed.** The persister never reads back what it wrote; its dev MinIO user has
  `s3:PutObject` on `skp-out` and nothing else (verified: its reads are refused).

## 6. Failures

Same contract as the file pair: every failure is a `FailedException` whose message is the operator's
search key, the processor never logs a failure itself (`ProcessDispatchHandler` does), and the
prefixes are kept so one query finds both pairs' faults:

| prefix | ObjectFetcher | ObjectPersister |
|---|---|---|
| `step payload rejected:` | bad config, ceiling, malformed whitelist | bad `destinationUri`, missing bucket |
| `input branch did not name a location:` | locator not JSON / no `location` / bad URI | — |
| `input branch did not name a location this processor reads:` | a filesystem path (FileFetcher's) | — |
| `input branch did not carry a file:` | — | malformed envelope |
| `object <uri> rejected:` | extension, size | — |
| `file name '<n>' rejected:` | — | `SafeName`, key length |
| `reading <uri> failed:` | 404, 403, 412, transport | — |
| `writing <uri> failed:` | — | 403, transport |

The two `input branch did not name a location` prefixes are FileFetcher's exact wording
(`f8b55449`), so one query finds a misrouted record on either fetcher.

**Every S3 fault is a failed step, never a requeue**, for the reason `FileFetcherProcessor.Read`
gives: the framework requeues only `TransientSendException`. Transient network faults are absorbed
*inside* the call by the SDK's own retry (standard mode, its default attempts); one that survives
those fails the step like an `IOException` would. The `CancellationToken` is passed into every SDK
call, and `AmazonS3Config.Timeout` is set (30 s) so a wedged endpoint cannot hold a dispatch forever.

**The SDK's message is used, its stack is not.** `AmazonS3Exception.Message` names the code and the
resource; it does not echo object content, so unlike a `JsonException` it is safe to carry.

## 7. Configuration and schema rows

### Pod options (manifest env, not step payload)

| key | processor | default | meaning |
|---|---|---|---|
| `S3__ServiceUrl` | both | unset | custom endpoint; unset means AWS |
| `S3__ForcePathStyle` | both | `false` | required `true` for MinIO |
| `S3__Region` | both | unset → SDK chain | signing region |
| `ObjectFetcher__MaxObjectSizeBytes` | fetcher | `33554432` | pod ceiling, as `FileFetcher__MaxFileSizeBytes` |

`S3Options` is bound in each `ProcessorHost` and turned into a singleton `IAmazonS3`. The processor
takes `IAmazonS3` by constructor, so unit tests substitute it.

### Step payloads

```json
// ObjectFetcher — same fields as FileFetcher
{"allowedExtensions": [".zip"], "minimumSizeBytes": 0, "maximumSizeBytes": 33554432}

// ObjectPersister
{"destinationUri": "s3://skp-out/acme/"}
```

### Schema rows

`SchemaEdgeValidator` compares rows **by id**, and a null on either side of an edge passes.

| processor | inputSchemaId | outputSchemaId | configSchemaId |
|---|---|---|---|
| `object-fetcher` | `locator` (existing) | `file-envelope` (existing) | `object-fetcher-config` (new) |
| `object-persister` | `file-envelope` (existing) | `locator` (existing) | `object-persister-config` (new) |

**Every edge reuses an existing row**, which is what the rename bought: `KafkaImporter →
ObjectFetcher`, `ObjectPersister → KafkaExporter → topic → KafkaImporter`, and every hop through the
middle processors are all id-equal edges with no null on either side.

**`object-fetcher-config` is a new row even though its definition equals `file-fetcher-config`.**
Config rows take no part in edge validation, so sharing one buys nothing, and a separate row lets the
two descriptions say what is actually true (`HEAD`, not `FileInfo`) and the two evolve apart.
`ConfigSchemaConformance` checks each against its own record at startup.

New definitions live beside the existing ones in `src/tests/BaseApi.Tests/Schemas/`:
`object-fetcher-config.json`, `object-persister-config.json`.

## 8. Layout

```
src/Processor.ObjectFetcher/
  ObjectFetcherProcessor.cs   ObjectFetcherConfig.cs   ObjectFetcherOptions.cs
  Locator.cs (copy)           ObjectUri.cs             ExtensionWhitelist.cs (copy)
  FetchedFile.cs (copy)       S3Options.cs             ProcessorHost.cs  Program.cs
  Dockerfile  appsettings.json  Processor.ObjectFetcher.csproj
src/Processor.ObjectPersister/
  ObjectPersisterProcessor.cs ObjectPersisterConfig.cs Locator.cs (copy) ObjectUri.cs
  PersistableFile.cs (copy)   S3Options.cs             ProcessorHost.cs  Program.cs
  Dockerfile  appsettings.json  Processor.ObjectPersister.csproj
```

Copies rather than a shared library, matching how `FetchedFile`/`PersistableFile` and the two
`Locator`s already work: the registered schema row pins the wire shape, and `EnvelopeContractTests`
is extended to cover the new copies.

**Packages.** `AWSSDK.S3` and `AWSSDK.Core` (4.x, exact versions pinned in
`Directory.Packages.props` at plan time) are vendored into `nugets/` with their full transitive
closure, because restore is offline and a missing `.nupkg` fails the Docker build. Nothing else —
in particular not `AWSSDK.Extensions.NETCore.Setup`; the client is built by hand from `S3Options`.

**Checksums.** SDK 4 sends CRC32 request checksums by default. They are left at the default, not
turned off for MinIO, because turning them off would make the test path differ from the production
path. The dev MinIO is the final upstream release (`RELEASE.2025-10-15T17-29-55Z`), which supports
them; the end-to-end run (§13) is what proves that.

## 9. Memory

Unchanged from the file pair: 512 Mi limit, 256 Mi request, `maxSurge: 0`. The bytes are buffered
whole, exactly as `File.ReadAllBytes` buffers them today; streaming would not help, because the
envelope is a single JSON document with the content base64-inlined. The ceiling and the memory limit
still move together.

The node has room: measured 2026-10-26, 31 GiB with ~23 GiB available and 5.7 GiB requested across
the namespace. Two more 256 Mi requests do not change that.

## 10. Deployment (kind)

### MinIO — a container, like Kafka (done)

`tools/minio-dev.ps1` (`-Up` / `-Down` / `-Status` / `-Reset`) runs `skp-minio` as a plain Docker
container on the `kind` network, the shape `tools/kafka-dev-broker.ps1` set for the broker: S3 is org
infrastructure in production, so nothing in `k8s/` stands it up.

| | address |
|---|---|
| pods | `http://skp-minio:9000` (pod DNS resolves the container name; verified from a pod) |
| host | `http://localhost:19000` (mc, the live tests) |
| console | `http://localhost:19001` |

- **Built from source**, `tools/minio/Dockerfile`: MinIO no longer publishes community images
  (`minio/minio` is gone from Docker Hub, `quay.io/minio` answers 401). Server
  `RELEASE.2025-10-15T17-29-55Z` and `mc` `RELEASE.2025-08-13T08-35-41Z`, their final releases, with Go
  1.24.8. `mc` ships in the server image, so setup is `docker exec skp-minio mc …`.
- **Buckets** `skp-in` and `skp-out`, created by `-Up` (the processors never create them).
- **One user per processor**, mirroring the IAM roles: `objectfetcher` has `s3:GetObject` +
  `s3:ListBucket` on `skp-in`; `objectpersister` has `s3:PutObject` on `skp-out`. Verified: each is
  refused everything else.
- **Data on a named volume** `skp-minio-data`: seeded objects survive `-Down`/`-Up`; `-Reset` wipes.
- `tools/dev-up-after-restart.ps1` starts `skp-minio` with the other containers.

### `44-processor-objectfetcher.yaml`, `45-processor-objectpersister.yaml`

Copies of 38 and 40 with: **no volumes, no `volumeMounts`, no `own-the-mount` initContainer**, no
`FilePersister__TempExtension`; plus `S3__ServiceUrl=http://skp-minio:9000`, `S3__ForcePathStyle=true`,
`S3__Region=us-east-1`, and the processor's own MinIO user as `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`. Both added to `kustomization.yaml`. Images are loaded into the node as the
others are (`docker save --platform linux/amd64 | ctr -n k8s.io images import`; there is no `kind`
CLI on this machine).

### Seeding and reading objects

```bash
docker exec skp-minio mc cp /path/in/container local/skp-in/feeds/orders.zip
# Kafka record for the importer:
{"location": "s3://skp-in/feeds/orders.zip"}
```

From Windows, the live tests seed through the SDK against `http://localhost:19000`.

### For AWS (DevOps)

Remove the `S3__ServiceUrl` / `S3__ForcePathStyle` / static-key env lines, set `S3__Region`, and give
each Deployment a ServiceAccount bound to its IAM role. No image change: `AWSSDK.SecurityToken`, which
IRSA's web-identity credentials load by reflection, is already referenced by both processors.

## 11. What DevOps owns before production

These are outside what a MinIO run proves (§2):

1. IAM roles per processor matching the MinIO policies in §10, including `s3:ListBucket` for the
   fetcher (otherwise a missing object reads as 403, not 404).
2. If buckets use SSE-KMS: `kms:Decrypt` (fetcher) and `kms:GenerateDataKey` (persister) on the key.
   If a bucket policy *requires* an encryption header on `PUT`, say so — the persister then needs an
   `S3__ServerSideEncryption` option, which this design does not include.
3. Network path from the pods to S3 (VPC endpoint or egress) and the region.
4. Lifecycle rules: an object transitioned to Glacier fails ObjectFetcher's `GET` (`InvalidObjectState`).
5. The persister's single `PUT` is bounded by the client's 30 s timeout, so a 32 MiB object needs about
   9 Mbit/s to the bucket; that is comfortable in-region and not across a slow link.

## 12. Rejected shapes

**A separate `object-locator` row (`{objectUri}`) for the object pair.** Correct in isolation,
unwireable in practice: `kafka-importer` is one row with one `outputSchemaId`, so `KafkaImporter →
ObjectFetcher` would 422 at publish. Making ObjectFetcher's input null to dodge that would have lost
the publish-time check. Renaming the existing row's key to the neutral `location` (the user's choice,
2026-10-26) removed the conflict for every edge at once.

**Reusing `{filePath}` for `s3://` URIs.** Wireable with no migration, but the field would misdescribe
itself to every reader. Rejected for `location`.

**A shared `Storage.Core` library behind both pairs.** Would let one processor serve both volume and
S3. Rejected: the two pairs differ exactly where their correctness lives (dry inspection, staging vs
atomic PUT, missing-folder vs missing-bucket), and the repo's pattern is small self-contained
processors with copied records pinned by schema rows.

**MinIO as a pod in `k8s/`.** The first draft. A container matches how Kafka — the other piece of org
infrastructure — is stood up, needs no containerd import, and is reachable from the host without a
port-forward. Same image problem either way; the image is built from source for both.

**A pulled MinIO image.** None is available from MinIO any more. `bitnamilegacy/minio` is frozen;
`pgsty/minio` is a third-party fork whose `mc` has only a `latest` tag. Built from upstream source
instead (§10).

**Turning off SDK checksums / chunked encoding for MinIO.** Would make the test path differ from the
production path, which is the one property DevOps' "MinIO ⇒ S3" relies on.

## 13. Tests

**Unit (`src/tests/BaseApi.Tests/ObjectFetcher/`, `.../ObjectPersister/`), `IAmazonS3` substituted:**

- `ObjectUri` — one case table run against both copies: scheme case, bucket naming edges, empty and
  trailing-`/` keys, `?`/`#`/`%20`/spaces kept verbatim, 1024-byte limit, prefix normalisation.
- ObjectFetcher — every config rule (ported from `FileFetcherGuardTests`); 404/403/412 mapping;
  whitelist and size rejection happen **without** a `GetObject` call; `EtagToMatch` is sent; envelope
  fields per §4 (`createdUtc` null, name from last segment); a filesystem-path location refused as
  FileFetcher's.
- ObjectPersister — `SafeName` cases (ported); key = prefix + name; `NoSuchBucket` mapped to the
  payload message; output `{location}`; zero-byte content written.
- `EnvelopeContractTests` — the new writer/reader copies against `envelope.json`; the new `Locator`
  copies against `locator.json`.
- `ConfigSchemaConformanceTests` — both new config records against their new definitions.
- `ProcessorHost` graph resolves for both, with and without `S3__ServiceUrl`.

Schema-backed tests load `JsonSchema.Net.dll`, which Windows Application Control blocks on this
machine (2026-10-26); they run in the `mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim` container.

**End to end, not live C# suites (the user's decision, 2026-10-26).** The three live suites this
section first proposed are replaced by one run of the whole object chain:
`tools/copy-object-chain.py --start` copies `filefetcher-archiveexpander-chain` 1.0.0 into
`objectfetcher-archiveexpander-chain` 1.0.0 (object processors at the two ends, its own topics and
consumer group), and `tools/simulate-endless-object-feed.py` (then named `simulate-object-feed.py`) drives it with `simulate-endless-feed.py`'s
five roles, objects in `skp-in` instead of files on the node. Verified 2026-10-26, four cycles:

| role | observed |
|---|---|
| `badext` | ObjectFetcher `object s3://skp-in/sim/…-badext.dat rejected: extension '.dat' is not in the allowed list (.zip)` ×4, nothing downloaded |
| `corrupt` | ArchiveExpander's corrupt-signature failure ×4 |
| `triple` | Acme `an Acme item is exactly the .wav and the .json` failure ×4 |
| `artist` | `the author cancelled the branch` ×4, nothing persisted |
| `good` | `sim-NNNNNN-good.zip` ×4 and `track01.xml` in `skp-out`; 8 `{"location":"s3://skp-out/…"}` records on `skp-object-documents` |

Plus exactly 12 records on `skp-object-failures`, no `failed its schema` line in the importer,
either object processor or the exporter, and no `s3://` record on the original chain's topics.

The first run of it found a defect no unit test had pinned: `AmazonS3Config.RegionEndpoint`'s
setter clears `ServiceURL`, so setting the region after the endpoint sent every request to AWS
(403 on every `HEAD`, nothing in MinIO's trace). With a custom endpoint the region now only signs
(`AuthenticationRegion`), and `S3ClientTests` pins the client configuration for both copies.

## 14. Not in scope

- Changing FileFetcher, FilePersister or KafkaImporter beyond the `location` rename (done).
- Multipart upload, streaming, objects above the 32 MiB ceiling.
- Server-side encryption headers, object tags, custom metadata, storage class.
- Listing or watching a bucket — ObjectFetcher fetches the one object it is named, exactly as
  FileFetcher reads the one path it is named.
- WorkflowStudio / Valence palette entries, unless they hard-code the processor list (checked at plan
  time).

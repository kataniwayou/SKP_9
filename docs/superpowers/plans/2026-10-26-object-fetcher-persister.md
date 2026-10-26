# ObjectFetcher and ObjectPersister Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new processors, ObjectFetcher and ObjectPersister, that do what FileFetcher and FilePersister do against S3 instead of a mounted volume, proven end to end by a copy of the `filefetcher-archiveexpander-chain` workflow fed by a new object feed script.

**Architecture:** Each processor is a self-contained project copied in shape from its file counterpart (`Processor.FileFetcher`, `Processor.FilePersister`), talking plain S3 through `AWSSDK.S3`; MinIO vs AWS is configuration only. Both read and write the two registered shapes the file pair already uses (`locator` = `{location}`, `file-envelope`), so the copied workflow differs from the original only in which processor rows its two end steps point at and in its topics.

**Tech Stack:** .NET 8 (SDK 8.0.427), `AWSSDK.S3` 4.0.104.2 / `AWSSDK.Core` 4.0.102.9, xUnit v3 on Microsoft Testing Platform, NSubstitute 5.3.0, Python 3.12 + `confluent_kafka` for the tools, the `skp-minio` container (`tools/minio-dev.ps1`).

**Spec:** `docs/superpowers/specs/2026-10-26-object-fetcher-persister-design.md`

## Global Constraints

- Restore is offline: every package (including transitive) must be a `.nupkg` in `nugets/`; versions live only in `Directory.Packages.props`; a transitive-only package still needs a `<PackageVersion>` line (NU1004, see the Quartz comment there).
- `AWSSDK.S3` **4.0.104.2** and `AWSSDK.Core` **4.0.102.9** (both published 2026-10-08; on net8.0 neither has further dependencies).
- No credential is read by our code: `new AmazonS3Client(AmazonS3Config)` with no credentials argument, so the SDK default chain resolves them.
- No Kubernetes Secret: MinIO credentials are plain `env` in the manifests (`objectfetcher` / `objectfetcher-dev-key`, `objectpersister` / `objectpersister-dev-key`, as in `tools/minio-dev.ps1`).
- SDK request checksums stay at their default (spec §8): do not set `RequestChecksumCalculation`/`ResponseChecksumValidation`.
- `AmazonS3Config.Timeout` = 30 s; every SDK call receives the dispatch `CancellationToken`.
- Every failure is a `FailedException` with the exact prefixes of spec §6; processors never log a failure themselves; failure messages never quote upstream content (a swallowed `JsonException` reports only its class of fault).
- The URI is parsed by hand (spec §3), never `System.Uri`; the key is taken verbatim.
- Pod ceiling `ObjectFetcher__MaxObjectSizeBytes`, default `33554432`, not clamped.
- Envelope `createdUtc` is always `null`; `modifiedUtc` = `LastModified` UTC; no location in the envelope.
- ObjectPersister's success log template is FilePersister's exactly: `"persisted {FileName} ({Extension}), {SizeBytes} bytes, to {FilePath}"`.
- Each processor is its own assembly; the two never reference each other. Shared shapes (`Locator`, `ObjectUri`, `ExtensionWhitelist`, `FetchedFile`, `PersistableFile`) are copied, pinned by schema rows and tests.
- Every source file you touch in an existing processor changes its SourceHash and forces a rebuild + row repoint. Touch only the files this plan names.
- Schema-backed tests (`JsonSchema.Net`) are blocked by Windows Application Control on this machine; run them in `mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim` (command in Task 2). Everything else runs on Windows with `dotnet bin/Debug/net8.0/BaseApi.Tests.dll --filter-class "<class>"` (the MTP runner; `dotnet test --filter` is ignored).
- In Git Bash, prefix `docker exec` commands that pass unix paths with `MSYS_NO_PATHCONV=1`; run the Python feed tools from PowerShell.

## Review Focus

1. **A key with spaces, `+`, `%` or non-ASCII** (`s3://skp-in/feeds/a b+c%20ü.zip`) — must reach `HEAD`/`GET` byte-for-byte, and a persisted name with them must come back in `{location}` unencoded. Tests in Task 3 and Task 4.
2. **A body shorter than the `HEAD`'s length** (connection cut mid-read) — must fail `reading <uri> failed: the body ended after N of M bytes`, never emit a short envelope. Test in Task 3.
3. **The dispatch being cancelled during an S3 call** — `OperationCanceledException` must escape, not be reported as a failed step. Tests in Task 3 and Task 4.
4. **Pods resolving `skp-minio` to its IPv6 address** — the trap `docs/rebuild-filefetcher-archiveexpander-chain.md` Appendix C6 documents for `skp-kafka`; symptom `Network is unreachable`. Checked from both new pods in Task 5, with the same `hostAliases` fix if it bites.
5. **The two chains running at once** — the copy must never share a topic or consumer group with the original, or each would steal the other's records. Asserted by the dry run in Task 6.

---

### Task 1: Vendor the AWS SDK packages

**Files:**
- Create: `nugets/awssdk.s3.4.0.104.2.nupkg`, `nugets/awssdk.core.4.0.102.9.nupkg`
- Modify: `Directory.Packages.props` (new `<!-- S3 -->` group), `nugets/README.md` (one paragraph: why these two, offline, net8.0 has no further deps)

**Interfaces:**
- Produces: `<PackageReference Include="AWSSDK.S3" />` resolves offline for any project.

- [ ] **Step 1: Download both packages into `nugets/`**

```bash
curl -sfL -o nugets/awssdk.s3.4.0.104.2.nupkg https://api.nuget.org/v3-flatcontainer/awssdk.s3/4.0.104.2/awssdk.s3.4.0.104.2.nupkg
curl -sfL -o nugets/awssdk.core.4.0.102.9.nupkg https://api.nuget.org/v3-flatcontainer/awssdk.core/4.0.102.9/awssdk.core.4.0.102.9.nupkg
```

- [ ] **Step 2: Add `<PackageVersion Include="AWSSDK.S3" Version="4.0.104.2" />` and `<PackageVersion Include="AWSSDK.Core" Version="4.0.102.9" />`** to `Directory.Packages.props`, with a comment that Core is transitive-only and pinned for the NU1004 reason.

- [ ] **Step 3: Verify** — deferred to Task 2 Step 4 (the first project that references the package proves the offline restore). Do not commit alone.

---

### Task 2: ObjectFetcher project skeleton and `ObjectUri`

**Files:**
- Create: `src/Processor.ObjectFetcher/Processor.ObjectFetcher.csproj` (copy of FileFetcher's: `InternalsVisibleTo BaseApi.Tests`, `appsettings.json` copied, `BaseProcessor.Core` `VersionOverride="[1.0.0]"`, plus `<PackageReference Include="AWSSDK.S3" />`)
- Create: `src/Processor.ObjectFetcher/Program.cs`, `ProcessorHost.cs`, `appsettings.json`, `Dockerfile` (copies of FileFetcher's with names changed; Dockerfile builds `src/Processor.ObjectFetcher`)
- Create: `src/Processor.ObjectFetcher/ObjectUri.cs`, `S3Options.cs`, `S3Client.cs`
- Modify: `SK_P.sln` (add project), `src/tests/BaseApi.Tests/BaseApi.Tests.csproj` (ProjectReference)
- Test: `src/tests/BaseApi.Tests/ObjectStorage/ObjectUriTests.cs`

**Interfaces:**
- Produces:
  - `internal sealed record ObjectUri(string Bucket, string Key)` with `public override string ToString()` → `s3://{Bucket}/{Key}`
  - `internal static bool ObjectUri.TryParse(string? text, bool keyIsPrefix, out ObjectUri? uri, out string? reason)` — `reason` is the operator-facing sentence on failure, quoting the bucket when the bucket is the fault; `keyIsPrefix: false` = object key rules, `true` = prefix rules (spec §3)
  - `public sealed class S3Options { string? ServiceUrl; bool ForcePathStyle; string? Region; }` bound from section `"S3"`
  - `internal static IAmazonS3 S3Client.Create(S3Options options)` — `AmazonS3Config { ServiceURL (when set), ForcePathStyle, RegionEndpoint (when set), Timeout = 30 s }`, no credentials argument

- [ ] **Step 1: Write the failing test table** `ObjectUriTests.Parses(string text, bool prefix, string? bucket, string? key, string? reasonFragment)` as a `[Theory]`. Rows (expected bucket/key, or the reason fragment):

| text | prefix | bucket | key | reason contains |
|---|---|---|---|---|
| `s3://skp-in/feeds/a.zip` | false | `skp-in` | `feeds/a.zip` | |
| `S3://skp-in/a.zip` | false | `skp-in` | `a.zip` | |
| `s3://skp-in/a b+c%20ü.zip` | false | `skp-in` | `a b+c%20ü.zip` | |
| `s3://skp-in/q?x=1#f` | false | `skp-in` | `q?x=1#f` | |
| `s3://skp-in/` | false | | | `names no object` |
| `s3://skp-in/dir/` | false | | | `names a folder` |
| `s3://Skp-In/a.zip` | false | | | `'Skp-In'` |
| `s3://ab/a.zip` | false | | | `'ab'` |
| `s3://-bad/a.zip` | false | | | `'-bad'` |
| `/mnt/skp-files/in/a.zip` | false | | | `not an s3:// location` |
| `s3://skp-in/` + 1025×`a` | false | | | `1024` |
| `s3://skp-out` | true | `skp-out` | `` | |
| `s3://skp-out/` | true | `skp-out` | `` | |
| `s3://skp-out/acme` | true | `skp-out` | `acme/` | |
| `s3://skp-out/acme/` | true | `skp-out` | `acme/` | |

The test class is written so Task 4 can add the persister's copy as a second implementation run against the same rows (e.g. a `MemberData` of parser delegates).

- [ ] **Step 2: Run it to see it fail** — `cd src/tests/BaseApi.Tests && dotnet build` → error CS0246 `ObjectUri` not found.

- [ ] **Step 3: Create the project files and implement `ObjectUri.TryParse`, `S3Options`, `S3Client.Create`.** Bucket rule: 3–63 chars, `[a-z0-9.-]`, first and last a letter or digit. Key length is measured in UTF-8 bytes.

- [ ] **Step 4: Run the tests; this also proves Task 1's offline restore**

```bash
cd src/tests/BaseApi.Tests && dotnet build && dotnet bin/Debug/net8.0/BaseApi.Tests.dll --filter-class "BaseApi.Tests.ObjectStorage.ObjectUriTests"
```
Expected: restore succeeds offline; all 15 rows pass.

- [ ] **Step 5: Commit** `nugets/awssdk.*.nupkg Directory.Packages.props nugets/README.md SK_P.sln src/Processor.ObjectFetcher src/tests/BaseApi.Tests/BaseApi.Tests.csproj src/tests/BaseApi.Tests/ObjectStorage` and every `packages.lock.json` the restore changed — `feat(objectfetcher): project, AWSSDK.S3 vendored, the s3:// location parser`.

Schema-test container command, used from Task 3 on:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "C:/Users/katan/source/repos/SK_P11:/src:ro" mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim bash -c '
mkdir /work && cd /src && tar --exclude=node_modules --exclude=bin --exclude=obj --exclude=.git --exclude=.playwright-mcp --exclude=dist -cf - . | tar -C /work -xf -
cd /work/src/tests/BaseApi.Tests && dotnet build -v q >/dev/null && dotnet bin/Debug/net8.0/BaseApi.Tests.dll --filter-class "<class>" ...'
```
(`EnvelopeContractTests.APlainFileSurvivesBothHops` fails there by platform — Linux cannot set a creation time — and is the one expected failure.)

---

### Task 3: ObjectFetcherProcessor

**Files:**
- Create: `src/Processor.ObjectFetcher/ObjectFetcherProcessor.cs`, `ObjectFetcherConfig.cs`, `ObjectFetcherOptions.cs`, `Locator.cs` (copy of FileFetcher's record), `ExtensionWhitelist.cs` (verbatim copy), `FetchedFile.cs` (verbatim copy, namespace changed)
- Modify: `src/Processor.ObjectFetcher/ProcessorHost.cs` (bind `"ObjectFetcher"` → `ObjectFetcherOptions`, `"S3"` → singleton `IAmazonS3` via `S3Client.Create`, register the processor)
- Create: `src/tests/BaseApi.Tests/Schemas/object-fetcher-config.json` (definition identical to `file-fetcher-config` in `docs/rebuild-filefetcher-archiveexpander-chain.md` §2.4)
- Test: `src/tests/BaseApi.Tests/ObjectFetcher/ObjectFetcherGuardTests.cs`, `ObjectFetcherReadTests.cs`, `ObjectFetcherHostTests.cs`; Modify: `src/tests/BaseApi.Tests/Processor/ConfigSchemaConformanceTests.cs` (one row)

**Interfaces:**
- Consumes: `ObjectUri.TryParse`, `S3Client.Create`, `S3Options` (Task 2)
- Produces:
  - `public sealed record ObjectFetcherConfig(long MinimumSizeBytes, long MaximumSizeBytes, IReadOnlyList<string>? AllowedExtensions = null) : ProcessorConfig`
  - `public sealed class ObjectFetcherOptions { long MaxObjectSizeBytes = 33_554_432; }` (`[ConfigurationKeyName("MaxObjectSizeBytes")]`)
  - `internal sealed class ObjectFetcherProcessor(ILogger<ObjectFetcherProcessor>, IOptions<ObjectFetcherOptions>, IAmazonS3) : BaseProcessor<ObjectFetcherConfig>`
  - `public static class ProcessorHost` with `StartAsync`/`Create` signatures identical to FileFetcher's

- [ ] **Step 1: Write the failing guard tests** — port `FileFetcherGuardTests` and `FileFetcherLocatorTests` case for case (config rules, ceiling message naming `ObjectFetcher__MaxObjectSizeBytes`, not-JSON without quoting, no `location`), with a substituted `IAmazonS3` that is never reached by these cases (`s3.ReceivedCalls()` empty). Add:
  - `AFilesystemPathIsRefusedAsFileFetchers`: `{"location":"/mnt/skp-files/in/a.zip"}` → message starts `input branch did not name a location this processor reads:` and contains `FileFetcher's`.

- [ ] **Step 2: Write the failing read tests** (`ObjectFetcherReadTests`), stubbing `GetObjectMetadataAsync` / `GetObjectAsync`:
  - `TheObjectIsInspectedThenReadWithItsETag`: HEAD returns length 7, ETag `"abc"`; GET body `id,name` → one branch; `GetObjectAsync` received a request with `BucketName == "skp-in"`, `Key == "feeds/orders.csv"`, `EtagToMatch == "\"abc\""`.
  - `TheEnvelopeCarriesTheObjectsIdentity`: `fileName` `orders.csv`, `extension` `.csv`, `sizeBytes` 7, `createdUtc` JSON `null` (present), `modifiedUtc` = HEAD's `LastModified`, `content` base64 of the body; no `location` property.
  - `ARejectedExtensionIsNeverDownloaded` and `ARejectedSizeIsNeverDownloaded`: messages `object s3://skp-in/… rejected: extension '.dat' is not in the allowed list (.zip)` / `… bytes is above the … byte ceiling`; `GetObjectAsync` not received.
  - `AMissingObjectFails` (HEAD throws `AmazonS3Exception` with `StatusCode = NotFound`) → `reading s3://skp-in/x.zip failed: it does not exist (bucket or key)`.
  - `AForbiddenObjectFails` (`Forbidden`) → `… failed: access denied`.
  - `AReplacedObjectFails` (GET throws `PreconditionFailed`) → `… failed: it changed between inspection and read`.
  - `ATruncatedBodyFails` (HEAD length 10, body 4 bytes) → `… failed: the body ended after 4 of 10 bytes`.
  - `AKeyIsSentVerbatim`: location `s3://skp-in/a b+c%20ü.zip` → HEAD and GET received `Key == "a b+c%20ü.zip"`.
  - `ACancelledDispatchIsNotAFailedStep`: HEAD throws `OperationCanceledException` for a cancelled token → `Assert.ThrowsAsync<OperationCanceledException>`.

- [ ] **Step 3: Run both to see them fail** — build error, then failures.

- [ ] **Step 4: Implement** `ObjectFetcherConfig`, `ObjectFetcherOptions`, `Locator`, the copies, and `ObjectFetcherProcessor.ProcessAsync` in spec §4's order (config → locator → `HEAD` → checks → `GET` with `EtagToMatch` into a `byte[ContentLength]` → envelope → one `SendToPostAsync` on the dispatch's `executionId`). Map `AmazonS3Exception` by `StatusCode`; let `OperationCanceledException` propagate; success log line is FileFetcher's template. In SDK 4 `ContentLength`/`LastModified` may be nullable — a missing length fails `reading … failed: the server reported no length`.

- [ ] **Step 5: Write `ObjectFetcherHostTests.TheGraphResolves(withServiceUrl: bool)`** — mirror the existing FileFetcher host test, configuring `S3:ServiceUrl=http://localhost:19000` in one case and nothing in the other; `host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>()` is an `ObjectFetcherProcessor`. Add the `ConfigSchemaConformanceTests` row: `typeof(ObjectFetcherConfig)` against `Schemas/object-fetcher-config.json`.

- [ ] **Step 6: Run** the non-schema classes on Windows (`ObjectFetcherGuardTests`, `ObjectFetcherReadTests`, `ObjectFetcherHostTests`) and `ConfigSchemaConformanceTests` in the container. Expected: all pass.

- [ ] **Step 7: Commit** — `feat(objectfetcher): an s3:// location in, the file envelope out, inspected dry before it is read`.

---

### Task 4: ObjectPersister

**Files:**
- Create: `src/Processor.ObjectPersister/` — `Processor.ObjectPersister.csproj`, `Program.cs`, `ProcessorHost.cs`, `appsettings.json`, `Dockerfile` (shape of FilePersister's; no options section besides `"S3"`), `ObjectPersisterProcessor.cs`, `ObjectPersisterConfig.cs`, `Locator.cs` + `LocatorJson` (copy of FilePersister's writer record), `PersistableFile.cs` (verbatim copy), `ObjectUri.cs` (verbatim copy of Task 2's, namespace changed), `S3Options.cs`, `S3Client.cs` (copies)
- Modify: `SK_P.sln`, `BaseApi.Tests.csproj` (ProjectReference)
- Create: `src/tests/BaseApi.Tests/Schemas/object-persister-config.json` — `{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","required":["destinationUri"],"properties":{"destinationUri":{"type":"string","minLength":1}},"additionalProperties":false}`
- Test: `src/tests/BaseApi.Tests/ObjectPersister/ObjectPersisterTests.cs`, `ObjectPersisterHostTests.cs`; Modify: `ObjectStorage/ObjectUriTests.cs` (second implementation), `ConfigSchemaConformanceTests.cs` (one row), `EnvelopeContractTests.cs`

**Interfaces:**
- Consumes: Task 2's `ObjectUri`/`S3Options`/`S3Client` shapes (copied, not referenced)
- Produces:
  - `public sealed record ObjectPersisterConfig(string? DestinationUri) : ProcessorConfig`
  - `internal sealed class ObjectPersisterProcessor(ILogger<ObjectPersisterProcessor>, IAmazonS3) : BaseProcessor<ObjectPersisterConfig>`
  - output branch `{"location":"s3://<bucket>/<prefix><fileName>"}`

- [ ] **Step 1: Add the persister's `ObjectUri` to `ObjectUriTests`** so all 15 rows run against both copies. Run → build error.

- [ ] **Step 2: Write the failing `ObjectPersisterTests`** (port FilePersister's envelope and `SafeName` cases case for case), plus:
  - `TheBytesArePutUnderThePrefix`: payload `{"DestinationUri":"s3://skp-out/acme"}`, envelope `orders.csv` `[1,2,3]` → `PutObjectAsync` received `BucketName "skp-out"`, `Key "acme/orders.csv"`, body bytes `[1,2,3]`.
  - `TheLocationNamesWhatWasWritten`: the single branch's JSON has exactly one property `location` = `s3://skp-out/acme/orders.csv`.
  - `AZeroByteFileIsWritten`.
  - `ANameWithSpacesAndUnicodeIsWrittenAndReportedVerbatim`: `a b+ü.csv` → key `acme/a b+ü.csv`, location `s3://skp-out/acme/a b+ü.csv`.
  - `AMissingBucketIsAPayloadFault`: put throws `AmazonS3Exception { ErrorCode = "NoSuchBucket", StatusCode = NotFound }` → `step payload rejected: bucket 'skp-out' does not exist; this processor does not create it`.
  - `AForbiddenWriteFails` → `writing s3://skp-out/acme/orders.csv failed: access denied`.
  - `AKeyOverTheLimitIsRejected` (prefix + name > 1024 UTF-8 bytes) → starts `file name '`, contains `1024`.
  - `ANonS3DestinationIsAPayloadFault`: `"/mnt/skp-files/out"` → starts `step payload rejected:`.
  - `ACancelledDispatchIsNotAFailedStep`.

- [ ] **Step 3: Run to see them fail.**

- [ ] **Step 4: Implement** `ObjectPersisterProcessor.ProcessAsync` in spec §5's order (config → envelope → `SafeName` → key → one `PutObjectAsync` from a `MemoryStream` → `{location}` → one `SendToPostAsync`). No staging, no read-back, no `HeadBucket`.

- [ ] **Step 5: Host test, conformance row, envelope contract.** `ObjectPersisterHostTests` mirrors Task 3's. `ConfigSchemaConformanceTests` row for `ObjectPersisterConfig`. `EnvelopeContractTests`: (a) ObjectFetcher's envelope (from a stubbed fetch) validates against `envelope.json` and parses as ObjectPersister's `PersistableFile`; (b) ObjectPersister's `{location}` validates against `locator.json` and parses as ObjectFetcher's `Locator`.

- [ ] **Step 6: Run** the persister classes on Windows and the schema classes (`ConfigSchemaConformanceTests`, `EnvelopeContractTests`, `ObjectUriTests`) in the container. Expected: all pass but the one documented platform failure.

- [ ] **Step 7: Commit** — `feat(objectpersister): the file envelope in, one PUT, the s3:// location out`.

---

### Task 5: Deploy both processors to kind

**Files:**
- Create: `k8s/44-processor-objectfetcher.yaml`, `k8s/45-processor-objectpersister.yaml` (from 38 and 40 per spec §10: no volumes, no initContainer, no `FilePersister__TempExtension`; add `S3__ServiceUrl=http://skp-minio:9000`, `S3__ForcePathStyle=true`, `S3__Region=us-east-1`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` = the processor's MinIO user; fetcher also `ObjectFetcher__MaxObjectSizeBytes=33554432`)
- Modify: `k8s/kustomization.yaml` (two resources)

**Interfaces:**
- Consumes: the two Dockerfiles (Tasks 3–4); schema JSON files (Tasks 3–4)
- Produces: processor rows `object-fetcher` (in `locator`, out `file-envelope`, config `object-fetcher-config`) and `object-persister` (in `file-envelope`, out `locator`, config `object-persister-config`), both version `1.0.0`; two Ready pods.

- [ ] **Step 1: Build, import, read hashes**

```bash
for p in ObjectFetcher ObjectPersister; do t=processor-$(echo $p | tr A-Z a-z):local; docker build -q -f src/Processor.$p/Dockerfile -t $t . && docker save --platform linux/amd64 $t | docker exec -i desktop-control-plane ctr -n k8s.io images import -; dotnet build src/Processor.$p/Processor.$p.csproj | grep -o "SourceHash (Processor.$p): [0-9a-f]*"; done
```

- [ ] **Step 2: Register the two config schema rows and the two processor rows** with `POST /api/v1/schemas` (bodies from the two JSON files, descriptions from spec §7) and `POST /api/v1/processors` (`instanceId: null`, the schema ids above, the hashes from Step 1). The `locator` row is `95aa9da6-4c35-412c-9f67-0183f36739d7`, `file-envelope` is `85f9c137-e254-4e3e-acc6-63b7e6f5c3cc`.

- [ ] **Step 3: Apply and wait** — `kubectl apply -k k8s/`; both pods `1/1 Running` (readiness = identity resolved, so Ready proves the image hash matches the row).

- [ ] **Step 4: Check MinIO is reachable from both pods (Review Focus 4)**

```bash
for d in processor-objectfetcher processor-objectpersister; do kubectl -n skp exec deploy/$d -- getent hosts skp-minio; done
```
Expected: an IPv4 address. If it is IPv6, apply Appendix C6's `hostAliases` patch to both Deployments with `skp-minio`'s IPv4, and record it in each manifest's header comment as Kafka's is.

- [ ] **Step 5: Commit** the two manifests and `kustomization.yaml` — `feat(k8s): objectfetcher and objectpersister, against skp-minio`.

---

### Task 6: Copy the chain workflow onto the object processors

**Files:**
- Create: `tools/copy-object-chain.py`

**Interfaces:**
- Consumes: the live `filefetcher-archiveexpander-chain` 1.0.0 (10 steps, 10 assignments, cache `chain-artists`); processor rows from Task 5
- Produces: workflow `objectfetcher-archiveexpander-chain` 1.0.0, started; Kafka topics `skp-object-paths`, `skp-object-documents`, `skp-object-failures`.

Behaviour (the script's whole contract):
- Reads the source workflow by name+version via `GET /api/v1/workflows`, its steps by walking `entryStepIds`/`nextStepIds`, its assignments from `assignmentIds`, its `cacheIds` and `cronExpression`.
- Step names: `split-` → `obj-`; any other name gets `obj-` prefixed (`record-outcome` → `obj-record-outcome`). Processor ids: `file-fetcher` → `object-fetcher`, `file-persister` → `object-persister` (looked up by name); every other processor id is kept. Entry conditions, descriptions and versions kept.
- Payloads verbatim except: the `kafka-importer` step → `topic` `skp-object-paths`, `consumerGroup` `skp-objectchain`; the `file-persister` step → `{"destinationUri": "s3://skp-out/"}`; the exporter fed by the persister → `topic` `skp-object-documents`; the exporter fed by `record-outcome` → `topic` `skp-object-failures`. Assignment names get the same `split-`→`obj-` mapping.
- Two passes as in the rebuild guide (steps with `nextStepIds: null`, then `PUT` with mapped edges), then assignments, then `POST /api/v1/workflows` (same `cacheIds`, same cron, description `"copy of filefetcher-archiveexpander-chain 1.0.0 with object-fetcher / object-persister at the ends"`).
- Creates the three topics with `docker exec skp-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --create --if-not-exists --topic … --partitions 1 --replication-factor 1`.
- Refuses to run if a workflow of the target name+version already exists (prints its id). `--dry-run` prints every step/assignment it would create, with processor names and payloads, and touches nothing. `--start` posts `/orchestration/start` at the end.

- [ ] **Step 1: Write the script.**

- [ ] **Step 2: Dry run and check it (Review Focus 5)**

Run (PowerShell): `python tools/copy-object-chain.py --dry-run`
Expected: 10 steps, 10 assignments; exactly two steps change processor (`obj-filefetcher` → `object-fetcher`, `obj-filepersister` → `object-persister`); no payload mentions `skp-paths`, `skp-splitchain`, `skp-documents`, `skp-failures` or `/mnt/skp-files`.

- [ ] **Step 3: Create and start** — `python tools/copy-object-chain.py --start`. Expected: `202`; `GET /api/v1/orchestration/live` lists both chain workflow ids.

- [ ] **Step 4: Commit** — `feat(tools): copy the chain workflow onto the object processors`.

---

### Task 7: The object feed, and the end-to-end run

**Files:**
- Create: `tools/simulate-object-feed.py`
- Modify: `docs/superpowers/specs/2026-10-26-object-fetcher-persister-design.md` §13 (the live C# suites are replaced by this run, the user's decision 2026-10-26), `k8s/README.md` (a short "Object chain" section: `minio-dev.ps1 -Up`, `copy-object-chain.py --start`, `simulate-object-feed.py`)

**Interfaces:**
- Consumes: `simulate-endless-feed.py` loaded by path as `simulate-approved-feed.py` does (`_load_base`), reusing `build_cycle`, `roles_for`, `tar_stream`, `wait_for_drain`, `produce`, `say`; the workflow and topics from Task 6
- Produces: records `{"location":"s3://skp-in/sim/sim-NNNNNN-<role><ext>"}` on `skp-object-paths`.

Behaviour: the same five roles per cycle and the same loop as `simulate-endless-feed.py`, with the kind node replaced by the MinIO container:
- push: one `docker exec -i skp-minio sh -c 'rm -rf /tmp/feed && mkdir /tmp/feed && tar -xf - -C /tmp/feed && mc cp --quiet --recursive /tmp/feed/ local/skp-in/sim/ && rm -rf /tmp/feed'` per cycle, objects before records;
- count: `mc ls --recursive local/skp-in` lines; wipe: `mc rm --recursive --force local/skp-in local/skp-out` after `wait_for_drain` on `skp-objectchain`;
- defaults: `--brokers localhost:19092 --topic skp-object-paths --group skp-objectchain --container skp-minio --prefix sim/`; every other flag as the base script's (`--interval 30 --cycles 0 --max-files 50 --settle 10 --drain-timeout 120 --force-wipe --no-wipe --approved-artist --start-serial --dry-run`).

- [ ] **Step 1: Write the script; dry run** — `python tools/simulate-object-feed.py --dry-run --cycles 1 --out-dir ./out` prints five files and five `s3://skp-in/sim/…` locations, touching nothing.

- [ ] **Step 2: Run four cycles** (PowerShell): `python tools/simulate-object-feed.py --cycles 4 --no-wipe --start-serial 1`, then wait for the importer's lag on `skp-objectchain` to reach 0 and two more cron fires.

- [ ] **Step 3: Verify per role, against what the feed's docstring says each role must do**

| role | expected | where to look |
|---|---|---|
| `badext` | ObjectFetcher fails `object s3://skp-in/sim/sim-00000N-badext.dat rejected: extension '.dat' is not in the allowed list (.zip)` ×4 | `kubectl logs deploy/processor-objectfetcher` |
| `corrupt` | ArchiveExpander's corrupt-signature failure ×4 | expander logs |
| `triple` | Acme `ValidateContent` failure ×4 | sknormalizer logs |
| `artist` | `the author cancelled the branch` ×4, nothing persisted | sknormalizer logs |
| `good` | `sim-00000N-good.zip` and `track01.xml` in `skp-out` (`docker exec skp-minio mc ls local/skp-out`); matching `{"location":"s3://skp-out/…"}` records on `skp-object-documents` | MinIO, Kafka |

Plus: exactly 12 records on `skp-object-failures` (three per cycle); zero `failed its schema` lines in the importer, objectfetcher, objectpersister and exporter logs; the original chain's topics received nothing from this run.

- [ ] **Step 4: Update the spec's §13 and `k8s/README.md`; commit** — `feat(tools): the object feed, and the object chain proven end to end`.

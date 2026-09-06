# PathImporter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `Processor.PathImporter`, a source-step processor that consumes file paths from an org Kafka topic and turns each one into its own lineage with its own execution id.

**Architecture:** A concrete processor in the shape of `Processor.Sample` — a thin shell over `BaseProcessor<TConfig>`, with all Kafka concerns in author code and nothing in `BaseProcessor.Core` touched. The Kafka client sits behind a four-method seam (`IPathConsumer`) so the whole consume loop is testable with a fake and no broker runs in the hermetic suite. One consumer is cached on the processor across dispatches and evicted on fault.

**Tech Stack:** .NET 8 (SDK 8.0.421), xUnit v3 under MTP, NSubstitute, `Confluent.Kafka`, offline NuGet feed with lock files.

**Spec:** `docs/superpowers/specs/2026-09-06-path-importer-design.md` — read it alongside this plan. Section references below (§4, §6…) point into it.

## Global Constraints

- **Target framework `net8.0`**, `Nullable=enable`, `TreatWarningsAsErrors=true` — all from `Directory.Build.props`. Never restate them in a csproj. A nullable warning is a build failure.
- **Central Package Management.** Every version is pinned in `Directory.Packages.props`. A `PackageReference` in a csproj carries **no** `Version` attribute. This repo's own libraries are the exception and use `VersionOverride="[1.0.0]"`.
- **`RestorePackagesWithLockFile=true`.** Every project has a `packages.lock.json`. Adding a package changes it, and the changed file is committed.
- **The build is offline.** `NuGet.config` clears nuget.org and every fallback folder. A package not present in `nugets/` fails restore with NU1101. There is no `dotnet add package` in this repo.
- **Test command:** `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`. To run one test: append `-- --filter-method "*TestName*"`. **Note:** category filters are silently ignored under MTP, so any run is the full suite.
- **Hermetic baseline is a shape, not a number:** `0 failed`, exit code `0`, and every test under `Live/` skipped. The count only grows. Never compare against a remembered total.
- **All new tests are hermetic.** No Kafka, no network, no broker. Anything needing a real broker goes under `src/tests/BaseApi.Tests/Live/` and is out of scope for this plan.
- **Commit messages** follow the house style: a `type(scope): ` subject in the imperative, then a body that argues *why*. End every commit with the two trailer lines used across this repo (`Co-Authored-By:` and `Claude-Session:`), copied from `git log -1` on any recent commit.

---

## Prerequisite: the offline feed needs Kafka packages (human, network required)

**This blocks Task 1 and cannot be done by an agent inside this repo.** `NuGet.config` clears nuget.org, so restore cannot fetch anything. The `.nupkg` files must be placed into `nugets/` by hand from a machine with network access.

On a networked machine:

```bash
nuget install Confluent.Kafka -Version 2.6.1 -OutputDirectory ./staging -DependencyVersion Highest
# or: dotnet restore a scratch project referencing Confluent.Kafka, then collect from ~/.nuget/packages
```

Copy these into `nugets/` (lowercased filenames, matching the existing convention):

- `confluent.kafka.2.6.1.nupkg`
- `librdkafka.redist.2.6.1.nupkg`

`librdkafka.redist` is roughly 40 MB of per-RID native binaries. That is expected — §10 of the spec accounts for it.

**Verify the closure is complete** rather than assuming it is two packages. After Task 1's csproj exists, run `dotnet restore src/Processor.PathImporter/Processor.PathImporter.csproj` and read any `NU1101: Unable to find package X` errors — each one names another `.nupkg` to fetch. Repeat until restore succeeds. Do not proceed to Task 1 Step 4 until it does.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/Processor.PathImporter/Processor.PathImporter.csproj` | Project shell; the one `Confluent.Kafka` reference |
| `src/Processor.PathImporter/Program.cs` | Entry point; signal handling. Copy of the sample's |
| `src/Processor.PathImporter/ProcessorHost.cs` | Composition root; registers the processor and the consumer factory |
| `src/Processor.PathImporter/appsettings.json` | Host defaults. No Kafka keys — those travel in the step payload |
| `src/Processor.PathImporter/PathImporterConfig.cs` | The flat five-field step-payload record |
| `src/Processor.PathImporter/PathImporterProcessor.cs` | The consume loop, the cache, the three terminals |
| `src/Processor.PathImporter/StopReason.cs` | `Completed` / `Drained` / `Faulted` |
| `src/Processor.PathImporter/Kafka/IPathConsumer.cs` | The seam: the only thing the loop knows about Kafka |
| `src/Processor.PathImporter/Kafka/PathRecord.cs` | One consumed path plus its offset, free of Confluent types |
| `src/Processor.PathImporter/Kafka/IPathConsumerFactory.cs` | Builds a consumer for a broker list and group |
| `src/Processor.PathImporter/Kafka/KafkaConsumerSettings.cs` | The `ConsumerConfig` builder — pure, so it is testable |
| `src/Processor.PathImporter/Kafka/KafkaPathConsumer.cs` | The real adapter over `IConsumer<Ignore, string>` |
| `src/Processor.PathImporter/Kafka/KafkaPathConsumerFactory.cs` | Produces `KafkaPathConsumer` |
| `src/Processor.PathImporter/Kafka/KafkaFaultClassifier.cs` | Deterministic allow-list; everything else transient |
| `src/tests/BaseApi.Tests/PathImporter/FakePathConsumer.cs` | Test double for the seam |
| `src/tests/BaseApi.Tests/PathImporter/PathImporterConfigTests.cs` | Binding and the null-config failure |
| `src/tests/BaseApi.Tests/PathImporter/KafkaFaultClassifierTests.cs` | Both arms of the allow-list |
| `src/tests/BaseApi.Tests/PathImporter/KafkaConsumerSettingsTests.cs` | The four settings §4 depends on |
| `src/tests/BaseApi.Tests/PathImporter/PathImporterLoopTests.cs` | Terminals, ordering, ids, logging |
| `src/tests/BaseApi.Tests/PathImporter/PathImporterCacheTests.cs` | Reuse, rebuild, eviction, disposal |
| `k8s/34-processor-pathimporter.yaml` | Deployment; one replica, `maxSurge: 0` |

**Modified:**

| File | Change |
|---|---|
| `Directory.Packages.props` | Pin `Confluent.Kafka` |
| `SK_P.sln` | Add the new project |
| `src/tests/BaseApi.Tests/BaseApi.Tests.csproj` | `ProjectReference` to the new project |
| `k8s/kustomization.yaml` | List the new manifest |

---

## Task 1: Project shell, flat config, offline packaging

Creates the project so it restores offline and builds, and lands the config record with the one behaviour it owns: a missing payload is a business failure, not a default.

**Files:**
- Create: `src/Processor.PathImporter/Processor.PathImporter.csproj`, `Program.cs`, `ProcessorHost.cs`, `appsettings.json`, `PathImporterConfig.cs`
- Modify: `Directory.Packages.props`, `SK_P.sln`, `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
- Test: `src/tests/BaseApi.Tests/PathImporter/PathImporterConfigTests.cs`

**Interfaces:**
- Consumes: `BaseProcessor.Core` as a package (`VersionOverride="[1.0.0]"`), already present in `nugets/` feeds.
- Produces: `Processor.PathImporter.PathImporterConfig(string BrokerList, string Topic, string ConsumerGroup, int MessageCount, int IdleTimeoutSeconds)`, a `sealed record` deriving `ProcessorConfig`. Later tasks bind it from a JSON payload string.

- [ ] **Step 1: Pin the package**

In `Directory.Packages.props`, add inside the existing `<ItemGroup>`, after the `RabbitMQ.Client` block:

```xml
    <!-- Kafka consumer for Processor.PathImporter, and the only thing in this solution that speaks
         it. The native librdkafka binaries arrive through the transitive librdkafka.redist package,
         which is why no second PackageReference names it: pinning it here would be pinning a
         dependency the client already carries, and CPM would then police two versions instead of
         one. -->
    <PackageVersion Include="Confluent.Kafka" Version="2.6.1" />
```

- [ ] **Step 2: Create the project file**

`src/Processor.PathImporter/Processor.PathImporter.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <!--
    The second concrete processor, and the first component here that speaks to Kafka. Like
    Processor.Sample it carries no identity, liveness, broker or Redis code — AddBaseProcessor folds
    all of it in — but unlike the sample it carries real work: it reads a topic of file paths and
    opens one lineage per path.

    Common properties (net8.0, Nullable, ImplicitUsings, TreatWarningsAsErrors) come from
    Directory.Build.props, and package versions from Directory.Packages.props — never declare either
    here.
  -->

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <RootNamespace>Processor.PathImporter</RootNamespace>
    <AssemblyName>Processor.PathImporter</AssemblyName>
  </PropertyGroup>

  <ItemGroup>
    <!-- The worker SDK does not copy appsettings.json on its own. -->
    <Content Include="appsettings.json" CopyToOutputDirectory="PreserveNewest" />
  </ItemGroup>

  <ItemGroup>
    <!-- The package, not a ProjectReference: SourceHash.targets ships in the package's build/ folder
         and NuGet imports it automatically, stamping the hash on THIS assembly — the entry assembly,
         where the runtime reader looks, and the identity the API matches a processor row against. A
         ProjectReference could not flow build targets. -->
    <PackageReference Include="BaseProcessor.Core" VersionOverride="[1.0.0]" />
    <PackageReference Include="Confluent.Kafka" />
  </ItemGroup>

</Project>
```

- [ ] **Step 3: Create the config record**

`src/Processor.PathImporter/PathImporterConfig.cs`:

```csharp
using BaseProcessor.Core.Configuration;

namespace Processor.PathImporter;

/// <summary>
/// The step payload, flat: five scalars and no nesting. The framework binds it case-insensitively
/// and ignores unknown properties, so <c>{"brokerList":"kafka:9092","topic":"paths",
/// "consumerGroup":"path-importer","messageCount":100,"idleTimeoutSeconds":5}</c> binds, and a sixth
/// field added later does not break workflows authored before it.
/// <para>
/// <b>The broker list travels in the payload rather than in configuration.</b> Brokers are usually
/// infrastructure and infrastructure usually comes from the environment, so this is the one field
/// whose placement is arguable. Keeping it here lets one deployment serve several topics on several
/// clusters without a redeploy, and it keeps every field of this record answering the same question
/// the same way. If that ever inverts it is one field and a fallback.
/// </para>
/// </summary>
public sealed record PathImporterConfig(
    string BrokerList,
    string Topic,
    string ConsumerGroup,
    int MessageCount,
    int IdleTimeoutSeconds) : ProcessorConfig;
```

- [ ] **Step 4: Restore offline and confirm the feed is complete**

Run: `dotnet restore src/Processor.PathImporter/Processor.PathImporter.csproj`

Expected: success. If it fails with `NU1101: Unable to find package <name>`, that package is missing from `nugets/` — go back to the Prerequisite section and fetch it. Do not work around this by re-adding nuget.org to `NuGet.config`; the offline guarantee is the point.

This also writes `src/Processor.PathImporter/packages.lock.json`. That file is committed.

- [ ] **Step 5: Add Program.cs and appsettings.json**

`src/Processor.PathImporter/Program.cs` — identical to the sample's but for the namespace:

```csharp
using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Processor.PathImporter;

// The boot resolves identity before building anything, so this is the one place the process can be
// cancelled while it is still deciding who it is.
//
// Both signals are registered, not just Ctrl+C. Until the host exists there is no ConsoleLifetime to
// answer SIGTERM, and Stage 1 is explicitly allowed to run forever — so a processor waiting on an
// unregistered row is exactly the pod an operator deletes, and without this it would ignore the
// request and be killed outright when the grace period expired.
using var lifetime = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };
using var term = PosixSignalRegistration.Create(
    PosixSignal.SIGTERM, ctx => { ctx.Cancel = true; lifetime.Cancel(); });

using var host = await ProcessorHost.StartAsync(args, lifetime.Token);
await host.WaitForShutdownAsync();
```

`src/Processor.PathImporter/appsettings.json` — copy `src/Processor.Sample/appsettings.json` verbatim. **No Kafka section:** every Kafka value arrives in the step payload, and adding host-level keys here would create a second, silently-unused source of truth.

- [ ] **Step 6: Add ProcessorHost.cs**

Copy `src/Processor.Sample/ProcessorHost.cs` verbatim, then make exactly three changes:

1. `namespace Processor.Sample;` → `namespace Processor.PathImporter;`
2. Replace the `AddSingleton<BaseProcessor, SampleProcessor>()` line with the two registrations below.
3. Add `using Processor.PathImporter.Kafka;`.

```csharp
        // The Kafka client factory. Singleton because the processor holds one consumer across
        // dispatches (§4) and the factory is what mints it.
        builder.Services.AddSingleton<IPathConsumerFactory, KafkaPathConsumerFactory>();

        // The concrete processor the pre/post handlers resolve as BaseProcessor. Singleton, matching
        // the seam's design: per-dispatch state lives in plain fields on this one instance, which is
        // safe only because prefetch is 1 — and here those fields include the cached consumer.
        builder.Services.AddSingleton<BaseProcessor.Core.Processing.BaseProcessor, PathImporterProcessor>();
```

`PathImporterProcessor`, `IPathConsumerFactory` and `KafkaPathConsumerFactory` do not exist yet, so the project will not compile until Task 6. That is expected; the build gate for this task is Step 8's test run, which does not need them.

**Temporarily comment out the two registration lines and the `using Processor.PathImporter.Kafka;`** so Steps 7–9 can build. Task 6 Step 8 uncomments them.

- [ ] **Step 7: Wire the solution and the test project**

```bash
dotnet sln SK_P.sln add src/Processor.PathImporter/Processor.PathImporter.csproj
```

In `src/tests/BaseApi.Tests/BaseApi.Tests.csproj`, after the `Processor.Sample` `ProjectReference` (line ~90):

```xml
    <ProjectReference Include="..\..\Processor.PathImporter\Processor.PathImporter.csproj" />
```

- [ ] **Step 8: Write the failing test**

`src/tests/BaseApi.Tests/PathImporter/PathImporterConfigTests.cs`:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using Processor.PathImporter;
using Xunit;

namespace BaseApi.Tests.PathImporter;

public sealed class PathImporterConfigTests
{
    /// <summary>
    /// The payload an orchestrator actually sends: flat, and camel-cased where the record is Pascal.
    /// The framework's options are case-insensitive, and this fact is what pins that they stay so.
    /// </summary>
    [Fact]
    public void BindsAFlatCamelCasedPayload()
    {
        const string payload =
            """
            {"brokerList":"kafka-1:9092,kafka-2:9092","topic":"file-paths",
             "consumerGroup":"path-importer","messageCount":100,"idleTimeoutSeconds":5}
            """;

        var config = JsonSerializer.Deserialize<PathImporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("kafka-1:9092,kafka-2:9092", config!.BrokerList);
        Assert.Equal("file-paths", config.Topic);
        Assert.Equal("path-importer", config.ConsumerGroup);
        Assert.Equal(100, config.MessageCount);
        Assert.Equal(5, config.IdleTimeoutSeconds);
    }

    /// <summary>
    /// A field this record gains later must not break a workflow authored before it, and a field it
    /// does not know must not fail the step. Same tolerance the framework documents on its options.
    /// </summary>
    [Fact]
    public void IgnoresAPropertyItDoesNotKnow()
    {
        const string payload =
            """
            {"brokerList":"b","topic":"t","consumerGroup":"g","messageCount":1,
             "idleTimeoutSeconds":1,"somethingAddedLater":true}
            """;

        var config = JsonSerializer.Deserialize<PathImporterConfig>(
            payload, ProcessorConfig.SerializerOptions);

        Assert.Equal("t", config!.Topic);
    }
}
```

- [ ] **Step 9: Run the test**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -- --filter-method "*PathImporterConfigTests*"`
Expected: PASS, 2 tests. (The record already exists from Step 3, so these pass immediately — they are pinning the binding contract, not driving new code.)

- [ ] **Step 10: Run the full suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `0 failed`, exit code 0, all `Live/` tests skipped.

- [ ] **Step 11: Commit**

```bash
git add Directory.Packages.props SK_P.sln nugets/ src/Processor.PathImporter/ \
        src/tests/BaseApi.Tests/BaseApi.Tests.csproj src/tests/BaseApi.Tests/PathImporter/
git commit -F - <<'EOF'
feat(pathimporter): the shell, and the five flat fields a step hands it

The second concrete processor and the first thing in this solution that speaks to Kafka. This
commit is the shell and its config only: the loop, the seam and the classifier follow.

Every Kafka value -- brokers, topic, group, count, idle timeout -- arrives in the step payload
rather than in appsettings.json, so appsettings.json deliberately gains no Kafka section. A
host-level copy of those keys would be a second source of truth that is silently never read.

Confluent.Kafka is pinned in Directory.Packages.props; librdkafka.redist is not, because it arrives
transitively and pinning it would have CPM policing two versions of one decision. Both .nupkg files
join the offline feed -- about forty megabytes of per-RID native binaries, the largest single
addition nugets/ has taken.

EOF
```

(Append the two trailer lines from `git log -1 --format=%B` on a recent commit.)

---

## Task 2: The fault classifier

Pure, fully hermetic, and the piece with the most surprising behaviour — so it goes early and gets a real table of cases.

**Files:**
- Create: `src/Processor.PathImporter/Kafka/KafkaFaultClassifier.cs`
- Test: `src/tests/BaseApi.Tests/PathImporter/KafkaFaultClassifierTests.cs`

**Interfaces:**
- Consumes: `Confluent.Kafka.Error`, `Confluent.Kafka.ErrorCode`.
- Produces: `Processor.PathImporter.Kafka.KafkaFaultClassifier.IsDeterministic(Error error) → bool`. Task 5 calls it from both catch blocks in the loop.

- [ ] **Step 1: Write the failing test**

`src/tests/BaseApi.Tests/PathImporter/KafkaFaultClassifierTests.cs`:

```csharp
using Confluent.Kafka;
using Processor.PathImporter.Kafka;
using Xunit;

namespace BaseApi.Tests.PathImporter;

public sealed class KafkaFaultClassifierTests
{
    /// <summary>
    /// The allow-list. Each of these fails identically on every redelivery, so retrying is a loop
    /// that never terminates and the step must be reported failed instead.
    /// </summary>
    [Theory]
    [InlineData(ErrorCode.UnknownTopicOrPart)]
    [InlineData(ErrorCode.TopicAuthorizationFailed)]
    [InlineData(ErrorCode.GroupAuthorizationFailed)]
    [InlineData(ErrorCode.ClusterAuthorizationFailed)]
    [InlineData(ErrorCode.SaslAuthenticationFailed)]
    [InlineData(ErrorCode.InvalidConfig)]
    [InlineData(ErrorCode.Local_UnknownTopic)]
    [InlineData(ErrorCode.Local_InvalidArg)]
    public void NamesTheDeterministicFaults(ErrorCode code)
        => Assert.True(KafkaFaultClassifier.IsDeterministic(new Error(code)));

    /// <summary>
    /// Everything a broker or a rebalance can do to a healthy consumer. These cost a partial batch
    /// and are retried by the next dispatch — they must never become a failed step.
    /// </summary>
    [Theory]
    [InlineData(ErrorCode.Local_Transport)]
    [InlineData(ErrorCode.Local_TimedOut)]
    [InlineData(ErrorCode.Local_AllBrokersDown)]
    [InlineData(ErrorCode.LeaderNotAvailable)]
    [InlineData(ErrorCode.NotCoordinatorForGroup)]
    [InlineData(ErrorCode.RebalanceInProgress)]
    [InlineData(ErrorCode.CoordinatorLoadInProgress)]
    [InlineData(ErrorCode.RequestTimedOut)]
    public void TreatsEverythingElseAsTransient(ErrorCode code)
        => Assert.False(KafkaFaultClassifier.IsDeterministic(new Error(code)));

    /// <summary>
    /// A code this classifier has never heard of. The default is the SAFE one for this processor —
    /// transient, retried — and it is the opposite of SendFaultClassifier's default. That inversion
    /// is deliberate and this fact is what stops someone "fixing" it to match.
    /// </summary>
    [Fact]
    public void DefaultsAnUnknownCodeToTransient()
        => Assert.False(KafkaFaultClassifier.IsDeterministic(new Error(ErrorCode.Unknown)));

    /// <summary>
    /// Fatal overrides the allow-list. librdkafka raises it for states the client cannot recover
    /// from at all, so retrying is pointless whatever the code beside it says.
    /// </summary>
    [Fact]
    public void TreatsAnyFatalErrorAsDeterministic()
        => Assert.True(KafkaFaultClassifier.IsDeterministic(
               new Error(ErrorCode.Local_Fatal, "the client is fatally broken", isFatal: true)));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -- --filter-method "*KafkaFaultClassifierTests*"`
Expected: FAIL — compile error, `KafkaFaultClassifier` does not exist.

- [ ] **Step 3: Write the implementation**

`src/Processor.PathImporter/Kafka/KafkaFaultClassifier.cs`:

```csharp
using Confluent.Kafka;

namespace Processor.PathImporter.Kafka;

/// <summary>
/// Splits a Kafka fault into "this will fail the same way forever" and "try again next dispatch".
/// <para>
/// <b>Deterministic is the allow-list, and the default is transient — the inverse of
/// <c>SendFaultClassifier</c>.</b> There, an unrecognised fault is left raw so the dispatch parks
/// where a human can look, because misreading a deterministic fault as transient would requeue it
/// forever. Here the cost of each mistake is reversed: an unrecognised consume fault that is really
/// transient would fail a step that had nothing wrong with it, while one that is really deterministic
/// costs a partial batch and a retry that a human sees in the <c>Faulted</c> counts. So this default
/// is transient. It is not an oversight and it must not be "corrected" to match the other classifier.
/// </para>
/// </summary>
public static class KafkaFaultClassifier
{
    /// <summary>
    /// True when the fault will recur identically on the next dispatch, so the step should be
    /// reported failed rather than retried.
    /// </summary>
    public static bool IsDeterministic(Error error)
    {
        ArgumentNullException.ThrowIfNull(error);

        // Fatal first, and independent of the code: librdkafka raises it for client states nothing
        // downstream can recover from, whatever error happens to be reported alongside.
        if (error.IsFatal)
        {
            return true;
        }

        return error.Code switch
        {
            // The topic is not there, or we may not read it. Both are workflow authoring faults:
            // the payload names something the broker will not give us, and it will not start.
            ErrorCode.UnknownTopicOrPart          => true,
            ErrorCode.Local_UnknownTopic          => true,
            ErrorCode.TopicAuthorizationFailed    => true,
            ErrorCode.GroupAuthorizationFailed    => true,
            ErrorCode.ClusterAuthorizationFailed  => true,
            ErrorCode.SaslAuthenticationFailed    => true,

            // The client was built wrong. A retry builds it identically.
            ErrorCode.InvalidConfig               => true,
            ErrorCode.Local_InvalidArg            => true,

            // Transport, timeouts, elections, rebalances and everything unrecognised.
            _                                     => false,
        };
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -- --filter-method "*KafkaFaultClassifierTests*"`
Expected: PASS, 18 tests.

If an `ErrorCode` member name does not compile, the enum in 2.6.1 spells it differently — find the right name with `grep -ri "notcoordinator" ~/.nuget/packages/confluent.kafka/2.6.1/` or by inspecting the enum in your IDE, and fix **both** the test and the switch. Do not delete the case.

- [ ] **Step 5: Commit**

```bash
git add src/Processor.PathImporter/Kafka/KafkaFaultClassifier.cs \
        src/tests/BaseApi.Tests/PathImporter/KafkaFaultClassifierTests.cs
git commit -F - <<'EOF'
feat(pathimporter): an unrecognised consume fault is transient, unlike a send fault

Deterministic is the allow-list -- absent topic, the four authorization failures, and a client built
with bad arguments -- plus anything librdkafka flags fatal, which wins over the code beside it.
Everything else is transient.

That default is the inverse of SendFaultClassifier's, where an unrecognised fault is left raw so the
dispatch parks. The costs are reversed here. There, misreading deterministic as transient requeues a
message that fails identically forever. Here, misreading transient as deterministic fails a step
that had nothing wrong with it, while the other direction costs one partial batch and a retry that
shows up in the Faulted counts a human already reads. A test pins the default so nobody aligns the
two classifiers by hand.

EOF
```

---

## Task 3: The consumer seam and its settings

The seam is what keeps Kafka out of the hermetic suite. `KafkaConsumerSettings` is split out from the adapter precisely because it is the part that *can* be tested without a broker — and §4 rests on three of its four values.

**Files:**
- Create: `src/Processor.PathImporter/Kafka/PathRecord.cs`, `IPathConsumer.cs`, `IPathConsumerFactory.cs`, `KafkaConsumerSettings.cs`
- Test: `src/tests/BaseApi.Tests/PathImporter/KafkaConsumerSettingsTests.cs`

**Interfaces:**
- Produces, and every later task depends on these exact signatures:
  - `sealed record PathRecord(string Path, string Offset)`
  - `interface IPathConsumer : IDisposable` with `void Subscribe(string topic)`, `bool WaitForAssignment(TimeSpan timeout)`, `PathRecord? Consume(TimeSpan timeout)`, `void Commit(PathRecord record)`, `void Close()`
  - `interface IPathConsumerFactory` with `IPathConsumer Create(string brokerList, string consumerGroup)`
  - `static class KafkaConsumerSettings` with `static ConsumerConfig For(string brokerList, string consumerGroup)` and `static readonly TimeSpan MaxPollInterval`

- [ ] **Step 1: Write the failing test**

`src/tests/BaseApi.Tests/PathImporter/KafkaConsumerSettingsTests.cs`:

```csharp
using Confluent.Kafka;
using Processor.PathImporter.Kafka;
using Xunit;

namespace BaseApi.Tests.PathImporter;

public sealed class KafkaConsumerSettingsTests
{
    private static readonly ConsumerConfig Config =
        KafkaConsumerSettings.For("kafka-1:9092", "path-importer");

    [Fact]
    public void CarriesTheBrokerListAndGroupItWasGiven()
    {
        Assert.Equal("kafka-1:9092", Config.BootstrapServers);
        Assert.Equal("path-importer", Config.GroupId);
    }

    /// <summary>
    /// The loop owns when an offset moves. Auto-commit would move it on librdkafka's schedule —
    /// which is to say, possibly before the branch was sent — and that is the one ordering the whole
    /// design rests on.
    /// </summary>
    [Fact]
    public void NeverCommitsOrStoresAnOffsetOnItsOwn()
    {
        Assert.False(Config.EnableAutoCommit);
        Assert.False(Config.EnableAutoOffsetStore);
    }

    /// <summary>
    /// The topic is seeded from outside the cluster, so a group reading it for the first time must
    /// see paths written before the group existed. Latest would silently import nothing.
    /// </summary>
    [Fact]
    public void ReadsFromTheStartOfTheTopicForAGroupWithNoOffsets()
        => Assert.Equal(AutoOffsetReset.Earliest, Config.AutoOffsetReset);

    /// <summary>
    /// The consumer is held across dispatches, and nothing polls in between. At the five-minute
    /// default librdkafka would evict it from the group during any ordinary idle gap and the next
    /// dispatch would pay the rejoin the cache exists to avoid. Raising it is safe because
    /// session.timeout.ms, left at its default, is what actually detects a dead pod.
    /// </summary>
    [Fact]
    public void ToleratesAnHourBetweenPolls()
    {
        Assert.Equal(TimeSpan.FromHours(1), KafkaConsumerSettings.MaxPollInterval);
        Assert.Equal(3_600_000, Config.MaxPollIntervalMs);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -- --filter-method "*KafkaConsumerSettingsTests*"`
Expected: FAIL — compile error, `KafkaConsumerSettings` does not exist.

- [ ] **Step 3: Write the seam types**

`src/Processor.PathImporter/Kafka/PathRecord.cs`:

```csharp
namespace Processor.PathImporter.Kafka;

/// <summary>
/// One consumed record. <paramref name="Path"/> is the record's value and is the whole of it — a
/// Kafka record on this topic is a full file path, with no envelope and nothing to deserialize,
/// which is what makes it the branch's data directly.
/// <para>
/// <paramref name="Offset"/> is rendered rather than typed so that no Confluent type crosses this
/// seam. It is for the log line only; <see cref="IPathConsumer.Commit"/> takes the record back and
/// the adapter recovers whatever it needs from its own state.
/// </para>
/// </summary>
public sealed record PathRecord(string Path, string Offset);
```

`src/Processor.PathImporter/Kafka/IPathConsumer.cs`:

```csharp
namespace Processor.PathImporter.Kafka;

/// <summary>
/// Everything the loop knows about Kafka, which is four verbs. The narrowness is the point: it is
/// what lets every terminal, ordering and cache rule be tested against a fake, with no broker
/// anywhere in the hermetic suite.
/// </summary>
public interface IPathConsumer : IDisposable
{
    /// <summary>Non-blocking, as librdkafka's is. Assignment follows later, on a poll.</summary>
    void Subscribe(string topic);

    /// <summary>
    /// Blocks until the group has assigned this consumer a partition, or the timeout elapses.
    /// <para>
    /// <b>This exists to stop an unassigned consumer being read as an empty topic.</b> A poll during
    /// the group join returns nothing, which is indistinguishable from a drained partition unless
    /// somebody asks this question first — and the join is exactly where the broker's
    /// three-second initial rebalance delay lands.
    /// </para>
    /// </summary>
    /// <returns>True when a partition is assigned.</returns>
    bool WaitForAssignment(TimeSpan timeout);

    /// <summary>Null when no record arrived within <paramref name="timeout"/>.</summary>
    PathRecord? Consume(TimeSpan timeout);

    /// <summary>Commits through <paramref name="record"/>. The ACK.</summary>
    void Commit(PathRecord record);

    /// <summary>Leaves the group deliberately, rather than by session timeout.</summary>
    void Close();
}
```

`src/Processor.PathImporter/Kafka/IPathConsumerFactory.cs`:

```csharp
namespace Processor.PathImporter.Kafka;

/// <summary>
/// Mints a consumer for one broker list and group. Separate from <see cref="IPathConsumer"/> so the
/// processor's cache can be tested by counting how many times this was called.
/// </summary>
public interface IPathConsumerFactory
{
    IPathConsumer Create(string brokerList, string consumerGroup);
}
```

`src/Processor.PathImporter/Kafka/KafkaConsumerSettings.cs`:

```csharp
using Confluent.Kafka;

namespace Processor.PathImporter.Kafka;

/// <summary>
/// The client settings, split out from the adapter because this is the half that can be asserted
/// without a broker — and three of these four values are load-bearing rather than tuning.
/// </summary>
public static class KafkaConsumerSettings
{
    /// <summary>
    /// How long librdkafka tolerates between polls before removing this consumer from the group.
    /// <para>
    /// Raised from its five-minute default because the consumer is held across dispatches and
    /// nothing polls in between, so any ordinary idle gap would evict it and the next dispatch would
    /// pay the rejoin the cache exists to avoid. Safe, because this is not what detects a dead
    /// consumer: <c>session.timeout.ms</c> is, it runs on librdkafka's own heartbeat thread, it is
    /// left at its default, and it releases the partition promptly when a pod dies. This governs
    /// livelock only, and a livelocked author here is already a wedged dispatch the framework's
    /// liveness and queue-depth signals surface.
    /// </para>
    /// <para>
    /// <b>Do not "solve" this with a background keepalive poll.</b> Consume is what resets the
    /// interval and Consume is what returns records, so a keepalive would consume paths outside a
    /// dispatch — with no execution id to mint them under, no branch to send them on and no scope to
    /// log them in — and commit them away. It is the obvious idea and it destroys data silently.
    /// </para>
    /// </summary>
    public static readonly TimeSpan MaxPollInterval = TimeSpan.FromHours(1);

    public static ConsumerConfig For(string brokerList, string consumerGroup) => new()
    {
        BootstrapServers = brokerList,
        GroupId = consumerGroup,

        // The loop owns when an offset moves, on both counts. Auto-commit would move it on
        // librdkafka's schedule, possibly before the branch was sent — inverting the one ordering
        // the design rests on — and auto-store would do the same a layer lower.
        EnableAutoCommit = false,
        EnableAutoOffsetStore = false,

        // The topic is seeded from outside the cluster, so a group reading it for the first time
        // must see paths written before the group existed. Latest would import nothing and report a
        // healthy Drained while doing it.
        AutoOffsetReset = AutoOffsetReset.Earliest,

        MaxPollIntervalMs = (int)MaxPollInterval.TotalMilliseconds,
    };
}
```

- [ ] **Step 4: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -- --filter-method "*KafkaConsumerSettingsTests*"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/Processor.PathImporter/Kafka/ src/tests/BaseApi.Tests/PathImporter/KafkaConsumerSettingsTests.cs
git commit -F - <<'EOF'
feat(pathimporter): four verbs, so no broker is needed to test the loop

IPathConsumer is subscribe, wait-for-assignment, consume, commit, close, and PathRecord renders the
offset as a string rather than carrying a TopicPartitionOffset -- no Confluent type crosses the
seam, so the fake that stands in for it in the hermetic suite needs none either.

WaitForAssignment is not ceremony. Subscribe is non-blocking and a poll during the group join
returns nothing, which is indistinguishable from a drained partition -- and the join is exactly
where the broker's three-second initial rebalance delay lands. Without this question asked first,
the first dispatch after every pod start reports an empty topic that is full.

KafkaConsumerSettings is split from the adapter because it is the half assertable without a broker,
and three of its four values are load-bearing: both auto-commit switches off because the loop owns
when an offset moves, Earliest because the topic is seeded before the group exists, and
max.poll.interval raised to an hour because the consumer is held across dispatches and nothing polls
between them. The comment says at length why a keepalive poll is the wrong fix for the last one.

EOF
```

---

## Task 4: The Kafka adapter

The one file that cannot be tested hermetically, so it is kept as small as the seam allows and given no logic beyond translating.

**Files:**
- Create: `src/Processor.PathImporter/Kafka/KafkaPathConsumer.cs`, `KafkaPathConsumerFactory.cs`

**Interfaces:**
- Consumes: `IPathConsumer`, `IPathConsumerFactory`, `PathRecord`, `KafkaConsumerSettings.For` from Task 3.
- Produces: `KafkaPathConsumerFactory`, registered in `ProcessorHost` at Task 6.

- [ ] **Step 1: Write the adapter**

`src/Processor.PathImporter/Kafka/KafkaPathConsumer.cs`:

```csharp
using Confluent.Kafka;

namespace Processor.PathImporter.Kafka;

/// <summary>
/// The real client behind the seam. It translates and buffers, and holds no policy: every decision
/// about terminals, ordering and eviction is in <c>PathImporterProcessor</c>, where a fake can reach
/// it. This file is the part the hermetic suite cannot cover, so there is deliberately as little of
/// it as the seam allows.
/// </summary>
public sealed class KafkaPathConsumer : IPathConsumer
{
    private readonly IConsumer<Ignore, string> _inner;

    /// <summary>
    /// A record fetched by <see cref="WaitForAssignment"/> and not yet handed to the loop.
    /// <para>
    /// <b>Without this the wait would eat a path.</b> librdkafka assigns partitions only during a
    /// poll, so asking "am I assigned yet" means polling, and a poll can return a record. Dropping it
    /// would lose a path with nothing recording the loss — exactly the failure the commit ordering
    /// exists to prevent, reintroduced one layer down.
    /// </para>
    /// </summary>
    private ConsumeResult<Ignore, string>? _pending;

    public KafkaPathConsumer(string brokerList, string consumerGroup)
        => _inner = new ConsumerBuilder<Ignore, string>(
               KafkaConsumerSettings.For(brokerList, consumerGroup)).Build();

    public void Subscribe(string topic) => _inner.Subscribe(topic);

    public bool WaitForAssignment(TimeSpan timeout)
    {
        if (_inner.Assignment.Count > 0 || _pending is not null)
        {
            return true;
        }

        var deadline = DateTime.UtcNow + timeout;
        var slice = TimeSpan.FromMilliseconds(200);

        while (DateTime.UtcNow < deadline)
        {
            // A record arriving IS the assignment, and it must be kept — see _pending.
            var result = _inner.Consume(slice);
            if (result is not null)
            {
                _pending = result;
                return true;
            }

            if (_inner.Assignment.Count > 0)
            {
                return true;
            }
        }

        return _inner.Assignment.Count > 0;
    }

    public PathRecord? Consume(TimeSpan timeout)
    {
        var result = _pending;
        if (result is not null)
        {
            _pending = null;
        }
        else
        {
            result = _inner.Consume(timeout);
        }

        return result is null
            ? null
            : new PathRecord(result.Message.Value, result.TopicPartitionOffset.ToString());
    }

    /// <summary>
    /// Commits by position rather than by the record handed back, because the seam's
    /// <see cref="PathRecord"/> carries no Confluent type to commit with. Safe only because the loop
    /// commits the record it has just consumed, in order, one at a time — which it does, and which
    /// is the ordering the whole design rests on.
    /// </summary>
    public void Commit(PathRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        _inner.Commit();
    }

    public void Close() => _inner.Close();

    public void Dispose() => _inner.Dispose();
}
```

`src/Processor.PathImporter/Kafka/KafkaPathConsumerFactory.cs`:

```csharp
namespace Processor.PathImporter.Kafka;

/// <summary>The production factory. One line, so the cache in the processor is what gets tested.</summary>
public sealed class KafkaPathConsumerFactory : IPathConsumerFactory
{
    public IPathConsumer Create(string brokerList, string consumerGroup)
        => new KafkaPathConsumer(brokerList, consumerGroup);
}
```

- [ ] **Step 2: Build**

Run: `dotnet build src/Processor.PathImporter/Processor.PathImporter.csproj`
Expected: success, no warnings. `TreatWarningsAsErrors` is on, so any nullable complaint is a failure to fix here rather than suppress.

- [ ] **Step 3: Run the full suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `0 failed`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/Processor.PathImporter/Kafka/KafkaPathConsumer.cs \
        src/Processor.PathImporter/Kafka/KafkaPathConsumerFactory.cs
git commit -F - <<'EOF'
feat(pathimporter): the assignment poll buffers the record it happens to catch

The adapter translates and holds no policy, so the part the hermetic suite cannot reach is as small
as the seam allows. Every terminal, ordering and eviction rule lives in the processor, where a fake
can drive it.

One thing here is not translation. librdkafka assigns partitions only during a poll, so asking "am I
assigned yet" means polling, and a poll can return a record. Dropping it would lose a path with
nothing recording the loss -- the exact failure the commit ordering exists to prevent, reintroduced
a layer below it. WaitForAssignment therefore parks whatever it catches in _pending and Consume
hands that out before polling again.

Commit ignores the record it is given and commits by position, because PathRecord deliberately
carries no Confluent type to commit with. That is safe only while the loop commits the record it
just consumed, in order, one at a time -- which is stated in the method rather than left implied.

EOF
```

---

## Task 5: The loop — three terminals, per-record commit, one lineage per path

The heart of the design. Everything here is driven by a fake.

**Files:**
- Create: `src/Processor.PathImporter/StopReason.cs`, `src/Processor.PathImporter/PathImporterProcessor.cs`, `src/tests/BaseApi.Tests/PathImporter/FakePathConsumer.cs`
- Test: `src/tests/BaseApi.Tests/PathImporter/PathImporterLoopTests.cs`

**Interfaces:**
- Consumes: `IPathConsumer`, `IPathConsumerFactory`, `PathRecord` (Task 3); `KafkaFaultClassifier.IsDeterministic` (Task 2); `PathImporterConfig` (Task 1).
- Produces: `PathImporterProcessor(IPathConsumerFactory factory, ILogger<PathImporterProcessor> logger)`, a `sealed class : BaseProcessor<PathImporterConfig>, IDisposable`. Task 6 registers it and tests its cache.

- [ ] **Step 1: Write the fake**

`src/tests/BaseApi.Tests/PathImporter/FakePathConsumer.cs`:

```csharp
using Confluent.Kafka;
using Processor.PathImporter.Kafka;

namespace BaseApi.Tests.PathImporter;

/// <summary>
/// The seam, scripted. Records are queued up front; faults are scheduled by position, so a test says
/// "the fourth consume throws" rather than reaching into the loop.
/// </summary>
internal sealed class FakePathConsumer : IPathConsumer
{
    private readonly Queue<PathRecord> _records = new();
    private int _consumeCalls;

    public List<string> Committed { get; } = new();
    public List<string> Subscribed { get; } = new();
    public bool Closed { get; private set; }
    public bool Disposed { get; private set; }

    /// <summary>False makes WaitForAssignment time out, as an unjoined group would.</summary>
    public bool Assigned { get; set; } = true;

    /// <summary>1-based index of the Consume call that throws; null means none ever does.</summary>
    public int? ConsumeThrowsOnCall { get; set; }

    /// <summary>1-based index of the Commit call that throws; null means none ever does.</summary>
    public int? CommitThrowsOnCall { get; set; }

    public Error Fault { get; set; } = new(ErrorCode.Local_Transport);

    public FakePathConsumer WithPaths(params string[] paths)
    {
        for (var i = 0; i < paths.Length; i++)
        {
            _records.Enqueue(new PathRecord(paths[i], $"file-paths [0] @{i}"));
        }

        return this;
    }

    public void Subscribe(string topic) => Subscribed.Add(topic);

    public bool WaitForAssignment(TimeSpan timeout) => Assigned;

    public PathRecord? Consume(TimeSpan timeout)
    {
        _consumeCalls++;
        if (_consumeCalls == ConsumeThrowsOnCall)
        {
            throw new KafkaException(Fault);
        }

        return _records.Count == 0 ? null : _records.Dequeue();
    }

    public void Commit(PathRecord record)
    {
        if (Committed.Count + 1 == CommitThrowsOnCall)
        {
            throw new KafkaException(Fault);
        }

        Committed.Add(record.Path);
    }

    public void Close() => Closed = true;

    public void Dispose() => Disposed = true;
}

/// <summary>Hands out one scripted consumer and counts how often it was asked for a new one.</summary>
internal sealed class FakePathConsumerFactory(params FakePathConsumer[] consumers) : IPathConsumerFactory
{
    private int _created;

    public int Created => _created;
    public List<(string Brokers, string Group)> Requests { get; } = new();

    public IPathConsumer Create(string brokerList, string consumerGroup)
    {
        Requests.Add((brokerList, consumerGroup));
        return consumers[_created++];
    }
}
```

- [ ] **Step 2: Write the failing tests**

`src/tests/BaseApi.Tests/PathImporter/PathImporterLoopTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using NSubstitute;
using Processor.PathImporter;
using Xunit;

namespace BaseApi.Tests.PathImporter;

public sealed class PathImporterLoopTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private static string Payload(int messageCount) =>
        $$"""
        {"brokerList":"kafka-1:9092","topic":"file-paths","consumerGroup":"path-importer",
         "messageCount":{{messageCount}},"idleTimeoutSeconds":1}
        """;

    private static (PathImporterProcessor Processor, IQueueSender Sender, RecordingLogger<PathImporterProcessor> Log)
        Build(FakePathConsumerFactory factory)
    {
        var log = new RecordingLogger<PathImporterProcessor>();
        var sender = Substitute.For<IQueueSender>();
        var processor = new PathImporterProcessor(factory, log);
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (processor, sender, log);
    }

    private static async Task<List<ProcessedData>> Run(
        PathImporterProcessor processor, IQueueSender sender, int messageCount)
    {
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        // Guid.Empty: a source step. PathImporter mints per path regardless, and a later fact pins
        // that it does so even when handed a non-empty id.
        await processor.ExecuteAsync([], Payload(messageCount), Guid.Empty, CancellationToken.None);
        return sends;
    }

    private static string PathIn(ProcessedData p)
        => JsonDocument.Parse(p.Data).RootElement.GetProperty("path").GetString()!;

    private static string Summary(RecordingLogger<PathImporterProcessor> log)
        => log.Records.Single(r => r.Message.Contains("stopped because")).Message;

    // ---- Terminals -------------------------------------------------------------------------

    [Fact]
    public async Task ConsumesEveryPathItWasAskedForAndReportsCompleted()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt", "/mnt/b.txt", "/mnt/c.txt");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 3);

        Assert.Equal(["/mnt/a.txt", "/mnt/b.txt", "/mnt/c.txt"], sends.Select(PathIn));
        Assert.Contains("consumed 3/3 paths; stopped because Completed", Summary(log));
    }

    /// <summary>
    /// Twelve of a hundred because the topic held twelve. The reason on the line is the only thing
    /// that separates this from the Faulted case below, which reports an identical count.
    /// </summary>
    [Fact]
    public async Task StopsAtDrainedWhenTheTopicRunsOutBeforeTheCount()
    {
        var paths = Enumerable.Range(0, 12).Select(i => $"/mnt/{i}.txt").ToArray();
        var consumer = new FakePathConsumer().WithPaths(paths);
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 100);

        Assert.Equal(12, sends.Count);
        Assert.Contains("consumed 12/100 paths; stopped because Drained", Summary(log));
    }

    /// <summary>
    /// Twelve of a hundred because the thirteenth consume threw. Same count as Drained, different
    /// cause, and the whole reason the reason is on the line.
    /// </summary>
    [Fact]
    public async Task StopsAtFaultedWhenATransientConsumeThrows()
    {
        var paths = Enumerable.Range(0, 20).Select(i => $"/mnt/{i}.txt").ToArray();
        var consumer = new FakePathConsumer { ConsumeThrowsOnCall = 13 }.WithPaths(paths);
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 100);

        Assert.Equal(12, sends.Count);
        Assert.Equal(12, consumer.Committed.Count);
        Assert.Contains("consumed 12/100 paths; stopped because Faulted", Summary(log));
    }

    /// <summary>
    /// The case that would otherwise fire on every pod's first dispatch: a consumer that has not
    /// been assigned a partition yet polls empty, and an empty poll looks exactly like an empty
    /// topic. It must not be reported as one.
    /// </summary>
    [Fact]
    public async Task DoesNotCallAnUnassignedConsumerDrained()
    {
        var consumer = new FakePathConsumer { Assigned = false }.WithPaths("/mnt/a.txt");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 100);

        Assert.Empty(sends);
        Assert.DoesNotContain("Drained", Summary(log));
        Assert.Contains("consumed 0/100 paths; stopped because Faulted", Summary(log));
    }

    // ---- Ordering and identity -------------------------------------------------------------

    /// <summary>
    /// Commit only if the send succeeded. A send that throws must leave the offset where it is, so
    /// the next dispatch re-reads that path instead of losing it.
    /// </summary>
    [Fact]
    public async Task CommitsNothingForAPathWhoseSendFailed()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt", "/mnt/b.txt");
        var (processor, sender, _) = Build(new FakePathConsumerFactory(consumer));

        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .Returns(_ => throw new TransientSendException("broker gone", new InvalidOperationException()));

        await Assert.ThrowsAsync<PostSendException>(() =>
            processor.ExecuteAsync([], Payload(2), Guid.Empty, CancellationToken.None));

        Assert.Empty(consumer.Committed);
    }

    /// <summary>
    /// Per record, not per batch. A batch commit would re-send every path of a dispatch redelivered
    /// halfway, because a source step has no input key to guard the replay.
    /// </summary>
    [Fact]
    public async Task CommitsEachPathAsItGoesRatherThanOnceAtTheEnd()
    {
        var consumer = new FakePathConsumer { CommitThrowsOnCall = 2 }.WithPaths("/mnt/a.txt", "/mnt/b.txt");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        await Run(processor, sender, messageCount: 10);

        Assert.Equal(["/mnt/a.txt"], consumer.Committed);
        Assert.Contains("consumed 1/10 paths; stopped because Faulted", Summary(log));
    }

    [Fact]
    public async Task OpensADistinctLineageForEveryPath()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt", "/mnt/b.txt", "/mnt/c.txt");
        var (processor, sender, _) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 3);

        Assert.Equal(3, sends.Select(s => s.ExecutionId).Distinct().Count());
        Assert.DoesNotContain(Guid.Empty, sends.Select(s => s.ExecutionId));
    }

    /// <summary>
    /// Every path is the origin of its own lineage; there is no case where this processor continues
    /// one it was handed. A non-empty inbound id must not be reused for the branches.
    /// </summary>
    [Fact]
    public async Task MintsPerPathEvenWhenHandedAnExecutionId()
    {
        var inbound = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt", "/mnt/b.txt");
        var (processor, sender, _) = Build(new FakePathConsumerFactory(consumer));

        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        await processor.ExecuteAsync([], Payload(2), inbound, CancellationToken.None);

        Assert.DoesNotContain(inbound, sends.Select(s => s.ExecutionId));
    }

    // ---- The Elasticsearch coupling --------------------------------------------------------

    /// <summary>
    /// The record this whole processor exists to produce: the path, and the execution id it opened,
    /// on one line. The correlation id rides the dispatch scope and is not named in the template.
    /// The id must be the SAME one the branch carries, or the coupling leads nowhere.
    /// </summary>
    [Fact]
    public async Task LogsEachPathAgainstTheExecutionIdItsBranchCarries()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/reports/q3.csv");
        var (processor, sender, log) = Build(new FakePathConsumerFactory(consumer));

        var sends = await Run(processor, sender, messageCount: 1);

        var line = log.Records.Single(r => r.Message.Contains("imported path")).Message;
        Assert.Contains("/mnt/reports/q3.csv", line);
        Assert.Contains(sends.Single().ExecutionId.ToString(), line);
    }

    // ---- Failure ---------------------------------------------------------------------------

    [Fact]
    public async Task FailsTheStepWhenTheStepPayloadIsMissing()
    {
        var (processor, _, _) = Build(new FakePathConsumerFactory(new FakePathConsumer()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], "", Guid.Empty, CancellationToken.None));
    }

    [Fact]
    public async Task FailsTheStepOnADeterministicConsumeFault()
    {
        var consumer = new FakePathConsumer
        {
            ConsumeThrowsOnCall = 1,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.TopicAuthorizationFailed),
        }.WithPaths("/mnt/a.txt");
        var (processor, _, _) = Build(new FakePathConsumerFactory(consumer));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload(10), Guid.Empty, CancellationToken.None));
    }

    [Fact]
    public async Task SubscribesToTheTopicTheStepNamed()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt");
        var (processor, sender, _) = Build(new FakePathConsumerFactory(consumer));

        await Run(processor, sender, messageCount: 1);

        Assert.Equal(["file-paths"], consumer.Subscribed);
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -- --filter-method "*PathImporterLoopTests*"`
Expected: FAIL — compile error, `PathImporterProcessor` and `StopReason` do not exist.

- [ ] **Step 4: Write StopReason**

`src/Processor.PathImporter/StopReason.cs`:

```csharp
namespace Processor.PathImporter;

/// <summary>
/// Why the loop stopped. It exists because a bare <c>12/100</c> has three causes and an operator
/// cannot tell them apart: the batch finished, the topic ran dry, or the thirteenth record faulted.
/// </summary>
public enum StopReason
{
    /// <summary>Consumed the full <c>MessageCount</c>. Every offset committed.</summary>
    Completed,

    /// <summary>
    /// The topic is empty. Unambiguous only because the topic has one partition and the deployment
    /// one replica — a consumer reads only what is assigned to it, so at any other scale this would
    /// be a drained assignment reported as a drained topic. See §6 of the design.
    /// </summary>
    Drained,

    /// <summary>
    /// A transient fault. Offsets committed up to the last good record and nothing beyond, so the
    /// next dispatch resumes there. Not a business failure: the step succeeds with a partial count.
    /// </summary>
    Faulted,
}
```

- [ ] **Step 5: Write the processor**

`src/Processor.PathImporter/PathImporterProcessor.cs`:

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Processing;
using Confluent.Kafka;
using Microsoft.Extensions.Logging;
using Processor.PathImporter.Kafka;

namespace Processor.PathImporter;

/// <summary>
/// Reads a topic of file paths and opens one lineage per path.
/// <para>
/// <b>A source step, which is what makes the committed offset load-bearing.</b> The framework is
/// explicit that a redelivered dispatch replays this method, and that the input-key delete which
/// normally makes that a no-op does not exist for a source step — there is no input key to reclaim.
/// So the offset is the only replay guard there is, and it is committed per record: a batch-level
/// commit would have a dispatch redelivered at record sixty re-read and re-send all sixty, opening
/// sixty duplicate lineages.
/// </para>
/// </summary>
public sealed class PathImporterProcessor(
    IPathConsumerFactory factory,
    ILogger<PathImporterProcessor> logger)
    : BaseProcessor<PathImporterConfig>, IDisposable
{
    private IPathConsumer? _consumer;
    private (string Brokers, string Topic, string Group)? _key;

    protected override async Task ProcessAsync(
        byte[] data, PathImporterConfig? config, Guid executionId, CancellationToken ct)
    {
        // Unlike the sample, there is no meaningful default to fall back to. Inventing a topic would
        // have this processor read from somewhere nobody asked for, so an absent payload is a
        // workflow authoring error and is reported as one.
        if (config is null)
        {
            throw new FailedException(
                "PathImporter needs a step payload naming brokerList, topic, consumerGroup, messageCount and idleTimeoutSeconds");
        }

        var idle = TimeSpan.FromSeconds(config.IdleTimeoutSeconds);
        var consumer = Rent(config);

        var consumed = 0;
        var reason = StopReason.Completed;

        try
        {
            // Before anything is read. An unassigned consumer polls empty, and an empty poll is
            // indistinguishable from an empty topic — so without this the first dispatch after every
            // pod start would report a full topic Drained.
            if (!consumer.WaitForAssignment(idle))
            {
                reason = StopReason.Faulted;
            }

            while (reason == StopReason.Completed && consumed < config.MessageCount)
            {
                PathRecord? record;
                try
                {
                    record = consumer.Consume(idle);
                }
                catch (KafkaException ex) when (KafkaFaultClassifier.IsDeterministic(ex.Error))
                {
                    throw new FailedException($"consuming {config.Topic} failed: {ex.Error.Code}");
                }
                catch (KafkaException)
                {
                    reason = StopReason.Faulted;
                    break;
                }

                if (record is null)
                {
                    reason = StopReason.Drained;
                    break;
                }

                // One per path, unconditionally — including when this dispatch arrived carrying an
                // execution id. Every path is the origin of its own lineage; there is no case where
                // this processor continues one it was handed.
                var pathExecutionId = NewExecutionId();

                // The record this processor exists to produce. CorrelationId rides the dispatch scope
                // and is not named here; ExecutionId must be, because the scope carries the
                // DISPATCH's id — Guid.Empty for a source step — and the id minted above appears
                // nowhere else. Without this line the correlation id leads to a hundred
                // indistinguishable records.
                //
                // It renders runtime data, which SampleProcessor forbids at length. The exception is
                // narrow and deliberate: the path is not derived content, it is the business
                // identifier and the only thing an operator would search for. The consequence is that
                // paths land in Elasticsearch in the clear, and the mitigation, if that ever stops
                // being acceptable, is to hash or truncate here.
                logger.LogInformation(
                    "imported path {Path} as execution {ExecutionId} from {Offset}",
                    record.Path, pathExecutionId, record.Offset);

                var payload = JsonSerializer.SerializeToUtf8Bytes(
                    new { path = record.Path }, ProcessorConfig.SerializerOptions);

                // PostSendException propagates untouched, as the framework requires. It is safer here
                // than for a pure transform: committed offsets mean the replayed dispatch resumes at
                // the uncommitted path rather than re-sending the ones that already landed.
                await SendToPostAsync(payload, pathExecutionId, ct).ConfigureAwait(false);

                // The ACK, and it follows the send. Committing first would acknowledge a path whose
                // branch had not been sent, and a fault between the two would lose it with nothing
                // recording that it was lost. This way the failure is a duplicate, which is
                // recoverable.
                try
                {
                    consumer.Commit(record);
                }
                catch (KafkaException ex) when (KafkaFaultClassifier.IsDeterministic(ex.Error))
                {
                    throw new FailedException($"committing {config.Topic} failed: {ex.Error.Code}");
                }
                catch (KafkaException)
                {
                    reason = StopReason.Faulted;
                    break;
                }

                consumed++;
            }
        }
        catch
        {
            // A failing step leaves no consumer behind either. Rebuilding costs one group join and
            // removes any chance of inheriting whatever state produced the fault.
            Evict();
            throw;
        }

        if (reason == StopReason.Faulted)
        {
            Evict();
        }

        logger.LogInformation(
            "consumed {Consumed}/{Requested} paths; stopped because {Reason}",
            consumed, config.MessageCount, reason);
    }

    /// <summary>
    /// The cached consumer, or a new one when the step names a different broker, topic or group.
    /// <para>
    /// A cache of exactly one. Safe because the processor is a singleton and prefetch is one, so
    /// exactly one dispatch is in flight per replica — the same sentence that makes
    /// <c>BaseProcessor</c>'s dispatch field safe, and it fails the same way if prefetch ever moves.
    /// </para>
    /// </summary>
    private IPathConsumer Rent(PathImporterConfig config)
    {
        var key = (config.BrokerList, config.Topic, config.ConsumerGroup);
        if (_consumer is not null && _key == key)
        {
            return _consumer;
        }

        Evict();

        var consumer = factory.Create(config.BrokerList, config.ConsumerGroup);
        consumer.Subscribe(config.Topic);
        _consumer = consumer;
        _key = key;
        return consumer;
    }

    private void Evict()
    {
        if (_consumer is null)
        {
            return;
        }

        // Close before Dispose so the group is left deliberately rather than by session timeout.
        // Close can itself throw on a consumer that is already broken, which is the common case here
        // — and failing to release the field would leave the broken one cached forever.
        try
        {
            _consumer.Close();
        }
        catch (KafkaException ex)
        {
            logger.LogWarning(ex, "closing the consumer failed; discarding it anyway");
        }

        _consumer.Dispose();
        _consumer = null;
        _key = null;
    }

    /// <summary>
    /// The container owns this singleton and disposes it at shutdown, so the group is left cleanly
    /// instead of waiting out the session timeout.
    /// </summary>
    public void Dispose() => Evict();
}
```

- [ ] **Step 6: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -- --filter-method "*PathImporterLoopTests*"`
Expected: PASS, 12 tests.

- [ ] **Step 7: Run the full suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `0 failed`, exit 0, `Live/` skipped.

- [ ] **Step 8: Commit**

```bash
git add src/Processor.PathImporter/StopReason.cs src/Processor.PathImporter/PathImporterProcessor.cs \
        src/tests/BaseApi.Tests/PathImporter/FakePathConsumer.cs \
        src/tests/BaseApi.Tests/PathImporter/PathImporterLoopTests.cs
git commit -F - <<'EOF'
feat(pathimporter): 12/100 has three causes, so the line names which

Completed, Drained and Faulted, and two of them report identical counts. Twelve because the topic
held twelve, and twelve because the thirteenth record faulted, are the same number and opposite
situations; the reason on the line is the only thing separating them, and both have a fact.

A fourth cause is closed rather than named. An unassigned consumer polls empty and an empty poll is
indistinguishable from an empty topic -- so WaitForAssignment runs before the loop and an
unassigned consumer reports Faulted, never Drained. Untreated, that fires on the first dispatch
after every pod start, against a full topic.

The commit follows the send, per record. Committing first would acknowledge a path whose branch had
not been sent and a fault between the two would lose it silently; committing per batch would have a
dispatch redelivered at sixty re-send all sixty, because a source step has no input key to guard the
replay. Both orderings have a fact, driven through the fake rather than a broker.

The log line renders the path, which SampleProcessor forbids for runtime data. Deliberate: the path
is the business identifier, and the minted execution id reaches Elasticsearch nowhere else -- the
scope carries the DISPATCH's id, which is Guid.Empty here. The test asserts the logged id is the
same one the branch carries, because a coupling to a different id leads nowhere.

EOF
```

---

## Task 6: The cache, and wiring the host

Proves the §4 rules — reuse, rebuild on a changed key, eviction on fault, disposal at shutdown — and turns the registrations back on.

**Files:**
- Modify: `src/Processor.PathImporter/ProcessorHost.cs` (uncomment the Task 1 Step 6 registrations)
- Test: `src/tests/BaseApi.Tests/PathImporter/PathImporterCacheTests.cs`

**Interfaces:**
- Consumes: `PathImporterProcessor`, `FakePathConsumer`, `FakePathConsumerFactory` from Task 5.

- [ ] **Step 1: Write the failing tests**

`src/tests/BaseApi.Tests/PathImporter/PathImporterCacheTests.cs`:

```csharp
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using NSubstitute;
using Processor.PathImporter;
using Xunit;

namespace BaseApi.Tests.PathImporter;

public sealed class PathImporterCacheTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private static string Payload(string topic, string group = "path-importer") =>
        $$"""
        {"brokerList":"kafka-1:9092","topic":"{{topic}}","consumerGroup":"{{group}}",
         "messageCount":10,"idleTimeoutSeconds":1}
        """;

    private static PathImporterProcessor Build(FakePathConsumerFactory factory)
    {
        var processor = new PathImporterProcessor(
            factory, new RecordingLogger<PathImporterProcessor>());
        processor.BeginDispatch(
            new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return processor;
    }

    /// <summary>
    /// The whole point of holding it: a single-member group that empties pays the broker's
    /// three-second initial rebalance delay on the next join, and a stateless consumer would pay it
    /// on every dispatch that follows an idle gap.
    /// </summary>
    [Fact]
    public async Task ReusesOneConsumerAcrossDispatchesOnTheSameTopic()
    {
        var factory = new FakePathConsumerFactory(
            new FakePathConsumer().WithPaths("/mnt/a.txt", "/mnt/b.txt"));
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);

        Assert.Equal(1, factory.Created);
    }

    [Fact]
    public async Task RebuildsWhenTheStepNamesADifferentTopic()
    {
        var first = new FakePathConsumer().WithPaths("/mnt/a.txt");
        var second = new FakePathConsumer().WithPaths("/mnt/b.txt");
        var factory = new FakePathConsumerFactory(first, second);
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("other-paths"), Guid.Empty, CancellationToken.None);

        Assert.Equal(2, factory.Created);
        Assert.True(first.Closed);
        Assert.True(first.Disposed);
        Assert.Equal(["other-paths"], second.Subscribed);
    }

    [Fact]
    public async Task RebuildsWhenTheStepNamesADifferentConsumerGroup()
    {
        var factory = new FakePathConsumerFactory(
            new FakePathConsumer().WithPaths("/mnt/a.txt"),
            new FakePathConsumer().WithPaths("/mnt/b.txt"));
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("file-paths", "group-one"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("file-paths", "group-two"), Guid.Empty, CancellationToken.None);

        Assert.Equal(2, factory.Created);
    }

    /// <summary>
    /// The rule that makes caching strictly better than a per-dispatch consumer rather than a trade:
    /// the fast path is cached and the recovery path is not. Without it, a consumer wedged in a
    /// state the classifier read as transient stays wedged for the life of the pod.
    /// </summary>
    [Fact]
    public async Task DiscardsTheConsumerAfterATransientFaultSoTheNextDispatchIsFresh()
    {
        var faulted = new FakePathConsumer { ConsumeThrowsOnCall = 1 }.WithPaths("/mnt/a.txt");
        var fresh = new FakePathConsumer().WithPaths("/mnt/b.txt");
        var factory = new FakePathConsumerFactory(faulted, fresh);
        var processor = Build(factory);

        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);
        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);

        Assert.Equal(2, factory.Created);
        Assert.True(faulted.Disposed);
    }

    [Fact]
    public async Task DiscardsTheConsumerWhenTheStepFails()
    {
        var consumer = new FakePathConsumer
        {
            ConsumeThrowsOnCall = 1,
            Fault = new Confluent.Kafka.Error(Confluent.Kafka.ErrorCode.TopicAuthorizationFailed),
        }.WithPaths("/mnt/a.txt");
        var processor = Build(new FakePathConsumerFactory(consumer, new FakePathConsumer()));

        await Assert.ThrowsAsync<FailedException>(() =>
            processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None));

        Assert.True(consumer.Disposed);
    }

    /// <summary>
    /// The container disposes this singleton at shutdown, and that is what leaves the group cleanly
    /// rather than waiting out the session timeout.
    /// </summary>
    [Fact]
    public async Task LeavesTheGroupWhenTheHostShutsDown()
    {
        var consumer = new FakePathConsumer().WithPaths("/mnt/a.txt");
        var processor = Build(new FakePathConsumerFactory(consumer));

        await processor.ExecuteAsync([], Payload("file-paths"), Guid.Empty, CancellationToken.None);
        processor.Dispose();

        Assert.True(consumer.Closed);
        Assert.True(consumer.Disposed);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -- --filter-method "*PathImporterCacheTests*"`
Expected: FAIL. `ReusesOneConsumerAcrossDispatchesOnTheSameTopic` is the one that must be red for a real reason if `Rent` were written wrong; if all six pass immediately, the Task 5 implementation already satisfied them — re-read `Rent` and `Evict` against each assertion before moving on, and do not skip Step 3.

- [ ] **Step 3: Fix anything red**

The implementation from Task 5 Step 5 is intended to satisfy all six. If one fails, the fault is in `Rent` or `Evict` — fix it there, not in the test.

- [ ] **Step 4: Uncomment the host registrations**

In `src/Processor.PathImporter/ProcessorHost.cs`, restore the `using Processor.PathImporter.Kafka;` and the two `AddSingleton` lines commented out in Task 1 Step 6.

- [ ] **Step 5: Write the host wiring test**

Append to `src/tests/BaseApi.Tests/PathImporter/PathImporterCacheTests.cs` — a new class in the same file:

```csharp
/// <summary>
/// The one thing worth asserting about a shell: that its service graph actually resolves, without
/// starting a process or reaching a broker. Mirrors ProcessorSampleTests for the sample.
/// </summary>
public sealed class PathImporterHostWiringTests
{
    [Fact]
    public void ResolvesTheProcessorAndItsConsumerFactory()
    {
        var identity = new Messaging.Contracts.ProcessorIdentityFound(
            Guid.NewGuid(), "path-importer", "1.0.0");

        using var host = Processor.PathImporter.ProcessorHost.Create([], identity, config =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Redis"] = "localhost:6379,abortConnect=false",
                ["RabbitMq:Host"] = "localhost",
            }));

        Assert.IsType<Processor.PathImporter.PathImporterProcessor>(
            host.Services.GetRequiredService<BaseProcessor.Core.Processing.BaseProcessor>());
        Assert.IsType<Processor.PathImporter.Kafka.KafkaPathConsumerFactory>(
            host.Services.GetRequiredService<Processor.PathImporter.Kafka.IPathConsumerFactory>());
    }
}
```

Add these usings at the top of the file: `using Microsoft.Extensions.Configuration;` and `using Microsoft.Extensions.DependencyInjection;`.

**If `ProcessorIdentityFound`'s constructor does not match**, open `src/tests/BaseApi.Tests/Sample/ProcessorSampleTests.cs` and copy how it builds one — that test does exactly this for the sample and is the reference.

- [ ] **Step 6: Run the tests**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj -- --filter-method "*PathImporter*"`
Expected: PASS, 43 tests across the six PathImporter classes (2 config, 18 classifier, 4 settings, 12 loop, 6 cache, 1 wiring).

- [ ] **Step 7: Run the full suite**

Run: `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj`
Expected: `0 failed`, exit 0, `Live/` skipped.

- [ ] **Step 8: Commit**

```bash
git add src/Processor.PathImporter/ProcessorHost.cs \
        src/tests/BaseApi.Tests/PathImporter/PathImporterCacheTests.cs
git commit -F - <<'EOF'
feat(pathimporter): the fast path is cached, the recovery path is not

One consumer, keyed on brokers-topic-group, held across dispatches -- and not for latency. A
single-member group that empties pays the broker's group.initial.rebalance.delay.ms on the next
join, three seconds, set on the org's brokers and not ours, so a stateless consumer would stall at
the start of every dispatch that follows an idle gap.

What makes it strictly better than per-dispatch rather than a trade is that a fault evicts it. A
consumer wedged in a state the classifier read as transient would otherwise stay wedged for the life
of the pod and every later dispatch would inherit it; instead the next dispatch builds a fresh one.
A failing step evicts too, since rebuilding costs one join and the step is failing anyway.

Close before Dispose, and Close's own throw is caught: on an already-broken consumer it is the
common case, and letting it propagate would leave the broken consumer in the field forever.

EOF
```

---

## Task 7: Deployment and the offline drop

**Files:**
- Create: `k8s/34-processor-pathimporter.yaml`
- Modify: `k8s/kustomization.yaml`

**Interfaces:**
- Consumes: the image built from `src/Processor.PathImporter/`.

- [ ] **Step 1: Write the manifest**

Copy `k8s/33-processor-sample.yaml` to `k8s/34-processor-pathimporter.yaml` and change: every `processor-sample` to `processor-pathimporter`, the image name, and the two blocks below. Keep the env, probes, resources and OTLP wiring exactly as the sample has them.

Replace the header comment and the replica/strategy section with:

```yaml
# processor-pathimporter — reads a topic of file paths and opens one lineage per path. Like
# processor-sample it has no Service: a pure consumer's only inbound traffic is the kubelet hitting
# the pod IP for probes.
#
# ONE REPLICA, and this is not a capacity decision. The topic has one partition, and a Kafka consumer
# reads only the partitions assigned to it — so a second replica would own nothing, consume nothing,
# and report "0/100 Drained" for every dispatch that landed on it. The processor's Drained reason
# means "the topic is empty" ONLY under this arrangement. Raising this number, or the topic's
# partition count, invalidates that reason: read §6 of
# docs/superpowers/specs/2026-09-06-path-importer-design.md before changing either.
#
# The broker is org infrastructure outside this cluster. Nothing here stands it up, and no Kafka
# address appears below: brokers, topic, group and counts all travel in the orchestrator's step
# payload.
```

```yaml
spec:
  replicas: 1
  strategy:
    type: RollingUpdate
    rollingUpdate:
      # maxSurge 0 so an update never briefly runs two members against a one-partition topic. The
      # handover is stop-then-start rather than an overlap.
      maxSurge: 0
      maxUnavailable: 1
```

- [ ] **Step 2: Register it with kustomize**

In `k8s/kustomization.yaml`, add `- 34-processor-pathimporter.yaml` in numeric order, immediately after the `33-processor-sample.yaml` entry.

- [ ] **Step 3: Validate the manifest renders**

Run: `kubectl kustomize k8s/`
Expected: renders without error, and the output contains `name: processor-pathimporter` with `replicas: 1`.

Do **not** apply it. Deploying needs the image built and loaded into kind and the processor row registered, which is a separate operation outside this plan.

- [ ] **Step 4: Check what the offline drop will carry**

Run: `pwsh tools/ship-delta.ps1`
Expected: the report lists the new `src/Processor.PathImporter/` files, `k8s/34-processor-pathimporter.yaml`, and the two Kafka `.nupkg` files. The scope entries recurse, so nothing needed listing by hand.

Do not pass `-Commit`. The baseline advances only once the drop has landed on the other side.

- [ ] **Step 5: Commit**

```bash
git add k8s/34-processor-pathimporter.yaml k8s/kustomization.yaml
git commit -F - <<'EOF'
feat(pathimporter): one replica, because a second would own no partition

The topic has one partition and a Kafka consumer reads only what is assigned to it, so a second
replica would own nothing, consume nothing, and report 0/100 Drained for every dispatch that landed
on it. The sample's argument for two -- a pure consumer has no inbound traffic to balance -- does
not survive that.

It is also what makes the Drained reason honest. "The topic is empty" and "my assignment is empty"
are the same sentence only at one partition and one replica, so the comment block sends anyone
scaling either number to §6 of the design before they do it.

maxSurge 0 so a rolling update never briefly runs two members against the one partition; the
handover is stop-then-start. No Kafka address appears in the manifest: brokers, topic, group and
counts all travel in the step payload.

EOF
```

---

## Done

At the end of Task 7:

- `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj` reports `0 failed`, exit 0, all `Live/` skipped.
- `kubectl kustomize k8s/` renders.
- `pwsh tools/ship-delta.ps1` reports the new files without `-Commit`.

**Not in scope, and deliberately:** deploying the image (kind load plus a SourceHash repoint, per the deploy loop), registering the processor row, seeding the topic, and any real-broker test under `Live/`.

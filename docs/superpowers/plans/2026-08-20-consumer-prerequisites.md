# Consumer Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every consumer in the project a third delivery outcome — requeue without declaring the
projection store unhealthy — and close two silent-failure gaps in the request/reply path, so the
processor execution path has the foundation it needs.

**Architecture:** A broker send that fails during message handling is currently indistinguishable
from a message that cannot be processed, so it parks permanently. This plan introduces a transport
exception type that says "the broker failed, not the message", replaces `GatedQueueConsumer`'s two
`catch` blocks with one pure classifier that can be tested without a broker, and ports the whole
gating stack into `BaseConsole.Core` so console hosts can use it. It also makes the two RPC handlers
reject requests whose required fields arrived as type defaults.

**Tech Stack:** .NET 8, RabbitMQ.Client 7 (async API), StackExchange.Redis, xunit.v3 under the
Microsoft Testing Platform runner, NSubstitute.

**Spec:** `docs/superpowers/specs/2026-08-20-base-processor-consumers-design.md` — §10 (cross-cutting
consumer work), with supporting rationale in §8 (failure policy).

**Follow-on plan:** `2026-08-20-processor-execution-path.md` implements §3–§9 and depends on every
task here.

## Global Constraints

- **Target framework:** `net8.0`. No language or BCL feature above C# 12.
- **`--filter` is silently ignored** by this repo's test runner (Microsoft Testing Platform). A run
  with a filter that matches nothing still executes the full suite and exits 0. Always run the whole
  project and read the summary; use `--filter-method` if you need one test.
- **The gate is the shape of the run, not a fixed count.** Every "Expected: N tests" line below was
  computed from a stale baseline and is one or more low; the true count also moves as each task lands.
  What must hold after every task: **0 failures, exactly 6 skips** (the `Live/` tests, which skip
  without `SKP_REALSTACK` set), **exit code 0**, and this task's new tests present and passing. A
  failure or a seventh skip means something unrelated is broken — stop and say so rather than working
  around it.
- **Never log a payload or a message body.** Ids, queue names, type headers and lengths only.
- **Never interpolate an id into a log template.** Ids go in as structured `{Placeholder}` arguments
  or as scope values under a fixed key — never `$"..."`.
- `Messaging.Transport` must not gain a `StackExchange.Redis` package reference.
- `BaseApi.Core` and `BaseConsole.Core` are siblings. Neither may reference the other. Shared code
  goes in `Messaging.Transport` or `Messaging.Contracts`, or is duplicated — see spec §2.3.

---

## File Structure

**Task 1 — transport fault type**
- Create `src/Messaging.Transport/TransientSendException.cs` — the marker every consumer classifies on.
- Create `src/Messaging.Transport/QueueSenderExtensions.cs` — `SendTransientAsync`, the wrapping call site.
- Test `src/tests/BaseApi.Tests/Transport/QueueSenderExtensionsTests.cs`.

**Task 2 — the third outcome**
- Create `src/BaseApi.Core/Messaging/DeliveryDisposition.cs` — the three-valued outcome.
- Create `src/BaseApi.Core/Messaging/DeliveryClassifier.cs` — pure, testable without a broker.
- Modify `src/BaseApi.Core/Messaging/GatedQueueConsumer.cs` — two `catch` blocks become one `switch`.
- Modify `src/Messaging.Transport/IQueueMessageHandler.cs` — the boundary rule, written once.
- Test `src/tests/BaseApi.Tests/Messaging/DeliveryClassifierTests.cs`.

**Task 3 — malformed request replies**
- Modify `src/Messaging.Contracts/ProcessorQueries.cs` — add `MalformedRequest`.
- Modify `src/Messaging.Contracts/MessageTypes.cs` — add its wire constant.
- Modify `src/BaseApi.Service/Features/Schema/Responders/GetSchemaDefinitionHandler.cs`.
- Modify `src/BaseApi.Service/Features/Processor/Responders/GetProcessorBySourceHashHandler.cs`.
- Modify `src/BaseConsole.Core/Messaging/DiscoveryReply.cs` — route the new reply.
- Test `src/tests/BaseApi.Tests/Messaging/MalformedRequestTests.cs`.

**Task 4 — RPC drop diagnostics**
- Modify `src/BaseApi.Core/Messaging/RpcQueueConsumer.cs` — four log sites gain `CorrelationId`.

**Task 5 — gating stack port**
- Create `src/BaseConsole.Core/Gating/` — six files ported from `BaseApi.Core`.
- Modify `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs`.
- Test `src/tests/BaseApi.Tests/Console/ConsoleL2GateTests.cs`.

---

### Task 1: The transport fault type

A send that fails because the broker is unreachable must be distinguishable from a message that
cannot be processed. Today both surface as bare exceptions and `GatedQueueConsumer` parks them.

The wrap goes in an extension method that handlers call, rather than in `QueueSender` itself, because
an extension substitutes cleanly in tests while `QueueSender` needs a live broker.

**Which failures get wrapped is the whole design of this task, and it is an allow-list.**
`QueueSender.SendAsync` serializes the body *inside* the call (`QueueSender.cs:49`) and validates its
arguments before that (`:46-47`), so a contract that cannot be serialized — or a blank queue name —
throws straight out of `SendAsync`. Wrapping everything would classify those as transient, and Task 2
then requeues them forever: an infinite redelivery loop for a message that can never succeed, which is
exactly the failure this whole design exists to prevent. Classifying by allow-list fails the other
way — an unrecognised transport fault gets parked, which is visible, recoverable by hand, and the
direction this system resolves every ambiguous case (spec §8.1).

**Files:**
- Create: `src/Messaging.Transport/TransientSendException.cs`
- Create: `src/Messaging.Transport/SendFaultClassifier.cs`
- Create: `src/Messaging.Transport/QueueSenderExtensions.cs`
- Test: `src/tests/BaseApi.Tests/Transport/QueueSenderExtensionsTests.cs`

**Interfaces:**
- Consumes: `IQueueSender.SendAsync<T>(string queue, string type, T body, CancellationToken ct, string? replyTo = null)` — existing.
- Produces:
  - `Messaging.Transport.TransientSendException : Exception` with `(string message, Exception inner)`.
  - `Messaging.Transport.QueueSenderExtensions.SendTransientAsync<T>(this IQueueSender sender, string queue, string type, T body, CancellationToken ct)` returning `Task`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Transport/QueueSenderExtensionsTests.cs`:

```csharp
using Messaging.Transport;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Xunit;

namespace BaseApi.Tests.Transport;

public sealed class QueueSenderExtensionsTests
{
    private sealed record Body(int Value);

    [Fact]
    public async Task WrapsASendFailureSoTheConsumerRequeuesInsteadOfParking()
    {
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Body>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(new IOException("socket closed"));

        var thrown = await Assert.ThrowsAsync<TransientSendException>(
            () => sender.SendTransientAsync("some-queue", "some-type", new Body(1), CancellationToken.None));

        Assert.IsType<IOException>(thrown.InnerException);
    }

    [Fact]
    public async Task NamesTheQueueSoTheFailureIsDiagnosableWithoutTheBody()
    {
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Body>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(new IOException("socket closed"));

        var thrown = await Assert.ThrowsAsync<TransientSendException>(
            () => sender.SendTransientAsync("orchestrator-result", "step-failed", new Body(1), CancellationToken.None));

        Assert.Contains("orchestrator-result", thrown.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DoesNotDoubleWrapAnAlreadyClassifiedFailure()
    {
        // A nested send that already classified itself must keep its original inner exception, or the
        // consumer's classifier sees a TransientSendException wrapping a TransientSendException and the
        // diagnosis loses the real cause.
        var sender = Substitute.For<IQueueSender>();
        var already = new TransientSendException("inner send failed", new IOException("socket closed"));
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Body>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(already);

        var thrown = await Assert.ThrowsAsync<TransientSendException>(
            () => sender.SendTransientAsync("some-queue", "some-type", new Body(1), CancellationToken.None));

        Assert.Same(already, thrown);
    }

    [Fact]
    public async Task PassesThroughWhenTheSendSucceeds()
    {
        var sender = Substitute.For<IQueueSender>();

        await sender.SendTransientAsync("some-queue", "some-type", new Body(1), CancellationToken.None);

        await sender.Received(1).SendAsync("some-queue", "some-type", Arg.Any<Body>(),
                                           Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    public static TheoryData<Exception> DeterministicFaults() =>
    [
        new System.Text.Json.JsonException("cycle detected"),
        new NotSupportedException("no converter for this type"),
        new ArgumentException("queue must not be blank"),
        new InvalidOperationException("programming error"),
    ];

    [Theory]
    [MemberData(nameof(DeterministicFaults))]
    public async Task LeavesADeterministicFaultUnwrappedSoTheConsumerParksIt(Exception deterministic)
    {
        // IQueueSender.SendAsync serializes the body and validates its arguments inside the call, so
        // these reach us. Wrapping one would tell the consumer to requeue a message that fails
        // identically on every redelivery — an outage that never resolves.
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Body>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(deterministic);

        var thrown = await Assert.ThrowsAnyAsync<Exception>(
            () => sender.SendTransientAsync("some-queue", "some-type", new Body(1), CancellationToken.None));

        Assert.Same(deterministic, thrown);
        Assert.IsNotType<TransientSendException>(thrown);
    }

    public static TheoryData<Exception> TransportFaults() =>
    [
        new IOException("socket closed"),
        new System.Net.Sockets.SocketException(),
        new TimeoutException("publish confirm timed out"),
        new OperationCanceledException("shutting down"),
        new InvalidOperationException("wrapped", new IOException("socket closed")),
    ];

    [Theory]
    [MemberData(nameof(TransportFaults))]
    public async Task WrapsATransportFaultSoTheConsumerRequeuesIt(Exception transport)
    {
        var sender = Substitute.For<IQueueSender>();
        sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<Body>(),
                         Arg.Any<CancellationToken>(), Arg.Any<string?>())
              .ThrowsAsync(transport);

        var thrown = await Assert.ThrowsAsync<TransientSendException>(
            () => sender.SendTransientAsync("some-queue", "some-type", new Body(1), CancellationToken.None));

        Assert.Same(transport, thrown.InnerException);
    }

    [Fact]
    public void FindsATransportFaultTheBrokerClientWrapped()
    {
        // Broker libraries wrap: a socket failure commonly arrives inside a higher-level exception, and
        // reading only the outermost type would classify it as unsendable and park recoverable work.
        var wrapped = new InvalidOperationException("outer",
            new InvalidOperationException("middle", new IOException("socket closed")));

        Assert.True(SendFaultClassifier.IsTransport(wrapped));
    }

    [Fact]
    public void DoesNotSeeATransportFaultWhereThereIsNone()
    {
        Assert.False(SendFaultClassifier.IsTransport(
            new InvalidOperationException("outer", new NotSupportedException("inner"))));
    }
}
```

> **On the `RabbitMQ.Client` namespace arm:** if you can find a broker-client exception with a
> constructor simple enough to build in a test without ceremony, add a case for it. If every one of
> them requires a `ShutdownEventArgs` or a live channel, do not contort the test — say so in your
> report and leave that arm covered by inspection. A test that fakes its way to a green tick proves
> less than an honest note.

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — `TransientSendException` and `SendTransientAsync` do not exist. That is
the correct failing state for a new type; do not proceed until you have seen it.

- [ ] **Step 3: Write the exception type**

Create `src/Messaging.Transport/TransientSendException.cs`:

```csharp
namespace Messaging.Transport;

/// <summary>
/// A send failed because the broker was unreachable, not because the message was wrong.
/// <para>
/// <b>This distinction decides whether work survives.</b> A consumer classifies an unrecognised
/// exception as the message being unprocessable and parks it on the first delivery, with no retry —
/// which is correct for a body that will never parse, and catastrophic for a send that failed during
/// a broker blip. The message was fine; only the environment was not, and a redelivery would succeed.
/// </para>
/// <para>
/// <b>It is deliberately not classified as a projection-store fault.</b> Those trip the L2 gate and
/// pause consumption, which is right when the store is unreachable and wrong here — pausing over a
/// broker fault spreads one dependency's failure to a dependency that is healthy.
/// </para>
/// <para>
/// <b>Not sealed, deliberately.</b> A caller that knows which send failed subclasses this to carry
/// that detail — the processor's post send does, so an author fanning out can tell which branch was
/// lost. The consumer classifies on the base type, so a subclass inherits the requeue disposition
/// without the classifier learning about it.
/// </para>
/// </summary>
public class TransientSendException : Exception
{
    public TransientSendException(string message, Exception inner) : base(message, inner)
    {
    }
}
```

- [ ] **Step 4: Write the extension method**

Create `src/Messaging.Transport/QueueSenderExtensions.cs`:

```csharp
namespace Messaging.Transport;

/// <summary>
/// Sending from inside a message handler, where a failure has to be classified rather than raised.
/// </summary>
public static class QueueSenderExtensions
{
    /// <summary>
    /// Sends, converting a recognised transport failure into a <see cref="TransientSendException"/> so
    /// the consumer returns the message to its queue instead of parking it. Every other failure
    /// propagates unchanged.
    /// <para>
    /// <b>Only recognised transport faults are wrapped, and the direction of that choice is
    /// deliberate.</b> <see cref="IQueueSender.SendAsync{T}"/> serializes the body inside the call and
    /// validates its arguments before that, so a contract that cannot be serialized throws straight
    /// through here. Wrapping it would tell the consumer to requeue a message that can never
    /// succeed — an infinite redelivery loop. An allow-list fails the other way: an unrecognised
    /// transport fault is parked, which is visible and recoverable by hand.
    /// </para>
    /// </summary>
    public static async Task SendTransientAsync<T>(
        this IQueueSender sender, string queue, string type, T body, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(sender);

        try
        {
            await sender.SendAsync(queue, type, body, ct).ConfigureAwait(false);
        }
        catch (TransientSendException)
        {
            // Already classified by a nested send. Re-wrapping would bury the real cause one level
            // deeper for no gain, and the consumer's classifier only reads the outermost type.
            throw;
        }
        catch (Exception ex) when (SendFaultClassifier.IsTransport(ex))
        {
            throw new TransientSendException($"send to {queue} failed", ex);
        }
    }
}
```

And create `src/Messaging.Transport/SendFaultClassifier.cs`:

```csharp
using System.Net.Sockets;

namespace Messaging.Transport;

/// <summary>
/// Whether a failure raised during a send is the transport failing, as opposed to the message being
/// unsendable.
/// <para>
/// <b>An allow-list, because the two mistakes are not equally bad.</b> Miss a transport fault and the
/// message is parked — visible in a dead-letter queue, recoverable by hand. Miss a deterministic
/// fault and the consumer requeues a message that will fail identically forever. The first is an
/// inconvenience; the second is an outage that never resolves.
/// </para>
/// <para>
/// The chain is walked because transport libraries wrap: a socket failure commonly arrives inside a
/// broker exception, and the outermost type alone would miss it.
/// </para>
/// </summary>
public static class SendFaultClassifier
{
    public static bool IsTransport(Exception ex)
    {
        ArgumentNullException.ThrowIfNull(ex);

        for (Exception? e = ex; e is not null; e = e.InnerException)
        {
            if (e is IOException or SocketException or TimeoutException or OperationCanceledException)
            {
                return true;
            }

            // Matched by namespace rather than by a list of type names: the broker client's exception
            // set changes between major versions, and a name list silently stops matching the type it
            // was written for while still compiling.
            if (e.GetType().Namespace?.StartsWith("RabbitMQ.Client", StringComparison.Ordinal) == true)
            {
                return true;
            }
        }

        return false;
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 163 tests — 157 pass, 6 skip, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/Messaging.Transport/TransientSendException.cs \
        src/Messaging.Transport/QueueSenderExtensions.cs \
        src/tests/BaseApi.Tests/Transport/QueueSenderExtensionsTests.cs
git commit -m "feat: classify a failed send as transient rather than unprocessable"
```

---

### Task 2: The third delivery outcome

`GatedQueueConsumer` has two dispositions: trip the gate and requeue, or park. A `TransientSendException`
needs a third — requeue with the gate left open — and the decision is worth testing without a broker,
so it moves into a pure function.

**Files:**
- Create: `src/BaseApi.Core/Messaging/DeliveryDisposition.cs`
- Create: `src/BaseApi.Core/Messaging/DeliveryClassifier.cs`
- Modify: `src/BaseApi.Core/Messaging/GatedQueueConsumer.cs:245-270` (the two `catch` blocks)
- Modify: `src/Messaging.Transport/IQueueMessageHandler.cs` (documentation only)
- Test: `src/tests/BaseApi.Tests/Messaging/DeliveryClassifierTests.cs`

**Interfaces:**
- Consumes: `Messaging.Transport.TransientSendException` (Task 1); `BaseApi.Core.Gating.L2FaultClassifier.IsTransient(Exception)` — existing.
- Produces:
  - `BaseApi.Core.Messaging.DeliveryDisposition` — `Park`, `Requeue`, `RequeueAndTrip`.
  - `BaseApi.Core.Messaging.DeliveryClassifier.Classify(Exception ex)` returning `DeliveryDisposition`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Messaging/DeliveryClassifierTests.cs`:

```csharp
using BaseApi.Core.Messaging;
using Messaging.Transport;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Messaging;

public sealed class DeliveryClassifierTests
{
    [Fact]
    public void ParksAFailureThatSaysTheMessageIsWrong()
    {
        var ex = new InvalidOperationException("no handler is registered for this message type");

        Assert.Equal(DeliveryDisposition.Park, DeliveryClassifier.Classify(ex));
    }

    [Fact]
    public void RequeuesAndTripsWhenTheProjectionStoreIsUnreachable()
    {
        var ex = new RedisTimeoutException("timed out", CommandStatus.Unknown);

        Assert.Equal(DeliveryDisposition.RequeueAndTrip, DeliveryClassifier.Classify(ex));
    }

    [Fact]
    public void RequeuesWithoutTrippingWhenOnlyTheBrokerFailed()
    {
        // The projection store said nothing about itself here. Tripping the gate would pause
        // consumption of a store that is healthy, spreading one dependency's outage to another.
        var ex = new TransientSendException("send to orchestrator-result failed",
                                            new IOException("socket closed"));

        Assert.Equal(DeliveryDisposition.Requeue, DeliveryClassifier.Classify(ex));
    }

    [Fact]
    public void PrefersTheSendClassificationWhenAStoreFaultIsNestedBeneathIt()
    {
        // A send failure whose chain happens to contain a Redis type must not trip the gate: the
        // outermost classification is the one that names what actually failed. L2FaultClassifier
        // walks the whole chain, so without an explicit ordering it would win.
        var ex = new TransientSendException("send to orchestrator-result failed",
                                            new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        Assert.Equal(DeliveryDisposition.Requeue, DeliveryClassifier.Classify(ex));
    }

    [Fact]
    public void FindsAStoreFaultWrappedByAHandler()
    {
        // L2FaultClassifier already walks the chain; this pins that the classifier does not lose it.
        var ex = new InvalidOperationException("projecting the workflow failed",
                                               new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        Assert.Equal(DeliveryDisposition.RequeueAndTrip, DeliveryClassifier.Classify(ex));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — `DeliveryDisposition` and `DeliveryClassifier` do not exist.

- [ ] **Step 3: Write the disposition enum**

Create `src/BaseApi.Core/Messaging/DeliveryDisposition.cs`:

```csharp
namespace BaseApi.Core.Messaging;

/// <summary>What a consumer does with a delivery whose handling threw.</summary>
public enum DeliveryDisposition
{
    /// <summary>
    /// Reject without requeue. The message is unprocessable and no redelivery can change that, so it
    /// goes to the dead-letter queue where a human can recover it.
    /// </summary>
    Park,

    /// <summary>
    /// Return to the queue, leaving the projection-store gate open. Something other than the store
    /// failed — a broker send, typically — and consumption should continue.
    /// </summary>
    Requeue,

    /// <summary>
    /// Return to the queue and close the gate. The projection store is unreachable, so every message
    /// would fail the same way; pausing at the broker costs nothing while it recovers.
    /// </summary>
    RequeueAndTrip,
}
```

- [ ] **Step 4: Write the classifier**

Create `src/BaseApi.Core/Messaging/DeliveryClassifier.cs`:

```csharp
using BaseApi.Core.Gating;
using Messaging.Transport;

namespace BaseApi.Core.Messaging;

/// <summary>
/// The single branch that decides a failed delivery's fate, extracted from the consumer so it can be
/// exercised without a broker.
/// <para>
/// <b>The order of the two transient tests is load-bearing.</b>
/// <see cref="L2FaultClassifier.IsTransient"/> walks the entire exception chain, so a send failure
/// that happens to wrap a Redis type would be read as a store outage and would close the gate —
/// pausing consumption over a store that never failed. Testing the send classification first makes
/// the outermost type the one that decides, which is the type that names what actually broke.
/// </para>
/// </summary>
public static class DeliveryClassifier
{
    public static DeliveryDisposition Classify(Exception ex)
    {
        ArgumentNullException.ThrowIfNull(ex);

        if (ex is TransientSendException)
        {
            return DeliveryDisposition.Requeue;
        }

        return L2FaultClassifier.IsTransient(ex)
            ? DeliveryDisposition.RequeueAndTrip
            : DeliveryDisposition.Park;
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 168 tests — 162 pass, 6 skip, exit 0.

- [ ] **Step 6: Wire the classifier into the consumer**

In `src/BaseApi.Core/Messaging/GatedQueueConsumer.cs`, replace the two `catch` blocks at the end of
`OnReceivedAsync` — the one filtered on `L2FaultClassifier.IsTransient` and the bare `catch (Exception ex)` —
with a single block:

```csharp
        catch (Exception ex)
        {
            switch (DeliveryClassifier.Classify(ex))
            {
                case DeliveryDisposition.RequeueAndTrip:
                    _logger.LogWarning(
                        ex, "projection store unreachable — returning message to {Queue}", _options.Queue);

                    // Awaited rather than fired and forgotten: closing the gate before the message goes
                    // back means the redelivery finds it already closed instead of racing it. That is
                    // only safe because gate subscribers signal rather than perform I/O — a subscriber
                    // that did broker work inside the notification would deadlock here.
                    await _gate.TripAsync().ConfigureAwait(false);
                    await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);
                    break;

                case DeliveryDisposition.Requeue:
                    // The projection store said nothing about itself, so the gate stays open and this
                    // consumer keeps working. Only this delivery goes back.
                    _logger.LogWarning(
                        ex, "send failed while handling {Type} — returning message to {Queue}",
                        type, _options.Queue);
                    await SafeNackAsync(ea, requeue: true, epoch).ConfigureAwait(false);
                    break;

                default:
                    // Taken as a property of the message rather than of the environment. A parked
                    // message can be recovered by hand; a message requeued forever is an outage that
                    // never resolves, so the ambiguous case is deliberately resolved toward parking.
                    _logger.LogError(ex, "refusing message of type {Type} — parking", type);
                    await SafeNackAsync(ea, requeue: false, epoch).ConfigureAwait(false);
                    break;
            }
        }
```

Add `using Messaging.Transport;` only if it is not already present — it is, via `RabbitMqConnection`.

- [ ] **Step 7: Document the boundary rule on the handler contract**

In `src/Messaging.Transport/IQueueMessageHandler.cs`, extend the interface's XML doc with a third
`<para>` before the existing scoped-dependency paragraph:

```csharp
/// <para>
/// <b>Deserialization is the line.</b> Above it — a body that will not parse, a missing or unknown
/// type header — throwing is correct: the message is unroutable, no redelivery can fix it, and the
/// consumer parks it where the bytes survive for inspection. Below it, once there is a readable
/// message with real ids in hand, a handler must not throw for a business reason. A business failure
/// is an outcome to report on whatever channel the message came with, followed by a normal return;
/// throwing instead parks work that was understood perfectly well.
/// </para>
/// <para>
/// A send that fails while handling is neither. Wrap it — <see cref="Messaging.Transport.QueueSenderExtensions.SendTransientAsync{T}"/>
/// does — so the delivery is returned to the queue without the projection-store gate being closed
/// over a broker fault.
/// </para>
```

- [ ] **Step 8: Run the tests to verify nothing regressed**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 168 tests — 162 pass, 6 skip, exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/BaseApi.Core/Messaging/DeliveryDisposition.cs \
        src/BaseApi.Core/Messaging/DeliveryClassifier.cs \
        src/BaseApi.Core/Messaging/GatedQueueConsumer.cs \
        src/Messaging.Transport/IQueueMessageHandler.cs \
        src/tests/BaseApi.Tests/Messaging/DeliveryClassifierTests.cs
git commit -m "feat: requeue a failed send without closing the projection-store gate"
```

---

### Task 3: Reject a request whose required field arrived as its default

`MessagingJson.Options` sets `PropertyNameCaseInsensitive = false` deliberately, so a property whose
name does not match binds to its type default rather than throwing. A request for
`{"schemaId": "..."}` against a contract expecting `SchemaId` therefore deserializes cleanly to
`GetSchemaDefinition(Guid.Empty)`, the handler looks that up, gets not-found, and replies not-found.
The caller reads that as "not registered yet" and retries forever, never booting, with no error
logged on either side.

**Files:**
- Modify: `src/Messaging.Contracts/ProcessorQueries.cs`
- Modify: `src/Messaging.Contracts/MessageTypes.cs`
- Modify: `src/BaseApi.Service/Features/Schema/Responders/GetSchemaDefinitionHandler.cs`
- Modify: `src/BaseApi.Service/Features/Processor/Responders/GetProcessorBySourceHashHandler.cs`
- Modify: `src/BaseConsole.Core/Messaging/DiscoveryReply.cs`
- Test: `src/tests/BaseApi.Tests/Messaging/MalformedRequestTests.cs`

**Interfaces:**
- Consumes: `BaseApi.Core.Messaging.IRpcHandler.HandleAsync(ReadOnlyMemory<byte> body, CancellationToken ct)` returning `Task<RpcReply>`; `RpcReply(string Type, byte[] Body)` — both existing.
- Produces:
  - `Messaging.Contracts.MalformedRequest(string Field)`.
  - `Messaging.Contracts.MessageTypes.MalformedRequest = "malformed-request"`.
  - `GetSchemaDefinitionHandler.Reject(GetSchemaDefinition)` returning `RpcReply?` — `internal static`.
  - `GetProcessorBySourceHashHandler.Reject(GetProcessorBySourceHash)` returning `RpcReply?` — `internal static`.

`BaseApi.Service` already carries `InternalsVisibleTo("BaseApi.Tests")`, so the statics are reachable
from the test project without a project change. `RpcReply.Body` is a `ReadOnlyMemory<byte>`, so a test
deserializing it passes `reply.Body.Span`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Messaging/MalformedRequestTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Service.Features.Processor.Responders;
using BaseApi.Service.Features.Schema.Responders;
using BaseConsole.Core.Messaging;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Messaging;

public sealed class MalformedRequestTests
{
    // The guard is a static so it can be exercised without a handler instance. Both handlers take a
    // sealed service that cannot be substituted and null-guard it in their constructors, so there is
    // no way to build one for a test — and the guard is the whole behaviour under test anyway.
    [Fact]
    public void AMisnamedFieldBindsToItsDefaultRatherThanThrowing()
    {
        // The premise of this whole task, pinned so it cannot drift: MessagingJson is case-sensitive
        // by design, so "schemaId" does not bind to SchemaId and the property silently defaults.
        var request = JsonSerializer.Deserialize<GetSchemaDefinition>(
            """{"schemaId":"7a1d9e2c-0000-0000-0000-000000000001"}"""u8, MessagingJson.Options);

        Assert.Equal(Guid.Empty, request!.SchemaId);
    }

    [Fact]
    public void SchemaLookupRefusesAnEmptyIdInsteadOfAnsweringNotFound()
    {
        // Answering not-found here would read to the caller as "not registered yet", and it would
        // retry forever without anything being logged on either side.
        var reply = GetSchemaDefinitionHandler.Reject(new GetSchemaDefinition(Guid.Empty));

        Assert.NotNull(reply);
        Assert.Equal(MessageTypes.MalformedRequest, reply!.Type);
        var body = JsonSerializer.Deserialize<MalformedRequest>(reply.Body.Span, MessagingJson.Options);
        Assert.Equal(nameof(GetSchemaDefinition.SchemaId), body!.Field);
    }

    [Fact]
    public void SchemaLookupPassesAWellFormedRequestThrough()
    {
        Assert.Null(GetSchemaDefinitionHandler.Reject(new GetSchemaDefinition(Guid.NewGuid())));
    }

    [Fact]
    public void IdentityLookupRefusesAnEmptySourceHash()
    {
        var reply = GetProcessorBySourceHashHandler.Reject(new GetProcessorBySourceHash(""));

        Assert.NotNull(reply);
        Assert.Equal(MessageTypes.MalformedRequest, reply!.Type);
        var body = JsonSerializer.Deserialize<MalformedRequest>(reply.Body.Span, MessagingJson.Options);
        Assert.Equal(nameof(GetProcessorBySourceHash.SourceHash), body!.Field);
    }

    [Fact]
    public void IdentityLookupPassesAWellFormedRequestThrough()
    {
        Assert.Null(GetProcessorBySourceHashHandler.Reject(new GetProcessorBySourceHash("abc123")));
    }

    [Fact]
    public void TheReplyRouterRecognisesIt()
    {
        // Without this the caller drops the reply as an unknown type and still waits out its timeout,
        // which is the failure this whole task exists to remove.
        var routed = DiscoveryReplyRouter.Route(
            MessageTypes.MalformedRequest,
            JsonSerializer.SerializeToUtf8Bytes(new MalformedRequest("SchemaId"), MessagingJson.Options));

        var typed = Assert.IsType<MalformedRequest>(routed);
        Assert.Equal("SchemaId", typed.Field);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — `MalformedRequest` and `MessageTypes.MalformedRequest` do not exist.

- [ ] **Step 3: Add the contract and its wire constant**

Append to `src/Messaging.Contracts/ProcessorQueries.cs`:

```csharp
// A request whose required field arrived as its type default. Distinct from not-found: not-found is
// an answer about the data, this is an answer about the request. The caller can log and stop
// retrying something that will never succeed.
public sealed record MalformedRequest(string Field);
```

Append to `src/Messaging.Contracts/MessageTypes.cs`, inside the class:

```csharp
    /// <summary>Reply body is a <see cref="Messaging.Contracts.MalformedRequest"/>.</summary>
    public const string MalformedRequest = "malformed-request";
```

- [ ] **Step 4: Guard the schema handler**

In `src/BaseApi.Service/Features/Schema/Responders/GetSchemaDefinitionHandler.cs`, add the guard as a
static — the handler's service is sealed and null-guarded in the constructor, so a test can never
build an instance, and a static keeps the decision reachable:

```csharp
    /// <summary>
    /// The refusal reply for a request whose id did not bind, or null when the request is usable.
    /// <para>
    /// A <see cref="Guid.Empty"/> here means the field did not bind — <c>MessagingJson</c> is
    /// case-sensitive by design, so a producer sending <c>"schemaId"</c> lands on the default rather
    /// than throwing. Answering not-found would be a valid-looking reply that the caller reads as
    /// "not registered yet", leaving it to retry forever with nothing logged anywhere.
    /// </para>
    /// </summary>
    internal static RpcReply? Reject(GetSchemaDefinition request)
        => request.SchemaId == Guid.Empty
            ? new RpcReply(
                MessageTypes.MalformedRequest,
                JsonSerializer.SerializeToUtf8Bytes(
                    new MalformedRequest(nameof(GetSchemaDefinition.SchemaId)), MessagingJson.Options))
            : null;
```

Then call it in `HandleAsync`, immediately after the `Deserialize` line and before the `try`:

```csharp
        if (Reject(request) is { } malformed)
        {
            return malformed;
        }
```

- [ ] **Step 5: Guard the identity handler**

In `src/BaseApi.Service/Features/Processor/Responders/GetProcessorBySourceHashHandler.cs`, the same
shape:

```csharp
    /// <summary>
    /// The refusal reply for a request whose source hash did not bind, or null when it is usable. See
    /// <c>GetSchemaDefinitionHandler.Reject</c>: an unbound field defaults rather than throwing, and a
    /// not-found reply for one is indistinguishable from a processor that is simply not registered
    /// yet — which the caller retries forever.
    /// </summary>
    internal static RpcReply? Reject(GetProcessorBySourceHash request)
        => string.IsNullOrWhiteSpace(request.SourceHash)
            ? new RpcReply(
                MessageTypes.MalformedRequest,
                JsonSerializer.SerializeToUtf8Bytes(
                    new MalformedRequest(nameof(GetProcessorBySourceHash.SourceHash)), MessagingJson.Options))
            : null;
```

Then call it in `HandleAsync`, in the same position:

```csharp
        if (Reject(request) is { } malformed)
        {
            return malformed;
        }
```

- [ ] **Step 6: Route the reply**

In `src/BaseConsole.Core/Messaging/DiscoveryReply.cs`, add an arm to the `switch` before the `_ => null`:

```csharp
        MessageTypes.MalformedRequest =>
            JsonSerializer.Deserialize<MalformedRequest>(body.Span, MessagingJson.Options),
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 171 tests — 165 pass, 6 skip, exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/Messaging.Contracts/ProcessorQueries.cs \
        src/Messaging.Contracts/MessageTypes.cs \
        src/BaseApi.Service/Features/Schema/Responders/GetSchemaDefinitionHandler.cs \
        src/BaseApi.Service/Features/Processor/Responders/GetProcessorBySourceHashHandler.cs \
        src/BaseConsole.Core/Messaging/DiscoveryReply.cs \
        src/tests/BaseApi.Tests/Messaging/MalformedRequestTests.cs
git commit -m "feat: answer a request whose required field did not bind"
```

**Note for the follow-on plan:** the processor's startup loops still treat a `MalformedRequest` reply
as "no answer" and retry. Logging it distinctly is a task in
`2026-08-20-processor-execution-path.md`, not here — this task only ensures the reply exists and
arrives.

---

### Task 4: Name the caller in RPC drop diagnostics

Four log sites in `RpcQueueConsumer` record a dropped or failed query without the correlation id,
even though it is read at the top of the method and echoed onto every successful reply. That id is
the only thing linking an API-side failure to a processor-side startup loop that is still spinning,
and those query queues have no dead-letter exchange by design — the log is the only artifact.

This change has no unit test: `RpcQueueConsumer` is a `BackgroundService` holding a real
`RabbitMqConnection`, and extracting a seam for four log lines would cost more than it proves. It is
verified by inspection and by the `Live/` suite continuing to pass.

**Files:**
- Modify: `src/BaseApi.Core/Messaging/RpcQueueConsumer.cs:118-172`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

- [ ] **Step 1: Add the correlation id to all four sites**

In `OnReceivedAsync`, rewrite the four log calls. `correlationId` is already in scope from
`ea.BasicProperties.CorrelationId`.

```csharp
            if (string.IsNullOrWhiteSpace(replyTo))
            {
                _logger.LogWarning(
                    "query on {Queue} carried no reply address — dropping {CorrelationId}",
                    _queue, correlationId);
                return;
            }

            if (string.IsNullOrWhiteSpace(requestType))
            {
                _logger.LogWarning(
                    "query on {Queue} carried no type header — dropping {CorrelationId}",
                    _queue, correlationId);
                return;
            }
```

```csharp
            if (handler is null)
            {
                _logger.LogWarning(
                    "no handler for query type {Type} on {Queue} — dropping {CorrelationId}",
                    requestType, _queue, correlationId);
                return;
            }
```

```csharp
        catch (Exception ex)
        {
            // The caller is waiting and will time out; there is nothing useful to send them, and no
            // reason to keep the request. The correlation id is what lets an operator match this line
            // to the startup loop still retrying on the other side — these queues have no dead-letter
            // exchange, so this record is the only artifact the failure leaves.
            _logger.LogError(
                ex, "query of type {Type} on {Queue} failed {CorrelationId}",
                requestType, _queue, correlationId);
        }
```

- [ ] **Step 2: Run the tests to verify nothing regressed**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 171 tests — 165 pass, 6 skip, exit 0.

- [ ] **Step 3: Confirm no payload reached a log**

```bash
grep -n "LogWarning\|LogError\|LogInformation" src/BaseApi.Core/Messaging/RpcQueueConsumer.cs
```

Expected: every template argument is `_queue`, `requestType`, or `correlationId`. If `body` appears
in any of them, remove it — a query body can carry a source hash or schema definition.

- [ ] **Step 4: Commit**

```bash
git add src/BaseApi.Core/Messaging/RpcQueueConsumer.cs
git commit -m "fix: name the caller in RPC drop diagnostics"
```

---

### Task 5: Port the gating stack into `BaseConsole.Core`

`BaseProcessor.Core` reaches the broker and Redis through `BaseConsole.Core`, which has no gate.
`BaseApi.Core` has one, but the two are siblings with no reference between them, and the spec's
decision (§2.3) is to duplicate rather than introduce an edge — which is already this repository's
convention for `RequiredConfig`, `ILoopHeartbeat`, `LoopHeartbeat`, `LoopLivenessHealthCheck`,
`IStartupGate` and `StartupHealthCheck`.

**Files:**
- Create: `src/BaseConsole.Core/Gating/L2Gate.cs`
- Create: `src/BaseConsole.Core/Gating/L2GateOptions.cs`
- Create: `src/BaseConsole.Core/Gating/L2GateProbe.cs`
- Create: `src/BaseConsole.Core/Gating/L2FaultClassifier.cs`
- Create: `src/BaseConsole.Core/Gating/DeliveryDisposition.cs`
- Create: `src/BaseConsole.Core/Gating/DeliveryClassifier.cs`
- Create: `src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs`
- Create: `src/BaseConsole.Core/Messaging/GatedConsumerOptions.cs`
- Modify: `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs`
- Test: `src/tests/BaseApi.Tests/Console/ConsoleL2GateTests.cs`

**Interfaces:**
- Consumes: `Messaging.Transport.RabbitMqConnection`, `Messaging.Transport.IQueueMessageHandler`, `Messaging.Transport.TransientSendException` (Task 1); `BaseConsole.Core.Loop.ILoopHeartbeat` — existing.
- Produces:
  - `BaseConsole.Core.Gating.L2Gate` — `IsOpen`, `StateChanged`, `Tripped`, `TripAsync()`, `ReportHealthyAsync()`.
  - `BaseConsole.Core.Gating.DeliveryClassifier.Classify(Exception)` returning `BaseConsole.Core.Gating.DeliveryDisposition`.
  - `BaseConsole.Core.Messaging.GatedQueueConsumer` — a `BackgroundService`; `IsConsuming`, `IsChannelUsable`.
  - `BaseConsole.Core.Messaging.GatedConsumerOptions` — `Queue`, `PrefetchCount`, `ConvergeInterval`.
  - `AddBaseConsoleGating(this IServiceCollection, IConfiguration, string queue)` on the existing Redis extensions class.

- [ ] **Step 1: Write the failing test**

Create `src/tests/BaseApi.Tests/Console/ConsoleL2GateTests.cs`. This mirrors `Gating/L2GateTests.cs`
against the console copy — the duplication is the point, since the two must not drift silently.

```csharp
using BaseApi.Tests.Support;
using BaseConsole.Core.Gating;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Console;

public sealed class ConsoleL2GateTests
{
    private static (L2Gate Gate, RecordingLogger<L2Gate> Log) Build()
    {
        var log = new RecordingLogger<L2Gate>();
        return (new L2Gate(log), log);
    }

    [Fact]
    public async Task StartsClosedSoNothingConsumesBeforeTheStoreIsProvenReachable()
    {
        var (gate, _) = Build();

        Assert.False(gate.IsOpen);
        await Task.CompletedTask;
    }

    [Fact]
    public async Task OpensWhenTheProbeReportsHealthy()
    {
        var (gate, log) = Build();

        await gate.ReportHealthyAsync();

        Assert.True(gate.IsOpen);
        var record = Assert.Single(log.Records);
        Assert.Equal(LogLevel.Information, record.Level);
    }

    [Fact]
    public async Task ClosesWhenTripped()
    {
        var (gate, _) = Build();
        await gate.ReportHealthyAsync();

        await gate.TripAsync();

        Assert.False(gate.IsOpen);
    }

    [Fact]
    public async Task SignalsSubscribersOnEachTransition()
    {
        var (gate, _) = Build();
        var seen = new List<bool>();
        gate.StateChanged += open => seen.Add(open);

        await gate.ReportHealthyAsync();
        await gate.TripAsync();

        Assert.Equal([true, false], seen);
    }

    [Fact]
    public void ClassifiesTheThreeDeliveryOutcomes()
    {
        // The console copy must classify identically to the API copy, or a processor and the API would
        // disagree about whether a broker fault closes the gate.
        Assert.Equal(DeliveryDisposition.Park,
            DeliveryClassifier.Classify(new InvalidOperationException("message carries no type header")));

        Assert.Equal(DeliveryDisposition.RequeueAndTrip,
            DeliveryClassifier.Classify(new RedisTimeoutException("timed out", CommandStatus.WaitingInBacklog)));

        Assert.Equal(DeliveryDisposition.Requeue,
            DeliveryClassifier.Classify(new TransientSendException("send failed", new IOException("closed"))));
    }

    [Fact]
    public void PrefersTheSendClassificationWhenAStoreFaultIsNestedBeneathIt()
    {
        // The highest-risk drift this file exists to catch. L2FaultClassifier walks the whole inner
        // chain, so if the two branches of Classify were ever reordered in the console copy, a send
        // failure that happens to wrap a Redis type would close the gate over a store that never
        // failed — and every flat-exception assertion above would still pass.
        var ex = new TransientSendException("send to orchestrator-result failed",
            new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        Assert.Equal(DeliveryDisposition.Requeue, DeliveryClassifier.Classify(ex));
    }

    [Fact]
    public async Task DoesNotLogWhenTheStateIsUnchanged()
    {
        // The probe reports healthy on every healthy tick, so a per-call log would bury the transitions
        // this gate exists to surface. Pins the dedup guard inside SetAsync, which the transition tests
        // above cannot see.
        var (gate, log) = Build();
        await gate.ReportHealthyAsync();
        log.Records.Clear();

        await gate.ReportHealthyAsync();

        Assert.Empty(log.Records);
    }

    [Fact]
    public async Task DoesNotLogTrippingAGateThatStartedClosed()
    {
        var (gate, log) = Build();

        await gate.TripAsync();

        Assert.Empty(log.Records);
    }
}
```

The last three are not padding. The doc paragraph added to the console `L2Gate` in Step 4 claims the
two copies "are covered by parallel test classes so a change to one that is not made to the other
fails a build" — and that claim is only true if the parallel class covers the cases that actually
drift. A reordering of `Classify`'s two branches and a removal of the dedup guard are precisely the
two regressions that pass every flat, single-transition assertion.

- [ ] **Step 2: Run the test to verify it fails**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: **build failure** — the `BaseConsole.Core.Gating` namespace does not exist.

- [ ] **Step 3: Copy the six gating files**

```bash
mkdir -p src/BaseConsole.Core/Gating
cp src/BaseApi.Core/Gating/L2Gate.cs           src/BaseConsole.Core/Gating/L2Gate.cs
cp src/BaseApi.Core/Gating/L2GateOptions.cs    src/BaseConsole.Core/Gating/L2GateOptions.cs
cp src/BaseApi.Core/Gating/L2GateProbe.cs      src/BaseConsole.Core/Gating/L2GateProbe.cs
cp src/BaseApi.Core/Gating/L2FaultClassifier.cs src/BaseConsole.Core/Gating/L2FaultClassifier.cs
cp src/BaseApi.Core/Messaging/DeliveryDisposition.cs src/BaseConsole.Core/Gating/DeliveryDisposition.cs
cp src/BaseApi.Core/Messaging/DeliveryClassifier.cs  src/BaseConsole.Core/Gating/DeliveryClassifier.cs
cp src/BaseApi.Core/Messaging/GatedQueueConsumer.cs  src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs
cp src/BaseApi.Core/Messaging/GatedConsumerOptions.cs src/BaseConsole.Core/Messaging/GatedConsumerOptions.cs
```

- [ ] **Step 4: Repoint the namespaces and usings**

In every one of the eight new files:

- `namespace BaseApi.Core.Gating;` → `namespace BaseConsole.Core.Gating;`
- `namespace BaseApi.Core.Messaging;` → `namespace BaseConsole.Core.Messaging;`
- `using BaseApi.Core.Gating;` → `using BaseConsole.Core.Gating;`

In `src/BaseConsole.Core/Gating/DeliveryDisposition.cs` and `DeliveryClassifier.cs`, the namespace
becomes `BaseConsole.Core.Gating` (not `.Messaging`) — the console copy groups them with the gate
they serve, since the console has no separate messaging-abstractions folder.

`ILoopHeartbeat` is referenced by **`L2GateProbe.cs`**, not by `GatedQueueConsumer.cs`. On the console
side it resolves from `BaseConsole.Core.Loop`, so add that using. The console interface is a superset
of the `BaseApi.Core.Gating` one — it adds `IsRetired` and `Retire()` — so the port compiles as long
as `L2GateProbe` touches only `Beat()` and `Last`. If it turns out to touch anything else, stop and
report it rather than implementing the extra members.

Then add a header paragraph to `src/BaseConsole.Core/Gating/L2Gate.cs`, immediately below the existing
summary, so the duplication is deliberate on the page rather than a discovery:

```csharp
/// <para>
/// <b>This is a deliberate copy of <c>BaseApi.Core.Gating.L2Gate</c>, not a shared type.</b>
/// The API and console halves are siblings with no reference between them, and this repository
/// already carries paired copies of <c>RequiredConfig</c>, <c>ILoopHeartbeat</c>,
/// <c>LoopHeartbeat</c>, <c>LoopLivenessHealthCheck</c>, <c>IStartupGate</c> and
/// <c>StartupHealthCheck</c> for the same reason. Behaviour must not diverge: the two are covered by
/// parallel test classes so a change to one that is not made to the other fails a build.
/// </para>
```

- [ ] **Step 5: Add the registration extension**

Append to the class in `src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs`:

```csharp
    /// <summary>Heartbeat key for the gate probe's loop. One holder per loop, never shared.</summary>
    public const string GateLoop = "l2-gate";

    /// <summary>
    /// Registers the projection-store gate, its probe, and one gated consumer bound to
    /// <paramref name="queue"/>.
    /// <para>
    /// The queue must already be declared by an <see cref="Messaging.Transport.IRabbitMqTopology"/>
    /// unit. The consumer deliberately does not declare it: a paused consumer declares nothing, and a
    /// send arriving in that window would address a queue that does not exist — which the broker
    /// discards while still confirming, so the sender is told the message was accepted.
    /// </para>
    /// </summary>
    public static IServiceCollection AddBaseConsoleGating(
        this IServiceCollection services, IConfiguration cfg, string queue)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(cfg);
        ArgumentException.ThrowIfNullOrWhiteSpace(queue);

        services.Configure<L2GateOptions>(cfg.GetSection("L2Gate"));
        services.Configure<GatedConsumerOptions>(o => o.Queue = queue);

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<L2Gate>();

        // The probe takes an ILoopHeartbeat, and on the console side every heartbeat is registered
        // KEYED — one holder per loop, because a holder shared between two loops lets the faster
        // loop's beat refresh the stamp for both and a dead loop stays invisible. There is no unkeyed
        // registration anywhere in this stack, so a plain AddHostedService<L2GateProbe>() would build
        // a service graph that fails to resolve at startup.
        services.AddKeyedSingleton<ILoopHeartbeat>(
            GateLoop, (sp, _) => new LoopHeartbeat(sp.GetRequiredService<TimeProvider>()));
        services.AddHostedService(sp => ActivatorUtilities.CreateInstance<L2GateProbe>(
            sp, sp.GetRequiredKeyedService<ILoopHeartbeat>(GateLoop)));

        services.TryAddSingleton<GatedQueueConsumer>();
        services.AddHostedService(sp => sp.GetRequiredService<GatedQueueConsumer>());

        return services;
    }
```

The gate loop deliberately gets no `LoopLivenessHealthCheck` of its own here. The two loops that have
one — startup and liveness — are watched because a wedged one strands the processor silently. A
wedged gate probe leaves the gate in whatever state it last held, which the consumer's own logging
already makes visible. Add one when something needs it, not before.

Add whatever `using` directives this needs — `BaseConsole.Core.Gating`, `BaseConsole.Core.Messaging`,
`Microsoft.Extensions.DependencyInjection.Extensions` — if not already present.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj
```

Expected: 176 tests — 170 pass, 6 skip, exit 0.

- [ ] **Step 7: Confirm the firewall still holds**

```bash
# Real references only — the doc paragraph from Step 4 names BaseApi.Core.Gating.L2Gate on purpose,
# so a bare grep hits it and reports a firewall breach that isn't one.
grep -rn "BaseApi" src/BaseConsole.Core/ --include=*.cs | grep -v ':[0-9]*: *///'
grep -o 'ProjectReference Include="[^"]*"' src/BaseConsole.Core/BaseConsole.Core.csproj
```

Expected: the first prints nothing. The second prints only `Messaging.Transport` and
`Messaging.Contracts`. A `BaseApi.Core` reference here means the port was done wrong — revert and
repeat Step 4. A hit inside an XML doc comment is not a breach: naming the type this one is a copy of
is what makes the duplication deliberate rather than accidental.

- [ ] **Step 8: Commit**

```bash
git add src/BaseConsole.Core/Gating/ \
        src/BaseConsole.Core/Messaging/GatedQueueConsumer.cs \
        src/BaseConsole.Core/Messaging/GatedConsumerOptions.cs \
        src/BaseConsole.Core/DependencyInjection/ConsoleRedisServiceCollectionExtensions.cs \
        src/tests/BaseApi.Tests/Console/ConsoleL2GateTests.cs
git commit -m "feat: give console hosts the projection-store gate"
```

---

## Done When

- `dotnet test src/tests/BaseApi.Tests/BaseApi.Tests.csproj` reports 176 tests — 170 pass, 6 skip,
  exit 0.
- `grep -rn "BaseApi" src/BaseConsole.Core/ --include=*.cs` prints nothing.
- A `TransientSendException` raised inside a handler returns its delivery to the queue with
  `L2Gate.IsOpen` unchanged.
- A query carrying `{"schemaId": ...}` receives a `malformed-request` reply rather than
  `schema-definition-not-found`.

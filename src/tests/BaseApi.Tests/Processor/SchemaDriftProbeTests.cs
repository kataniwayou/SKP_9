using BaseApi.Tests.Support;
using BaseConsole.Core.Health;
using BaseConsole.Core.Messaging;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Startup;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Processor;

/// <summary>
/// The loop that notices a schema edge moving under a running replica.
/// <para>
/// Every test here calls <c>CheckOnceAsync</c> rather than running the loop. The loop is a delay and
/// a gate check; the claim worth pinning is the COMPARISON and what it says, and driving a
/// <c>FakeTimeProvider</c> to reach it would test the pump more than the probe.
/// </para>
/// </summary>
public sealed class SchemaDriftProbeTests
{
    private static readonly Guid P = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid Input = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid Output = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid Config = Guid.Parse("44444444-4444-4444-4444-444444444444");

    /// <summary>Answers the one ask with a fixed reply, published into the slot as a consumer would.</summary>
    private sealed class ScriptedSender(ReplySlot<object> slot, object? reply) : IQueueSender
    {
        public int Sends { get; private set; }

        /// <summary>The last body sent, so a test can assert what the probe actually asked for.</summary>
        public object? LastBody { get; private set; }

        public Task SendAsync<T>(
            string queue, string type, T body, CancellationToken ct,
            string? replyTo = null, string? correlationId = null)
        {
            Sends++;
            LastBody = body;
            if (reply is not null)
            {
                slot.Publish(reply);
            }

            return Task.CompletedTask;
        }
    }

    private sealed class OpenGate : IStartupGate
    {
        public bool IsReady => true;

        public void MarkReady()
        {
            // Already open; the probe only reads the gate.
        }
    }

    private sealed class FixedHash : ISourceHashProvider
    {
        public string Get() => "abc123";
    }

    /// <summary>
    /// Supplies the instance id the probe asks with. Null is the shared-row case — what every
    /// processor deployed as a Deployment sends.
    /// </summary>
    private sealed class FixedInstance(string? instanceId) : IProcessorInstanceIdProvider
    {
        public string? Get() => instanceId;
    }

    private sealed class Harness
    {
        public Harness(
            object? reply, Guid? input = null, Guid? output = null, Guid? config = null,
            string? instanceId = null)
        {
            var slot = new ReplySlot<object>();
            Sender = new ScriptedSender(slot, reply);
            Log = new RecordingLogger<SchemaDriftProbe>();

            var context = new ProcessorContext();
            context.SetIdentity(new ProcessorIdentityFound(
                P, input ?? Input, output ?? Output, config ?? Config, "sample", "1.0.0"));

            var replies = new StubReplyEndpoint();

            Probe = new SchemaDriftProbe(
                Sender, replies, slot, context, new FixedHash(), new FixedInstance(instanceId),
                new OpenGate(),
                Options.Create(new ProcessorLivenessOptions { RequestTimeoutSeconds = 1 }),
                new FakeTimeProvider(), Log);
        }

        public SchemaDriftProbe Probe { get; }
        public ScriptedSender Sender { get; }
        public RecordingLogger<SchemaDriftProbe> Log { get; }
    }

    /// <summary>
    /// The probe must re-ask with the pair the boot loop resolved with, not with the hash alone.
    /// Asking by hash alone would drift-check whichever row that hash happens to return — for a
    /// StatefulSet replica, a sibling's registration — and then report a mismatch against schemas
    /// this processor never adopted, or a clean bill of health against them.
    /// </summary>
    [Fact]
    public async Task TheProbeAsksWithTheConfiguredInstanceId()
    {
        var h = new Harness(
            new ProcessorIdentityFound(P, Input, Output, Config, "sample", "1.0.0"),
            instanceId: "fetcher-1");

        await h.Probe.CheckOnceAsync(TestContext.Current.CancellationToken);

        var asked = Assert.IsType<GetProcessorBySourceHash>(h.Sender.LastBody);
        Assert.Equal("abc123", asked.SourceHash);
        Assert.Equal("fetcher-1", asked.InstanceId);
    }

    /// <summary>
    /// And sends nothing where nothing is configured, which is what leaves every processor already
    /// deployed asking exactly the question it asks today.
    /// </summary>
    [Fact]
    public async Task TheProbeAsksWithoutAnInstanceIdWhenNoneIsConfigured()
    {
        var h = new Harness(new ProcessorIdentityFound(P, Input, Output, Config, "sample", "1.0.0"));

        await h.Probe.CheckOnceAsync(TestContext.Current.CancellationToken);

        var asked = Assert.IsType<GetProcessorBySourceHash>(h.Sender.LastBody);
        Assert.Equal("abc123", asked.SourceHash);
        Assert.Null(asked.InstanceId);
    }

    private sealed class StubReplyEndpoint : IReplyEndpoint
    {
        public string QueueName => "proc-reply-test";

        public Task EnsureStartedAsync(CancellationToken ct) => Task.CompletedTask;
    }

    [Fact]
    public async Task SaysNothingWhenTheRegisteredEdgesStillMatch()
    {
        // The normal state, and it must stay quiet: this loop runs forever on every replica, so a
        // line per interval when nothing is wrong would bury the one that matters.
        var h = new Harness(new ProcessorIdentityFound(P, Input, Output, Config, "sample", "1.0.0"));

        Assert.False(await h.Probe.CheckOnceAsync(TestContext.Current.CancellationToken));
        Assert.DoesNotContain(h.Log.Records, r => r.Level == LogLevel.Warning);
    }

    [Fact]
    public async Task NamesTheRoleAndBothIdsWhenAnEdgeHasMoved()
    {
        // THE CASE THE GAP WAS FILED FOR. On 2026-09-12 both sides of an edge were re-pointed to a
        // tightened schema, the workflow started, and a document violating it completed the chain --
        // because the pods were still enforcing what they had cached and nothing said so.
        var moved = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var h = new Harness(new ProcessorIdentityFound(P, moved, Output, Config, "sample", "1.0.0"));

        Assert.True(await h.Probe.CheckOnceAsync(TestContext.Current.CancellationToken));

        var warning = Assert.Single(h.Log.Records, r => r.Level == LogLevel.Warning);

        // BOTH ids, because neither alone is actionable: one says what the workflow was published
        // against, the other says what this replica is applying.
        Assert.Contains("input", warning.Message, StringComparison.Ordinal);
        Assert.Contains(Input.ToString(), warning.Message, StringComparison.Ordinal);
        Assert.Contains(moved.ToString(), warning.Message, StringComparison.Ordinal);

        // And what applies the change, since this loop deliberately does not.
        Assert.Contains("restart", warning.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReportsEveryEdgeThatMoved()
    {
        // Not just the first: an operator re-pointing a contract moves producer and consumer
        // together, so a report naming one of three would send them back for the others.
        var h = new Harness(new ProcessorIdentityFound(
            P, Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), "sample", "1.0.0"));

        Assert.True(await h.Probe.CheckOnceAsync(TestContext.Current.CancellationToken));
        Assert.Equal(3, h.Log.Records.Count(r => r.Level == LogLevel.Warning));
    }

    [Fact]
    public async Task ReportsARowThatIsNoLongerRegistered()
    {
        // The hash was re-pointed to another row, or the row was deleted. The replica keeps serving
        // on what it has, which is exactly why it is worth a line.
        var h = new Harness(new ProcessorIdentityNotFound("abc123"));

        Assert.True(await h.Probe.CheckOnceAsync(TestContext.Current.CancellationToken));

        var warning = Assert.Single(h.Log.Records, r => r.Level == LogLevel.Warning);
        Assert.Contains("no longer registered", warning.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task StaysSilentWhenTheAskGoesUnanswered()
    {
        // A broker or API problem is NOT drift, and blaming the schemas for a transport fault would
        // make this loop lie during exactly the outage an operator is already chasing.
        var h = new Harness(reply: null);

        Assert.False(await h.Probe.CheckOnceAsync(TestContext.Current.CancellationToken));
        Assert.DoesNotContain(h.Log.Records, r => r.Level == LogLevel.Warning);
        Assert.Equal(1, h.Sender.Sends);
    }
}

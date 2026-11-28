using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

/// <summary>
/// The author's verdict on a step outcome: written by name, with its enum type, on the outcome's own
/// record and no other. See docs/superpowers/specs/2026-11-28-step-outcome-verdict-design.md.
/// </summary>
public sealed class OutcomeVerdictTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid OutSchema = Guid.Parse("88888888-8888-8888-8888-888888888888");

    private enum GateVerdict { Listed, Unlisted }

    [Flags]
    private enum FlagVerdict { A = 1, B = 2 }

    private sealed record NoConfig : ProcessorConfig;

    private sealed class Probe(Func<Probe, Task> body) : BaseProcessor<NoConfig>
    {
        protected override Task ProcessAsync(byte[] data, NoConfig? config, Guid executionId, CancellationToken ct)
            => body(this);

        public Task Send(byte[] d) => SendToPostAsync(d, E, CancellationToken.None);

        public Task Send(byte[] d, Enum verdict) => SendToPostAsync(d, E, verdict, CancellationToken.None);
    }

    private sealed class Harness
    {
        public IDatabase Db { get; } = Substitute.For<IDatabase>();
        public IConnectionMultiplexer Redis { get; } = Substitute.For<IConnectionMultiplexer>();
        public IQueueSender Sender { get; } = Substitute.For<IQueueSender>();
        public ProcessorContext Context { get; } = new();
        public RecordingLogger<ProcessDispatchHandler> Log { get; } = new();
        public RecordingLogger<BranchFinisher> FinisherLog { get; } = new();
        public List<StepOutcome> Outcomes { get; } = [];

        public Harness(string? outputSchema = null)
        {
            Redis.GetDatabase().Returns(Db);
            Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
            Context.SetIdentity(new ProcessorIdentityFound(
                P, null, outputSchema is null ? null : OutSchema, null, "sample", "1.0.0"));
            if (outputSchema is not null)
            {
                Context.SetDefinition(OutSchema, outputSchema);
            }

            Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepOutcome>(Outcomes.Add),
                    Arg.Any<CancellationToken>(), Arg.Any<string?>())
                .Returns(Task.CompletedTask);
        }

        public async Task RunAsync(Probe probe)
        {
            var handler = new ProcessDispatchHandler(
                Redis, Sender, Context, probe, new BranchFinisher(Redis, Sender, Context, FinisherLog), Log);
            var body = JsonSerializer.SerializeToUtf8Bytes(
                new ProcessDispatch(C, Guid.Empty, W, S, P, "", E), MessagingJson.Options);
            await handler.HandleAsync(body, CancellationToken.None);
        }

        /// <summary>Every record of both loggers with the scope that was live when it was written.</summary>
        public IEnumerable<(string Message, IReadOnlyDictionary<string, object> Scope)> AllRecords()
            => Log.Records.Select((r, i) => (r.Message, Log.RecordScopes[i]))
                .Concat(FinisherLog.Records.Select((r, i) => (r.Message, FinisherLog.RecordScopes[i])));
    }

    // ── OutcomeLogScope ────────────────────────────────────────────────────────────────────────

    [Fact]
    public void AScopeWithoutAVerdictCarriesOnlyTheResult()
    {
        var scope = OutcomeLogScope.BuildScope(StepResult.Completed, null);

        Assert.Equal(nameof(StepResult.Completed), Assert.Single(scope).Value);
    }

    [Fact]
    public void AScopeWithAVerdictCarriesItsNameAndItsEnumType()
    {
        var scope = OutcomeLogScope.BuildScope(StepResult.Cancelled, GateVerdict.Unlisted);

        Assert.Equal(3, scope.Count);
        Assert.Equal("Cancelled", scope[OutcomeLogScope.Result]);
        Assert.Equal("Unlisted", scope[OutcomeLogScope.Verdict]);
        Assert.Equal("GateVerdict", scope[OutcomeLogScope.VerdictKind]);
    }

    // ── Author outcomes ────────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task ACancelWithAVerdictPutsItOnTheCancelRecord()
    {
        var h = new Harness();

        await h.RunAsync(new Probe(_ => throw new CancelledException("not on the list", GateVerdict.Unlisted)));

        Assert.Equal(StepResult.Cancelled, Assert.Single(h.Outcomes).Result);
        var (_, scope) = Assert.Single(h.AllRecords(), r => r.Message.Contains("cancelled the branch", StringComparison.Ordinal));
        Assert.Equal("Cancelled", scope[OutcomeLogScope.Result]);
        Assert.Equal("Unlisted", scope[OutcomeLogScope.Verdict]);
        Assert.Equal("GateVerdict", scope[OutcomeLogScope.VerdictKind]);
    }

    [Fact]
    public async Task AFailureWithAVerdictPutsItOnTheFailureRecord()
    {
        var h = new Harness();

        await h.RunAsync(new Probe(_ => throw new FailedException("bad", GateVerdict.Listed)));

        Assert.Equal(StepResult.Failed, Assert.Single(h.Outcomes).Result);
        var (_, scope) = Assert.Single(h.AllRecords(), r => r.Message.Contains("reported the step failed", StringComparison.Ordinal));
        Assert.Equal("Listed", scope[OutcomeLogScope.Verdict]);
        Assert.Equal("GateVerdict", scope[OutcomeLogScope.VerdictKind]);
    }

    [Fact]
    public async Task ACancelWithoutAVerdictCarriesNone()
    {
        var h = new Harness();

        await h.RunAsync(new Probe(_ => throw new CancelledException("no artist")));

        Assert.DoesNotContain(h.AllRecords(), r => r.Scope.ContainsKey(OutcomeLogScope.Verdict)
                                                  || r.Scope.ContainsKey(OutcomeLogScope.VerdictKind));
    }

    [Fact]
    public async Task AnUndefinedVerdictOnAnExceptionKeepsTheOutcomeAndDropsTheVerdict()
    {
        var h = new Harness();

        await h.RunAsync(new Probe(_ => throw new CancelledException("x", (GateVerdict)7)));

        Assert.Equal(StepResult.Cancelled, Assert.Single(h.Outcomes).Result);
        Assert.DoesNotContain(h.AllRecords(), r => r.Scope.ContainsKey(OutcomeLogScope.Verdict));
        Assert.Contains(h.Log.Records, r => r.Level == LogLevel.Warning
                                            && r.Message.Contains("not a defined member of GateVerdict", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AFlagsCombinationIsNotADefinedVerdict()
    {
        var h = new Harness();

        await h.RunAsync(new Probe(_ => throw new CancelledException("x", FlagVerdict.A | FlagVerdict.B)));

        Assert.DoesNotContain(h.AllRecords(), r => r.Scope.ContainsKey(OutcomeLogScope.Verdict));
    }

    // ── Completed branches ─────────────────────────────────────────────────────────────────────

    [Fact]
    public async Task ACompletedBranchWithAVerdictPutsItOnTheCompletedRecordOnly()
    {
        var h = new Harness();

        await h.RunAsync(new Probe(p => p.Send(Encoding.UTF8.GetBytes("{}"), GateVerdict.Listed)));

        Assert.Equal(StepResult.Completed, Assert.Single(h.Outcomes).Result);
        var withVerdict = Assert.Single(h.AllRecords(), r => r.Scope.ContainsKey(OutcomeLogScope.Verdict));
        Assert.Contains("branch completed", withVerdict.Message, StringComparison.Ordinal);
        Assert.Equal("Completed", withVerdict.Scope[OutcomeLogScope.Result]);
        Assert.Equal("Listed", withVerdict.Scope[OutcomeLogScope.Verdict]);
        Assert.Equal("GateVerdict", withVerdict.Scope[OutcomeLogScope.VerdictKind]);
    }

    [Fact]
    public async Task EachBranchOfAFanOutCarriesItsOwnVerdict()
    {
        var h = new Harness();
        var sink = new SenderBranchSink(h.Sender);
        var probe = new Probe(async p =>
        {
            await p.Send(Encoding.UTF8.GetBytes("{}"), GateVerdict.Listed);
            await p.Send(Encoding.UTF8.GetBytes("{}"));
        });
        probe.BeginDispatch(new DispatchState(sink, E, C, W, S, P));

        await probe.ExecuteAsync([], "", E, CancellationToken.None);

        Assert.Equal([GateVerdict.Listed, null], sink.Verdicts);
    }

    [Fact]
    public async Task ACompletedBranchWithoutAVerdictCarriesNone()
    {
        var h = new Harness();

        await h.RunAsync(new Probe(p => p.Send(Encoding.UTF8.GetBytes("{}"))));

        Assert.DoesNotContain(h.AllRecords(), r => r.Scope.ContainsKey(OutcomeLogScope.Verdict));
    }

    [Fact]
    public async Task AnUndefinedVerdictOnASendFailsTheStepWithoutAVerdict()
    {
        var h = new Harness();

        await h.RunAsync(new Probe(p => p.Send(Encoding.UTF8.GetBytes("{}"), (GateVerdict)7)));

        Assert.Equal(StepResult.Failed, Assert.Single(h.Outcomes).Result);
        Assert.DoesNotContain(h.AllRecords(), r => r.Scope.ContainsKey(OutcomeLogScope.Verdict));
    }

    [Fact]
    public async Task ABranchThatFailsItsOutputSchemaDropsTheVerdict()
    {
        var h = new Harness("""{"type":"object","required":["number"]}""");

        await h.RunAsync(new Probe(p => p.Send(Encoding.UTF8.GetBytes("{}"), GateVerdict.Listed)));

        Assert.Equal(StepResult.Failed, Assert.Single(h.Outcomes).Result);
        Assert.DoesNotContain(h.AllRecords(), r => r.Scope.ContainsKey(OutcomeLogScope.Verdict));
    }

    // ── Framework-detected failures ────────────────────────────────────────────────────────────

    [Fact]
    public async Task AFaultedTransformCarriesNoVerdict()
    {
        var h = new Harness();

        await h.RunAsync(new Probe(_ => throw new InvalidOperationException("bug")));

        Assert.Equal(StepResult.Failed, Assert.Single(h.Outcomes).Result);
        Assert.DoesNotContain(h.AllRecords(), r => r.Scope.ContainsKey(OutcomeLogScope.Verdict));
    }

    [Fact]
    public async Task TheVerdictDoesNotLeakOntoLaterRecordsOfTheDispatch()
    {
        var h = new Harness();

        await h.RunAsync(new Probe(_ => throw new CancelledException("x", GateVerdict.Unlisted)));

        // Exactly one record — the cancel — carries it; "the step returned after" and the rest do not.
        Assert.Single(h.AllRecords(), r => r.Scope.ContainsKey(OutcomeLogScope.Verdict));
    }
}

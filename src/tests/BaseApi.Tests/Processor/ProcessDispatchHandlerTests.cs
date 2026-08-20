using System.Text;
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Processing;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessDispatchHandlerTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private sealed record NoConfig : ProcessorConfig;

    private sealed class Probe(Func<byte[], Probe, Task> body) : BaseProcessor<NoConfig>
    {
        public bool Ran { get; private set; }
        public byte[]? SawData { get; private set; }

        protected override Task ProcessAsync(byte[] data, NoConfig? config, Guid executionId, CancellationToken ct)
        {
            Ran = true;
            SawData = data;
            return body(data, this);
        }

        public Task Send(byte[] d) => SendToPostAsync(d, E, CancellationToken.None);
    }

    private sealed class Harness
    {
        public IDatabase Db { get; } = Substitute.For<IDatabase>();
        public IConnectionMultiplexer Redis { get; }
        public IQueueSender Sender { get; } = Substitute.For<IQueueSender>();
        public ProcessorContext Context { get; } = new();
        public RecordingLogger<ProcessDispatchHandler> Log { get; } = new();

        public Harness(string? inputSchema = null)
        {
            Redis = Substitute.For<IConnectionMultiplexer>();
            Redis.GetDatabase().Returns(Db);
            Context.SetIdentity(new ProcessorIdentityFound(P, null, null, null, "sample", "1.0.0"));
            if (inputSchema is not null)
            {
                // Give the identity an input schema id, then resolve it, so TryValidate has a definition.
                Context.SetIdentity(new ProcessorIdentityFound(
                    P, Guid.Parse("88888888-8888-8888-8888-888888888888"), null, null, "sample", "1.0.0"));
                Context.SetDefinition(Guid.Parse("88888888-8888-8888-8888-888888888888"), inputSchema);
            }
        }

        // Fully qualified: the bare simple name "BaseProcessor" resolves to the namespace segment
        // shared by every type in BaseProcessor.Core.*, which is visible in this file without a
        // using directive and outranks the class of the same name pulled in by "using
        // BaseProcessor.Core.Processing;" — CS0118 otherwise. The generic form BaseProcessor<T> used
        // elsewhere in this test suite is unaffected because arity disambiguates it.
        public ProcessDispatchHandler Build(BaseProcessor.Core.Processing.BaseProcessor processor)
            => new(Redis, Sender, Context, processor, Log);
    }

    private static byte[] Body(ProcessDispatch d)
        => JsonSerializer.SerializeToUtf8Bytes(d, MessagingJson.Options);

    private static ProcessDispatch Dispatch(Guid entryId) =>
        new(W, S, P) { CorrelationId = C, ExecutionId = Guid.Empty, EntryId = entryId, Payload = "" };

    [Fact]
    public async Task RunsTheTransformOnTheDataItReadFromTheStore()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"""{"number":7}""");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.True(probe.Ran);
        Assert.Equal("""{"number":7}""", Encoding.UTF8.GetString(probe.SawData!));
    }

    [Fact]
    public async Task ReturnsWithoutAResultWhenTheEntryIsAlreadyGone()
    {
        // An earlier attempt at this dispatch already ran its author to completion and reclaimed the
        // input, so this step already completed and this is a duplicate delivery. Emitting a failure
        // here would corrupt a finished workflow.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns(RedisValue.Null);
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.False(probe.Ran);
        await h.Sender.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<object>(),
                                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task RunsASourceStepWithEmptyDataWithoutReadingTheStore()
    {
        var h = new Harness();
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(Guid.Empty)), CancellationToken.None);

        Assert.True(probe.Ran);
        Assert.Empty(probe.SawData!);
        await h.Db.DidNotReceive().StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ReclaimsTheInputOnceTheAuthorReturns()
    {
        // The input is finished with only when the author's transform has returned normally, which
        // means every branch it wanted to send was sent.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        await h.Db.Received(1).KeyDeleteAsync(L2ProjectionKeys.ExecutionData(E), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LeavesTheInputAloneWhenTheAuthorThrows()
    {
        // A failed step's input must survive: the orchestrator decides whether to reclaim it, and a
        // reclaim here would destroy the only copy while reporting a business outcome.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, _) => throw new FailedException("author said no"));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LeavesTheInputAloneWhenTheInputFailsItsSchema()
    {
        // The author never ran, so the dispatch may yet be re-run against this input.
        var h = new Harness("""{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""");
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"""{"number":"seven"}""");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.False(probe.Ran);
        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ReclaimsNothingForASourceStepButStillRunsTheAuthor()
    {
        // A source step produces its own input, so there is no key — but it is a normal run in every
        // other respect.
        var h = new Harness();
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(Guid.Empty)), CancellationToken.None);

        Assert.True(probe.Ran);
        await h.Db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task LetsAFailedReclaimEscapeRatherThanReportingAFailedStep()
    {
        // The reclaim sits OUTSIDE the catch chain on purpose. Inside it, a Redis fault would be
        // caught by the general catch and reported as StepFailed — a business outcome that never
        // happened, with the delivery acknowledged. Escaping lets the L2 classifier trip the gate and
        // requeue, and the replay is harmless: the same author runs again and sends the same derived
        // message ids, so the post handler rewrites identical bytes.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        h.Db.KeyDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));
        var probe = new Probe((_, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None));

        Assert.Empty(h.Sender.ReceivedCalls());
    }

    [Fact]
    public async Task LetsAStoreFaultEscapeSoTheDeliveryIsRequeued()
    {
        // Swallowing this would acknowledge a step that never ran.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E))
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));
        var probe = new Probe((_, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None));
    }

    [Fact]
    public async Task ReportsAnInputThatFailsItsSchema()
    {
        var h = new Harness("""{"type":"object","properties":{"number":{"type":"integer"}},"required":["number"]}""");
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"""{"number":"seven"}""");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.False(probe.Ran);
        Assert.NotNull(sent);
        Assert.Equal(Guid.Empty, sent!.EntryId);
    }

    [Fact]
    public async Task ParksADispatchWhoseInputSchemaHasNotResolvedRatherThanRunningUnvalidated()
    {
        // A non-null schema id with a null definition is ProcessorIdentity's "not yet" — Loop B is
        // still fetching. TryValidate(null, ...) returns true by contract, so without this guard the
        // step would run with the input schema silently not applied and nothing logged to say so.
        // A silently skipped security control is worse than a loud failure, and parking is
        // recoverable by hand from the DLQ.
        var h = new Harness();
        h.Context.SetIdentity(new ProcessorIdentityFound(
            P, Guid.Parse("88888888-8888-8888-8888-888888888888"), null, null, "sample", "1.0.0"));
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None));

        // The point of the guard: the author's code must not have run.
        Assert.False(probe.Ran);
        await h.Sender.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<object>(),
                                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task RunsAStepThatSimplyHasNoInputSchema()
    {
        // The other half of the pair ProcessorIdentity's doc names: a NULL schema id means the role
        // does not apply — a source processor, or any step whose input is unconstrained. That must
        // still run and skip validation, or the guard above would refuse work that was never wrong.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"not json at all");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        // Bytes that no schema would accept still reach the author, which is what "skips validation"
        // means here.
        Assert.True(probe.Ran);
        Assert.Equal("not json at all", Encoding.UTF8.GetString(probe.SawData!));
    }

    [Fact]
    public async Task PutsAnAuthorsFailureMessageOnTheWireVerbatim()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => throw new FailedException("order total below minimum"));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.Equal("order total below minimum", sent!.ErrorMessage);
    }

    [Fact]
    public async Task NeverPutsAFrameworkCaughtExceptionMessageOnTheWire()
    {
        // A deserialize failure quotes the offending payload fragment in its message. Sending that
        // would leak payload content into the orchestrator's projections.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => throw new InvalidOperationException("secret-token-abc123"));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.DoesNotContain("secret-token-abc123", sent!.ErrorMessage, StringComparison.Ordinal);
        Assert.NotEmpty(sent.ErrorMessage);
    }

    [Fact]
    public async Task ReportsAnAuthorsCancellation()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepCancelled? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepCancelled>(c => sent = c),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => throw new CancelledException("below threshold"));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.Equal("below threshold", sent!.CancellationMessage);
    }

    [Fact]
    public async Task ReportsAStepFailedWhenTheAuthorsOwnCodeCancels()
    {
        // The consumer passes CancellationToken.None, so ct is never cancelled in production — which
        // means a TaskCanceledException reaching here can only have come from the author's code. The
        // ordinary source is HttpClient, which surfaces a request timeout as exactly this type. A
        // filter that excluded every OperationCanceledException would PARK the dispatch: no StepFailed
        // to the orchestrator, no retry, a message out of circulation until someone recovers it by
        // hand — for the single commonest transient fault an author will hit.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => throw new TaskCanceledException("the request timed out"));

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        Assert.NotNull(sent);
        Assert.Equal(P, sent!.ProcessorId);
        Assert.NotEmpty(sent.ErrorMessage);
    }

    [Fact]
    public async Task LetsAShutdownCancellationEscapeRatherThanReportingTheStepFailed()
    {
        // The other half of the same filter. When ct IS cancelled the process is stopping, the step's
        // outcome is genuinely unknown, and reporting a business failure would record an outcome that
        // never happened. Letting it escape leaves the delivery unacknowledged.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var probe = new Probe((_, _) => throw new OperationCanceledException(cts.Token));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => h.Build(probe).HandleAsync(Body(Dispatch(E)), cts.Token));

        await h.Sender.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<object>(),
                                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task SendsNothingWhenTheAuthorEndsTheBranchSilently()
    {
        // A sink or a filter legitimately ends here with nothing to report.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        var probe = new Probe((_, _) => Task.CompletedTask);

        await h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        await h.Sender.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<object>(),
                                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
    }

    [Fact]
    public async Task LetsAFailedBranchSendEscapeRatherThanReportingTheStepFailed()
    {
        // Reporting failure here would acknowledge the dispatch, and the branch would never be sent.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<ProcessedData>(),
                           Arg.Any<CancellationToken>(), Arg.Any<string?>())
                .ThrowsAsync(new IOException("socket closed"));
        var probe = new Probe((_, self) => self.Send(Encoding.UTF8.GetBytes("{}")));

        await Assert.ThrowsAsync<PostSendException>(
            () => h.Build(probe).HandleAsync(Body(Dispatch(E)), CancellationToken.None));
    }

    [Fact]
    public async Task StampsOurOwnProcessorIdOnResultsEvenWhenTheDispatchClaimsAnother()
    {
        // The branch path is covered below; this covers the OTHER four outbound sites. A result that
        // echoed the inbound id would misattribute a failure to whichever processor a corrupt or
        // misrouted dispatch happened to name — and unlike the branch path, nothing downstream would
        // notice, because a StepFailed carries no key anyone later reads.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        StepFailed? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<StepFailed>(f => sent = f),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, _) => throw new FailedException("nope"));

        var foreign = Dispatch(E) with { ProcessorId = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd") };
        await h.Build(probe).HandleAsync(Body(foreign), CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Fact]
    public async Task StampsOurOwnProcessorIdOnBranchesEvenWhenTheDispatchClaimsAnother()
    {
        // The dispatch was addressed to OUR queue, so we are the processor it names. Echoing its
        // ProcessorId field back would be the only way the two could ever disagree — and a branch
        // stamped with someone else's id writes into their lineage. This is what makes a provenance
        // guard unnecessary: the mismatch is unrepresentable rather than checked for.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"{}");
        ProcessedData? sent = null;
        await h.Sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(p => sent = p),
                                 Arg.Any<CancellationToken>(), Arg.Any<string?>());
        var probe = new Probe((_, self) => self.Send(Encoding.UTF8.GetBytes("{}")));

        var foreign = Dispatch(E) with { ProcessorId = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd") };
        await h.Build(probe).HandleAsync(Body(foreign), CancellationToken.None);

        Assert.Equal(P, sent!.ProcessorId);
    }

    [Fact]
    public async Task ThrowsOnABodyItCannotRead()
    {
        // Above the deserialization boundary there are no ids to report with, so throwing is correct:
        // the consumer parks it and the bytes survive for inspection.
        var h = new Harness();
        var probe = new Probe((_, _) => Task.CompletedTask);

        await Assert.ThrowsAnyAsync<Exception>(
            () => h.Build(probe).HandleAsync(Encoding.UTF8.GetBytes("not json"), CancellationToken.None));
    }

    [Fact]
    public async Task PutsEveryPopulatedIdOnEveryRecordItEmits()
    {
        // The ids are never in a message template — they arrive as scope values, which the OTel bridge
        // turns into attributes. One scope at the top of the handler is what makes that true for
        // framework records and for anything the author logs inside the transform.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns(RedisValue.Null);

        await h.Build(new Probe((_, _) => Task.CompletedTask))
               .HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        var ids = h.Log.Scopes.SelectMany(s => s).ToDictionary(p => p.Key, p => p.Value);
        Assert.Equal(W.ToString("D"), ids[ExecutionLogScope.WorkflowId]);
        Assert.Equal(S.ToString("D"), ids[ExecutionLogScope.StepId]);
        Assert.Equal(P.ToString("D"), ids[ExecutionLogScope.ProcessorId]);
        Assert.Equal(E.ToString("D"), ids[ExecutionLogScope.EntryId]);
    }

    [Fact]
    public async Task RendersTheCorrelationIdTheWayTheHttpMiddlewareDoes()
    {
        // Two spellings of one id land on one Elasticsearch field, and the query joining an HTTP
        // request to its bus work silently returns nothing.
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns(RedisValue.Null);

        await h.Build(new Probe((_, _) => Task.CompletedTask))
               .HandleAsync(Body(Dispatch(E)), CancellationToken.None);

        var ids = h.Log.Scopes.SelectMany(s => s).ToDictionary(p => p.Key, p => p.Value);
        Assert.Equal(C.ToString("N"), ids[CorrelationKeys.LogScope]);
    }

    [Fact]
    public async Task OmitsAnIdThatDoesNotApplyRatherThanZeroingIt()
    {
        // A source step has no entry id and an entry dispatch has no execution id. All-zeros would be
        // indistinguishable from a real id that happens to be empty.
        var h = new Harness();

        await h.Build(new Probe((_, _) => Task.CompletedTask))
               .HandleAsync(Body(Dispatch(Guid.Empty)), CancellationToken.None);

        var ids = h.Log.Scopes.SelectMany(s => s).ToDictionary(p => p.Key, p => p.Value);
        Assert.False(ids.ContainsKey(ExecutionLogScope.EntryId));
        Assert.False(ids.ContainsKey(ExecutionLogScope.ExecutionId));
    }

    [Fact]
    public async Task NeverPutsDataOrConfigInALogMessage()
    {
        var h = new Harness();
        h.Db.StringGetAsync(L2ProjectionKeys.ExecutionData(E)).Returns((RedisValue)"""{"secret":"topsecret"}""");
        var dispatch = Dispatch(E) with { Payload = """{"Token":"payload-secret"}""" };

        await h.Build(new Probe((_, _) => throw new InvalidOperationException("boom")))
               .HandleAsync(Body(dispatch), CancellationToken.None);

        Assert.DoesNotContain(h.Log.Records, r => r.Message.Contains("topsecret", StringComparison.Ordinal));
        Assert.DoesNotContain(h.Log.Records, r => r.Message.Contains("payload-secret", StringComparison.Ordinal));
    }
}

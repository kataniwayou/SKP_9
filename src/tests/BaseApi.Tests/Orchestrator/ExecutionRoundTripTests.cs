using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseConsole.Core.Naming;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Orchestrator.L1;
using Orchestrator.Messaging;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The execution path end to end: a step's outcome in, the next step's dispatch out, with the real
/// handlers on a real (in-memory) L2 and a bus that records what each hop sent.
/// <para>
/// <b>Driven by routing rather than by calling the next handler directly.</b> The point of the two
/// hops is that they are separate deliveries; a test that hands one handler's return value to the
/// other would prove the pair works while assuming away the queue between them. <see cref="Bus"/>
/// captures what was sent and to where, and <c>Drain</c> feeds it back through the handler
/// registered for that type — the same dispatch the gated consumer performs.
/// </para>
/// </summary>
public sealed class ExecutionRoundTripTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid A = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid B = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    private static readonly Guid C = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");
    private static readonly Guid PA = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid PB = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid PC = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid Corr = Guid.Parse("66666666-6666-6666-6666-666666666666");
    private static readonly Guid Exec = Guid.Parse("77777777-7777-7777-7777-777777777777");
    private static readonly Guid Entry = Guid.Parse("88888888-8888-8888-8888-888888888888");

    private const string Output = """{"number":42}""";

    /// <summary>Records every send, and can be told to fault one message type.</summary>
    private sealed class Bus : IQueueSender
    {
        public List<(string Queue, string Type, object Body)> Sent { get; } = [];
        public Func<string, Exception?>? FaultOn { get; set; }

        public Task SendAsync<T>(
            string queue, string type, T body, CancellationToken ct,
            string? replyTo = null, string? correlationId = null)
        {
            if (FaultOn?.Invoke(type) is { } ex)
            {
                return Task.FromException(ex);
            }

            Sent.Add((queue, type, body!));
            return Task.CompletedTask;
        }

        public IEnumerable<T> OfType<T>(string type) =>
            Sent.Where(s => s.Type == type).Select(s => (T)s.Body);
    }

    private sealed class Harness
    {
        public InMemoryL2 L2 { get; } = new();
        public Bus Bus { get; } = new();
        public WorkflowL1Store Store { get; } = new();
        public RecordingLogger<StepOutcomeHandler> PreLog { get; } = new();
        public RecordingLogger<NextStepHandoffHandler> PostLog { get; } = new();

        public Harness(params StepL1[] steps)
        {
            Store.Set(W, new WorkflowL1(W, [A], "* * * * *", [.. steps], []), Guid.NewGuid());
        }

        public IQueueMessageHandler Pre => new StepOutcomeHandler(Store, L2.Multiplexer, Bus, PreLog);

        /// <summary>
        /// The flattened scope of the one record matching <paramref name="template"/>, or null if none
        /// did. Keyed on the template because that is what reaches attributes.{OriginalFormat}, which
        /// is what every reader of these records selects on.
        /// </summary>
        public IReadOnlyDictionary<string, object>? ScopeOf(string template)
        {
            for (var i = 0; i < PreLog.Records.Count; i++)
            {
                if (PreLog.Templates[i] == template)
                {
                    return PreLog.RecordScopes[i];
                }
            }

            return null;
        }
        public IQueueMessageHandler Post => new NextStepHandoffHandler(L2.Multiplexer, Bus, PostLog);

        /// <summary>Feeds one message into the handler registered for its type, as the consumer does.</summary>
        public Task Deliver(string type, object body)
        {
            var handler = type == MessageTypes.StepOutcome ? Pre
                        : type == MessageTypes.NextStepHandoff ? Post
                        : throw new InvalidOperationException($"nothing consumes {type} in this harness");

            return handler.HandleAsync(JsonSerializer.SerializeToUtf8Bytes(body, MessagingJson.Options),
                                       CancellationToken.None);
        }

        /// <summary>
        /// Runs every message the orchestrator has queued for itself until none are left, so a test
        /// can assert on the far end of the loop. Dispatches to a processor queue are the exit — they
        /// stay in <see cref="Bus.Sent"/> and are not fed back.
        /// </summary>
        public async Task Drain()
        {
            for (var i = 0; i < Bus.Sent.Count; i++)
            {
                var (queue, type, body) = Bus.Sent[i];
                if (queue == OrchestratorQueues.ResultPost)
                {
                    await Deliver(type, body);
                }
            }
        }
    }

    /// <summary>
    /// <c>StepEntryCondition.Always</c> as the int the projection carries, matching the constant
    /// <c>StepAdvancement</c> keeps for the same reason: a successor wired this way is dispatched
    /// whatever its predecessor reported, including Failed.
    /// </summary>
    private const int Always = 4;

    private static StepL1 Step(Guid id, Guid processor, int condition, string payload, params Guid[] next) =>
        new(id, condition, processor, payload, [.. next]);

    private static StepOutcome Outcome(StepResult result, Guid entryId) =>
        new(Corr, Exec, W, A, PA, entryId, result);

    private static void Seed(Harness h, Guid entryId, string value) =>
        h.L2.Db.StringSetAsync(L2ProjectionKeys.ExecutionData(entryId), value).Wait();

    /// <summary>
    /// The orchestrator's terminal template, escaped rather than spelled: it carries U+2014, and a
    /// constant whose correctness depends on this file's encoding surviving every tool that touches it
    /// is a constant that silently matches nothing. Same reasoning as Live/Resilience/Templates.
    /// </summary>
    private const string TerminalTemplate =
        "the terminal step completed with {Result} \u2014 no successor accepts it, the run ends here";


    // ---------------------------------------------------------------- the round trip

    [Fact]
    public async Task AStepsOutputBecomesTheNextStepsInput()
    {
        // A completes, B is gated on completion. One trip through both hops has to leave B dispatched,
        // reading a key that holds A's bytes, with A's key gone.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, """{"n":2}"""));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));
        await h.Drain();

        var sent = h.Bus.Sent.Single(s => s.Type == MessageTypes.ProcessDispatch);
        var dispatch = (ProcessDispatch)sent.Body;

        // Addressed to B's processor, by its own queue name.
        Assert.Equal(ProcessorQueues.Work(PB), sent.Queue);
        Assert.Equal(PB, dispatch.ProcessorId);
        Assert.Equal(B, dispatch.StepId);

        // B's payload, from B's L1 entry — not A's.
        Assert.Equal("""{"n":2}""", dispatch.Payload);

        // Threaded unchanged: the run and the lineage survive the hand-off.
        Assert.Equal(Corr, dispatch.CorrelationId);
        Assert.Equal(Exec, dispatch.ExecutionId);
        Assert.Equal(W, dispatch.WorkflowId);

        // The key B was pointed at holds A's output, byte for byte.
        Assert.Equal(Output, h.L2.Value(L2ProjectionKeys.ExecutionData(dispatch.EntryId)));

        // A relocated key, not the same one: A's is reclaimed.
        Assert.NotEqual(Entry, dispatch.EntryId);
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task EachSuccessorOfAFanOutGetsItsOwnCopyUnderItsOwnKey()
    {
        // The hazard both processor handlers document and refuse to defend against: three successors
        // against one key means the first one's pre hop reclaims it and the rest find it absent. This
        // is the orchestrator doing the job they name — copy per successor, then reclaim the source.
        var h = new Harness(
            Step(A, PA, 1, "{}", B, C), Step(B, PB, 1, "{}"), Step(C, PC, 4, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));
        await h.Drain();

        var dispatches = h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).ToList();
        Assert.Equal(2, dispatches.Count);

        // Distinct keys, so neither successor's reclaim can starve the other.
        var keys = dispatches.Select(d => d.EntryId).ToList();
        Assert.Equal(2, keys.Distinct().Count());

        // Both holding the same bytes A produced.
        Assert.All(keys, k => Assert.Equal(Output, h.L2.Value(L2ProjectionKeys.ExecutionData(k))));

        // And the source is gone, exactly once.
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task AFailedStepsSuccessorReceivesNoDataAndTheInputIsReclaimed()
    {
        // Spec D6: a Failed outcome's EntryId is only something to clean up. The failure branch runs
        // as a source step on empty data, and the failed step's input is still reclaimed.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 2, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Entry));
        await h.Drain();

        var dispatch = h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Single();
        Assert.Equal(B, dispatch.StepId);
        Assert.Equal(Guid.Empty, dispatch.EntryId);
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
        Assert.Empty(h.L2.Keys());
    }

    [Theory]
    [InlineData(StepResult.Failed)]
    [InlineData(StepResult.Cancelled)]
    public async Task AFailedOrCancelledOutcomeNeverReadsTheBlob(StepResult result)
    {
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, Always, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(result, Entry));

        await h.L2.Db.DidNotReceive().StringGetAsync(
            (RedisKey)L2ProjectionKeys.ExecutionData(Entry), Arg.Any<CommandFlags>());
        await h.L2.Db.Received(1).KeyExistsAsync(
            (RedisKey)L2ProjectionKeys.ExecutionData(Entry), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ADuplicateFailedOutcomeAdvancesNothing()
    {
        // The existence check is the guard. The first delivery reclaimed the key, so this one finds
        // it absent and does nothing, exactly as the read-based guard did.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 2, "{}"));

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Entry));
        await h.Drain();

        Assert.Empty(h.Bus.Sent);
        Assert.Contains(h.PreLog.Records,
            e => e.Level == LogLevel.Warning && e.Message.Contains("duplicate delivery", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AFailedOutcomeWhoseHandOffFailsKeepsItsKeyForTheReplay()
    {
        // Review focus 4, and the reason DEL is last rather than the guard: if DEL ran first, this
        // redelivery would find the key gone and the failure branch would never be dispatched.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 2, "{}"));
        Seed(h, Entry, Output);
        h.Bus.FaultOn = t => t == MessageTypes.NextStepHandoff
            ? new TransientSendException("broker blip", new IOException("reset"))
            : null;

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Entry)));
        Assert.True(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));

        h.Bus.FaultOn = null;
        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Entry));
        await h.Drain();

        Assert.Single(h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch));
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task ACompletedOutcomeWithNoKeyEndsATerminalStep()
    {
        // The exporter's no-data branch: Completed naming Guid.Empty on a step with no successor.
        var h = new Harness(Step(A, PA, 1, "{}"));

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Guid.Empty));

        Assert.Empty(h.Bus.Sent);
        Assert.NotNull(h.ScopeOf(TerminalTemplate));
    }

    [Fact]
    public async Task AnOutcomeWithNoBlobDispatchesItsSuccessorAsASourceStep()
    {
        // Guid.Empty is not a key. It arrives from a failed source step and from an output that failed
        // its schema, and it has to travel all the way through as the sentinel the processor already
        // reads as "no upstream input" — not become a zero-length blob under a minted key.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 4, "{}"));

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Guid.Empty));
        await h.Drain();

        var dispatch = h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Single();
        Assert.Equal(Guid.Empty, dispatch.EntryId);
        Assert.Empty(h.L2.Keys());
    }

    // ---------------------------------------------------------------- the pre hop

    [Fact]
    public async Task ATerminalStepReclaimsItsOutputInsteadOfLeavingIt()
    {
        // The measured bug this ordering exists to prevent: the terminal and no-match paths return
        // before the reclaim, so the store fills with one orphan per terminal step of every run. With
        // no TTL and no sweeper on data: keys, those orphans are permanent.
        var h = new Harness(Step(A, PA, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Empty(h.Bus.Sent);
        Assert.Empty(h.L2.Keys());
    }

    [Fact]
    public async Task ASuccessorWhoseConditionDoesNotMatchAlsoReclaims()
    {
        // Same rule on the other business-final path: the branch halts because nothing accepts the
        // outcome, and the blob is still this hop's to clean up.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 2, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Empty(h.Bus.Sent);
        Assert.Empty(h.L2.Keys());
    }

    [Fact]
    public async Task AnOutcomeForAWorkflowThisReplicaDoesNotHoldIsRefused()
    {
        // The "never held it" reading of an L1 miss -- an outcome naming a workflow this replica has
        // no record of at all. The "held it and lost it" reading, which is the common one, is
        // covered separately by the stopped-mid-flight test below.
        var h = new Harness(Step(A, PA, 1, "{}"));
        Seed(h, Entry, Output);

        var foreign = new StepOutcome(
            Corr, Exec, Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd"), A, PA, Entry,
            StepResult.Completed);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Deliver(MessageTypes.StepOutcome, foreign));

        // THE BLOB IS RECLAIMED ON THE WAY OUT, and this assertion is the reverse of what it used to
        // be. A park is a nack with requeue:false: the message leaves for the dead-letter exchange
        // and never comes back, so a blob left behind here is orphaned exactly as an acked one would
        // be -- data: keys carry no TTL and no sweeper covers them.
        //
        // The cost of the reversal is that this dead-lettered message now names a key that no longer
        // exists, so it can no longer be replayed by hand. That is deliberate: the execution is over
        // either way, the next scheduled fire will meet the same condition and park again, and the
        // difference is only whether the store grows every time it does.
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task AnOutcomeNamingABlobTheStoreDoesNotHoldIsAcked()
    {
        // INVERTED on 2026-09-01, not deleted: it pinned the opposite disposition and is the reason
        // the change could not be made silently. It read "this hop cannot tell that from a step
        // reporting a key it never produced" -- and it can, by elimination. ProcessedDataHandler
        // writes before it sends and sends Guid.Empty when it did not write; the L1 miss above
        // already parked anything naming an unknown workflow or step; and the only other deleters of
        // this key touch a different guid or run where no outcome was ever sent. So the key was
        // written, and this handler's own reclaim is what removed it.
        // See docs/superpowers/specs/2026-09-01-absent-key-disposition-design.md.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));

        var ex = await Record.ExceptionAsync(
            () => h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry)));

        Assert.Null(ex);
        Assert.Empty(h.Bus.Sent);
    }

    [Fact]
    public async Task ADanglingSuccessorIsLoggedWithoutCostingItsSiblings()
    {
        // Throwing here would park an outcome whose other successors were already handed off — the
        // workflow would advance down one branch and be parked for the rest, with the reclaim skipped.
        var h = new Harness(Step(A, PA, 1, "{}", B, C), Step(C, PC, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));
        await h.Drain();

        Assert.Equal(C, h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Single().StepId);
        Assert.Contains(h.PreLog.Records, r => r.Message.Contains("is not in this workflow's step set"));
        Assert.False(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task AFailedHandOffLeavesTheSourceBlobForTheReplay()
    {
        // The reclaim is last precisely so this holds: the send faults, the delivery goes back, and the
        // replay finds the blob it needs to re-send every hand-off still there.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);
        h.Bus.FaultOn = t => t == MessageTypes.NextStepHandoff ? new IOException("socket closed") : null;

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry)));

        Assert.True(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task AStoreFaultOnTheReadEscapesSoTheGateCanTrip()
    {
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        h.L2.Db.StringGetAsync(Arg.Any<RedisKey>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry)));
    }

    // ---------------------------------------------------------------- the post hop

    [Fact]
    public async Task TheInputKeyIsWrittenBeforeTheStepIsDispatched()
    {
        // Reversed, the processor's pre handler could read an absent key, take its duplicate-delivery
        // branch and return — a step that silently never runs rather than a retryable race.
        var h = new Harness(Step(B, PB, 1, "{}"));
        var written = false;
        h.Bus.FaultOn = _ =>
        {
            written = h.L2.Has(L2ProjectionKeys.ExecutionData(Entry));
            return null;
        };

        await h.Deliver(MessageTypes.NextStepHandoff, new NextStepHandoff(
            Corr, Exec, W, B, PB, "{}", Entry, Encoding.UTF8.GetBytes(Output)));

        Assert.True(written);
    }

    [Fact]
    public async Task ADeterministicDispatchFailureReportsTheStepFailedNamingTheKeyToReclaim()
    {
        // Parking would stall the workflow at a step that never started, with nothing downstream
        // waiting on it. Reporting it runs the graph's own failure branch — and naming the key just
        // written is what stops that blob being orphaned.
        var h = new Harness(Step(B, PB, 1, "{}"));
        h.Bus.FaultOn = t =>
            t == MessageTypes.ProcessDispatch ? new NotSupportedException("no converter") : null;

        await h.Deliver(MessageTypes.NextStepHandoff, new NextStepHandoff(
            Corr, Exec, W, B, PB, "{}", Entry, Encoding.UTF8.GetBytes(Output)));

        var outcome = h.Bus.OfType<StepOutcome>(MessageTypes.StepOutcome).Single();
        Assert.Equal(StepResult.Failed, outcome.Result);
        Assert.Equal(B, outcome.StepId);
        Assert.Equal(PB, outcome.ProcessorId);
        Assert.Equal(Entry, outcome.EntryId);
        Assert.Equal(Corr, outcome.CorrelationId);
    }

    [Fact]
    public async Task ATransientDispatchFailureIsRequeuedRatherThanReported()
    {
        // The direction that matters: a broker blip must not be recorded as a business failure, which
        // would mark a step failed that a redelivery would have started.
        var h = new Harness(Step(B, PB, 1, "{}"));
        h.Bus.FaultOn = t =>
            t == MessageTypes.ProcessDispatch ? new IOException("socket closed") : null;

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Deliver(MessageTypes.NextStepHandoff, new NextStepHandoff(
                Corr, Exec, W, B, PB, "{}", Entry, Encoding.UTF8.GetBytes(Output))));

        Assert.Empty(h.Bus.OfType<StepOutcome>(MessageTypes.StepOutcome));
    }

    [Fact]
    public async Task AReplayedHandOffRewritesTheSameKeyWithTheSameBytes()
    {
        // The entry id rides the body, so a redelivery of this message repeats the write rather than
        // minting a second key. That is what lets this hop use a plain NACK as its whole recovery.
        var h = new Harness(Step(B, PB, 1, "{}"));
        var handoff = new NextStepHandoff(
            Corr, Exec, W, B, PB, "{}", Entry, Encoding.UTF8.GetBytes(Output));

        await h.Deliver(MessageTypes.NextStepHandoff, handoff);
        var first = h.L2.Snapshot();
        await h.Deliver(MessageTypes.NextStepHandoff, handoff);

        Assert.Equal(first, h.L2.Snapshot());
        Assert.Equal(2, h.Bus.OfType<ProcessDispatch>(MessageTypes.ProcessDispatch).Count());
    }

    // ------------------------------------------------- draining a run whose workflow was stopped

    [Fact]
    public async Task AnOutcomeForAWorkflowStoppedMidRunStillAdvancesInsteadOfParking()
    {
        // THE POINT OF THE WHOLE MARK. Before it, a stop tore the workflow out of L1 and every step
        // still on the wire came back here to find nothing — one parked message and one leaked blob
        // per in-flight step, on a queue shared by the entire deployment. Six such outcomes were found
        // dead-lettered on the live stack. The definition now survives the stop for a grace period,
        // and this asserts that the run gets to finish rather than being cut off mid-graph.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, """{"n":2}"""));
        Seed(h, Entry, Output);

        // Stopped, but not yet reaped: exactly the state ApplyStopHandler leaves behind.
        h.Store.MarkDeleted(W, DateTimeOffset.UnixEpoch);
        Assert.False(h.Store.TryGetActive(W, out _));

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));
        await h.Drain();

        // The successor was dispatched with its own payload and its own copy of A's bytes — the same
        // outcome an unstopped workflow would produce. Nothing about the hand-off is degraded by the
        // stop; the stop only means no NEW run starts, and that is the fire job's business, not this
        // handler's.
        var sent = h.Bus.Sent.Single(s => s.Type == MessageTypes.ProcessDispatch);
        var dispatch = (ProcessDispatch)sent.Body;

        Assert.Equal(B, dispatch.StepId);
        Assert.Equal(Output, h.L2.Value(L2ProjectionKeys.ExecutionData(dispatch.EntryId)));

        // And the source blob was still reclaimed. A drained run that leaked its blobs would trade the
        // parked message for a permanent leak, which is not a fix.
        Assert.False(await h.L2.Db.KeyExistsAsync(L2ProjectionKeys.ExecutionData(Entry)));
    }

    // ------------------------------------------------- reclaim on every disposition that ends here

    [Fact]
    public async Task AnOutcomeForAWorkflowThisReplicaNoLongerHoldsIsParkedWithItsBlobReclaimed()
    {
        // This used to be the commonest way to reach the park: a stop removed the workflow from L1 and
        // every outcome still on the wire landed here. A stop now marks instead, so an outcome that
        // arrives while the mark stands resolves, and nothing in production ever ages that mark out —
        // the way to actually reach the park is a replica that no longer holds the workflow at all, the
        // post-restart case ReapDeletedBefore below stands in for. A park is a nack with requeue:false
        // (the message leaves for the dead-letter exchange and never returns), so without the reclaim
        // this leaks one blob per in-flight step, forever.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        h.Store.MarkDeleted(W, DateTimeOffset.UnixEpoch);
        h.Store.ReapDeletedBefore(DateTimeOffset.UnixEpoch);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry)));

        // Parked AND reclaimed. The execution is abandoned either way; the next scheduled fire will
        // most likely meet the same condition, but nothing accumulates while it does.
        Assert.False(await h.L2.Db.KeyExistsAsync(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task ARequeuedOutcomeKeepsItsBlobBecauseTheRedeliveryStillNeedsIt()
    {
        // The other half of the rule, and the half that makes it safe: only a requeue-nack skips the
        // reclaim. A transient send fault returns the delivery, and the replay re-reads this key --
        // deleting it here would turn a recoverable blip into a step that silently never advances.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        h.Bus.FaultOn = type => type == MessageTypes.NextStepHandoff
            ? new TransientSendException("broker blip", new IOException("reset"))
            : null;

        await Assert.ThrowsAsync<TransientSendException>(
            () => h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry)));

        Assert.True(await h.L2.Db.KeyExistsAsync(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task ATerminalOutcomeReclaimsItsBlobAndSaysTheRunEndedThere()
    {
        // A step with no successor that accepts the result is the end of the run, and its blob has
        // no reader left. It is also the one completion the orchestrator would otherwise record only
        // as an absence -- no hand-off line is emitted, so the log has to say so itself.
        var h = new Harness(Step(A, PA, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.False(await h.L2.Db.KeyExistsAsync(L2ProjectionKeys.ExecutionData(Entry)));
        Assert.Contains(h.PreLog.Records, e => e.Message.Contains("the run ends here"));
    }

    [Fact]
    public async Task AnEntryStepCompletionIsNamedAsOneInTheLog()
    {
        // The fire logs that it dispatched an entry step and then goes quiet. Without this the only
        // evidence an entry step finished was a hand-off naming its successor -- and an entry step
        // that is also terminal produced no such line at all.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Contains(h.PreLog.Records, e => e.Message.Contains("the entry step completed"));
    }

    [Fact]
    public async Task AFailedStepsOwnRecordIsFindableBySeverity()
    {
        // The orchestrator's half of an event the processor already logs at Warning. While these two
        // lines sat at Information a severity sweep found the processor's record of a failure and not
        // this one, which is worse than finding neither: it reads as a step that failed inside the
        // processor and was then accepted by the orchestrator.
        //
        // B is wired PreviousCompleted, so a Failed outcome matches no successor and A is terminal as
        // well as entry -- both {Result} lines fire from one delivery, which is the point of asserting
        // on the count rather than on either line alone.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Entry));

        Assert.Equal(2, h.PreLog.Records.Count(
            e => e.Level == LogLevel.Warning
                 && e.Message.Contains("completed with Failed", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task ACompletedStepsOwnRecordStaysAtInformation()
    {
        // The other half, and the reason the level is conditional rather than simply raised: a green
        // run must not emit warnings. Every soak in the chaos suite asserts on runs that completed, so
        // promoting this unconditionally would turn nine passing scenarios into a wall of warnings.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Contains(
            h.PreLog.Records,
            e => e.Level == LogLevel.Information
                 && e.Message.Contains("the entry step completed", StringComparison.Ordinal));

        Assert.DoesNotContain(
            h.PreLog.Records,
            e => e.Level == LogLevel.Warning
                 && e.Message.Contains("the entry step completed", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AFailedStepThatAdvancesAnywaySaysSo()
    {
        // THE HOLE BETWEEN THE TWO {Result} LINES. Both are conditional on position -- entry or
        // terminal -- so a failed step in the middle of a graph whose successors accept it left no
        // orchestrator record of the failure at all: only "advanced 1 successor(s) in Nms", which
        // reads exactly like a healthy hop.
        //
        // B is wired Always, which accepts a failed predecessor by design. That is the wiring worth
        // seeing rather than swallowing: the workflow dispatches the rest of itself on a step that
        // produced nothing.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, Always, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Failed, Entry));
        await h.Drain();

        Assert.Contains(
            h.PreLog.Records,
            e => e.Level == LogLevel.Warning
                 && e.Message.Contains("advancing 1 successor(s) on a Failed step", StringComparison.Ordinal));

        // The advancement line is still written: the new warning precedes it rather than replacing
        // it, so the count and the elapsed time survive.
        Assert.Contains(
            h.PreLog.Records,
            e => e.Message.Contains("advanced 1 successor(s) in", StringComparison.Ordinal));
    }

    // ---------------------------------------------------------------- the absent-key disposition

    [Fact]
    public async Task ADuplicateOutcomeAdvancesNothingAndReclaimsNothing()
    {
        // Acking is only safe because the return precedes every hand-off AND the reclaim. If it did
        // not, a duplicate would either re-dispatch the successor or delete a key belonging to the
        // pass that is still running.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));

        // A key that exists but is NOT the one the outcome names: the reclaim must not reach it.
        var bystander = Guid.Parse("99999999-9999-9999-9999-999999999999");
        Seed(h, bystander, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));
        await h.Drain();

        Assert.Empty(h.Bus.Sent);
        Assert.True(h.L2.Has(L2ProjectionKeys.ExecutionData(bystander)));
    }

    [Fact]
    public async Task ADuplicateOutcomeIsLoggedAtWarning()
    {
        // Warning, not the processor's Information: the processor can PROVE its own reclaim removed
        // the key and this infers it. A burst means outcomes are being redelivered in volume, and
        // that is the signal the dead-letter queue used to carry at the cost of operator work.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Contains(
            h.PreLog.Records,
            e => e.Level == LogLevel.Warning
                 && e.Message.Contains("duplicate delivery", StringComparison.Ordinal));
    }

    [Fact]
    public async Task TheEmptySentinelStillSkipsTheReadEntirely()
    {
        // Guid.Empty is not a key and must not take the duplicate branch: a failed source step has
        // no blob by construction, and its successors are still entitled to be dispatched.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Guid.Empty));
        await h.Drain();

        Assert.NotEmpty(h.Bus.Sent);
        Assert.DoesNotContain(
            h.PreLog.Records,
            e => e.Message.Contains("duplicate delivery", StringComparison.Ordinal));
    }

    // ---------------------------------------------------------------- provenance

    [Fact]
    public async Task AnOutcomeClaimingAProcessorTheStepIsNotAssignedToIsRefused()
    {
        // The sibling of ProcessedDataHandler's WR-02 guard. orchestrator-result is addressable on a
        // shared broker and this handler acts entirely on the ids in the body, so without this an
        // outcome naming a real workflow and a real step could be minted by anyone and would advance
        // that workflow. StepL1.ProcessorId is the authority the processor's own identity is on the
        // other side.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        var forged = new StepOutcome(Corr, Exec, W, A, PC, Entry, StepResult.Completed);

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Deliver(MessageTypes.StepOutcome, forged));

        Assert.Contains("provenance", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARefusedOutcomeAdvancesNothing()
    {
        // The refusal must be total, the same property the branch-hop guard asserts. Checking only
        // that it throws would pass even if the guard sat after the hand-offs.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Deliver(MessageTypes.StepOutcome,
                new StepOutcome(Corr, Exec, W, A, PC, Entry, StepResult.Completed)));

        Assert.Empty(h.Bus.Sent);
    }

    [Fact]
    public async Task ARefusedOutcomeDoesNotReclaimTheBlobItNames()
    {
        // THE POINT OF THE GUARD, and where it departs from the L1-miss park above deliberately.
        // That branch reclaims to avoid leaking. Here the message just failed an authenticity check,
        // so its EntryId is unauthenticated input and can name a blob belonging to a real execution
        // still in flight. Reclaiming would make the forgery destructive by our own hand.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Deliver(MessageTypes.StepOutcome,
                new StepOutcome(Corr, Exec, W, A, PC, Entry, StepResult.Completed)));

        Assert.True(h.L2.Has(L2ProjectionKeys.ExecutionData(Entry)));
    }

    [Fact]
    public async Task TheProcessorTheStepIsAssignedToIsAccepted()
    {
        // The guard must pass legitimate traffic rather than parking everything -- the same thing
        // ac23c1e had to prove on the branch hop after deploying it.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));
        await h.Drain();

        Assert.Contains(h.Bus.Sent, s => s.Type == MessageTypes.ProcessDispatch);
    }

    [Fact]
    public async Task ProvenanceIsCheckedBeforeTheBlobIsEvenRead()
    {
        // Ordering, asserted rather than assumed: a forged outcome must be refused whether or not the
        // blob it names exists. Checked after the read, a forgery naming an absent key would take the
        // duplicate-delivery branch and be ACKED -- the guard silently skipped on exactly the input
        // it exists to catch.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));

        // Deliberately not seeded.
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => h.Deliver(MessageTypes.StepOutcome,
                new StepOutcome(Corr, Exec, W, A, PC, Entry, StepResult.Completed)));

        Assert.Contains("provenance", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ADuplicateDoesNotLogAnEntryStepCompletionItDidNotCause()
    {
        // The line sat above the read until the duplicate branch gave it a reason to move. It is not
        // only misleading to read: RunLedger's I8 asserts
        // counts[EntryStepCompleted] == shape.EntryBranches EXACTLY, so a duplicate that advances
        // nothing inflated the count and breached an invariant the chaos ledger checks.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));

        // Not seeded: the duplicate shape.
        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.DoesNotContain(
            h.PreLog.Records, e => e.Message.Contains("the entry step completed", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ARealEntryStepStillLogsItsCompletionExactlyOnce()
    {
        // The other half: moving the read must not cost the line on the path that earns it, which is
        // the one I8 counts.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Single(
            h.PreLog.Records,
            e => e.Message.Contains("the entry step completed", StringComparison.Ordinal));
    }

    // ---------------------------------------------------------------------------------------
    // StepRole: terminal on the outcome of a step with no successors in this workflow's graph
    // ---------------------------------------------------------------------------------------

    [Theory]
    [InlineData(StepResult.Completed)]
    [InlineData(StepResult.Failed)]
    [InlineData(StepResult.Cancelled)]
    public async Task ATerminalStepsOutcomeCarriesTerminalWhateverItsResult(StepResult result)
    {
        var h = new Harness(Step(A, PA, 1, "{}"));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(result, Entry));

        Assert.Equal(StepRoles.Terminal, Assert.Contains(StepRoles.Key, h.ScopeOf(OutcomeTemplates.BranchEnds)!));
    }

    [Fact]
    public async Task ABranchEndingAtAStepWithSuccessorsIsNotTerminal()
    {
        // B accepts only Completed (condition 1), so a Cancelled A ends its branch -- but A has a
        // successor in the graph, so it is not an edge and carries nothing.
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, """{"n":2}"""));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Cancelled, Entry));

        Assert.DoesNotContain(StepRoles.Key, h.ScopeOf(OutcomeTemplates.BranchEnds)!);
    }

    [Fact]
    public async Task AnAdvancingOutcomeAndItsHandoffCarryNoRole()
    {
        var h = new Harness(Step(A, PA, 1, "{}", B), Step(B, PB, 1, """{"n":2}"""));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.DoesNotContain(StepRoles.Key, h.ScopeOf(OutcomeTemplates.Advanced)!);
        Assert.DoesNotContain(StepRoles.Key, h.ScopeOf("handed off to {NextStepId} on {NextProcessorId} with {NextEntryId}")!);
        Assert.DoesNotContain(StepRoles.Key, h.ScopeOf("the entry step completed with {Result}")!);
    }

    [Fact]
    public async Task ASharedStepIsTerminalOnlyInTheWorkflowWhereItHasNoSuccessors()
    {
        // A has no successors in W (the harness) and one successor in W2, which accepts only Completed.
        var w2 = Guid.Parse("99999999-9999-9999-9999-999999999999");
        var entry2 = Guid.Parse("88888888-8888-8888-8888-888888888889");
        var h = new Harness(Step(A, PA, 1, "{}"));
        h.Store.Set(w2, new WorkflowL1(w2, [A], "* * * * *", [Step(A, PA, 1, "{}", B), Step(B, PB, 1, """{"n":2}""")], []), Guid.NewGuid());
        Seed(h, Entry, Output);
        Seed(h, entry2, Output);

        // Under W2 a Cancelled A ends its branch (B declines it) but has a successor: no role.
        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Cancelled, entry2) with { WorkflowId = w2 });
        Assert.DoesNotContain(StepRoles.Key, h.ScopeOf(OutcomeTemplates.BranchEnds)!);

        // Under W the same step has no successors: terminal.
        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Cancelled, Entry));
        var ends = h.PreLog.Templates
            .Select((t, i) => (t, i))
            .Where(x => x.t == OutcomeTemplates.BranchEnds)
            .Select(x => h.PreLog.RecordScopes[x.i])
            .ToList();
        Assert.Equal(2, ends.Count);
        Assert.DoesNotContain(StepRoles.Key, ends[0]);
        Assert.Equal(StepRoles.Terminal, Assert.Contains(StepRoles.Key, ends[1]));
    }

    [Fact]
    public async Task AStepWithNoSuccessorListIsTerminalAndDoesNotThrow()
    {
        // L2WorkflowReader does not normalise NextStepIds, so a missing list must not throw before the
        // branch-ends record and the reclaim.
        var h = new Harness(new StepL1(A, 1, PA, "{}", null!));
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Equal(StepRoles.Terminal, Assert.Contains(StepRoles.Key, h.ScopeOf(OutcomeTemplates.BranchEnds)!));
    }

    [Fact]
    public async Task ATerminalOutcomeAfterAStopIsStillStamped()
    {
        // A stop marks the L1 entry rather than removing it, so outcomes in flight still resolve.
        var h = new Harness(Step(A, PA, 1, "{}"));
        h.Store.MarkDeleted(W, DateTimeOffset.UtcNow);
        Seed(h, Entry, Output);

        await h.Deliver(MessageTypes.StepOutcome, Outcome(StepResult.Completed, Entry));

        Assert.Equal(StepRoles.Terminal, Assert.Contains(StepRoles.Key, h.ScopeOf(OutcomeTemplates.BranchEnds)!));
    }
}

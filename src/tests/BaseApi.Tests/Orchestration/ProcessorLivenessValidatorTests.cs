using System.Text.Json;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Processor;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// The gate that decides whether a workflow may start. One healthy replica admits its processor;
/// nothing healthy anywhere fails the start with counts and no identifiers.
/// </summary>
public sealed class ProcessorLivenessValidatorTests
{
    private static readonly DateTime Now = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

    private sealed class Harness
    {
        public IDatabase Db { get; } = Substitute.For<IDatabase>();
        public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(Now, TimeSpan.Zero));
        public Guid ProcessorId { get; } = Guid.NewGuid();

        public ProcessorLivenessValidator Validator()
        {
            var redis = Substitute.For<IConnectionMultiplexer>();
            redis.GetDatabase().Returns(Db);
            return new ProcessorLivenessValidator(redis, Clock);
        }

        public WorkflowGraphSnapshot Snapshot()
        {
            var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
            snapshot.Processors[ProcessorId] = new ProcessorReadDto(
                ProcessorId, "sample", "1.0.0", null, "abc", null, null, null,
                Now, Now, null, null);
            return snapshot;
        }

        /// <summary>Registers the index members and what each per-instance key returns.</summary>
        public void Replicas(params (string InstanceId, RedisValue Value)[] replicas)
        {
            Db.SetMembersAsync(L2ProjectionKeys.InstanceIndex(ProcessorId))
                .Returns(replicas.Select(r => (RedisValue)r.InstanceId).ToArray());

            foreach (var (instanceId, value) in replicas)
            {
                Db.StringGetAsync(L2ProjectionKeys.PerInstance(ProcessorId, instanceId))
                    .Returns(value);
            }
        }
    }

    private static RedisValue Entry(string status, int ageSeconds, int interval = 10) =>
        JsonSerializer.Serialize(new ProcessorLivenessEntry(
            Now.AddSeconds(-ageSeconds), interval, status,
            new LivenessSummary(SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success)));

    [Fact]
    public async Task PassesWhenOneReplicaIsHealthyEvenIfItsSiblingsAreNot()
    {
        // A rolling deploy always has a replica that is not servable yet; blocking on that would make
        // every start fail during a routine rollout.
        var h = new Harness();
        h.Replicas(
            ("dead-1", RedisValue.Null),
            ("stale-1", Entry(LivenessStatus.Healthy, ageSeconds: 999)),
            ("good-1", Entry(LivenessStatus.Healthy, ageSeconds: 1)));

        await h.Validator().ValidateAsync(h.Snapshot(), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task FailsWhenEveryReplicaIsStale()
    {
        // Freshness is the entry's own recorded interval doubled — a self-describing window.
        var h = new Harness();
        h.Replicas(("a", Entry(LivenessStatus.Healthy, ageSeconds: 21)));

        var ex = await Assert.ThrowsAsync<OrchestrationValidationException>(
            () => h.Validator().ValidateAsync(h.Snapshot(), TestContext.Current.CancellationToken));
        Assert.Contains("1 stale", ex.Message);
    }

    [Fact]
    public async Task FailsWhenTheIndexIsEmpty()
    {
        // A processor that has never registered a replica blocks the start.
        var h = new Harness();
        h.Replicas();

        var ex = await Assert.ThrowsAsync<OrchestrationValidationException>(
            () => h.Validator().ValidateAsync(h.Snapshot(), TestContext.Current.CancellationToken));
        Assert.Contains("0 checked", ex.Message);
    }

    [Fact]
    public async Task CountsEveryFailureKindSeparately()
    {
        // The counts are the only diagnostic an operator gets, so each bad state must land in its
        // own bucket rather than collapsing into a single "not live".
        var h = new Harness();
        h.Replicas(
            ("absent", RedisValue.Null),
            ("unhealthy", Entry(LivenessStatus.Unhealthy, ageSeconds: 1)),
            ("stale", Entry(LivenessStatus.Healthy, ageSeconds: 999)),
            ("malformed", "not json"));

        var ex = await Assert.ThrowsAsync<OrchestrationValidationException>(
            () => h.Validator().ValidateAsync(h.Snapshot(), TestContext.Current.CancellationToken));

        Assert.Contains("4 checked", ex.Message);
        Assert.Contains("1 absent", ex.Message);
        Assert.Contains("1 unhealthy", ex.Message);
        Assert.Contains("1 stale", ex.Message);
        Assert.Contains("1 malformed", ex.Message);
    }

    [Fact]
    public async Task NeverNamesAnInstanceInTheFailure()
    {
        // Instance ids are pod names. The reason is counts only — no identifiers, no infrastructure.
        var h = new Harness();
        h.Replicas(("proc-sample-7d9f", RedisValue.Null));

        var ex = await Assert.ThrowsAsync<OrchestrationValidationException>(
            () => h.Validator().ValidateAsync(h.Snapshot(), TestContext.Current.CancellationToken));

        Assert.DoesNotContain("proc-sample-7d9f", ex.Message);
    }

    [Fact]
    public async Task ReadsEveryReplicaInOneBatchEvenWhenTheFirstQualifies()
    {
        // The deliberate trade: a few hundred more bytes on the happy path in exchange for a bounded
        // two round trips per processor when every replica is dead — which is when a workflow with
        // many processors would otherwise turn a start request into a long serial walk.
        var h = new Harness();
        h.Replicas(
            ("good-1", Entry(LivenessStatus.Healthy, ageSeconds: 1)),
            ("other-1", Entry(LivenessStatus.Healthy, ageSeconds: 1)),
            ("other-2", Entry(LivenessStatus.Healthy, ageSeconds: 1)));

        await h.Validator().ValidateAsync(h.Snapshot(), TestContext.Current.CancellationToken);

        var reads = h.Db.ReceivedCalls()
            .Count(c => c.GetMethodInfo().Name == nameof(IDatabase.StringGetAsync));
        Assert.Equal(3, reads);
    }

    [Fact]
    public async Task HonoursCancellation()
    {
        // A client that has gone away must not still be paying for a walk over every replica.
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var h = new Harness();
        h.Replicas(("a", Entry(LivenessStatus.Healthy, ageSeconds: 1)));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => h.Validator().ValidateAsync(h.Snapshot(), cts.Token));
    }
}

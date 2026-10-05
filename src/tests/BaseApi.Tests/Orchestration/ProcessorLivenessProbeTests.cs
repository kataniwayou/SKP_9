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

public sealed class ProcessorLivenessProbeTests
{
    private static readonly DateTime Now = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);

    private readonly IDatabase _db = Substitute.For<IDatabase>();
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(Now, TimeSpan.Zero));

    private IConnectionMultiplexer Redis()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(_db);
        return redis;
    }

    private void Replicas(Guid processorId, params (string InstanceId, RedisValue Value)[] replicas)
    {
        _db.SetMembersAsync(L2ProjectionKeys.ProcessorInstances(processorId))
            .Returns(replicas.Select(r => (RedisValue)r.InstanceId).ToArray());
        foreach (var (instanceId, value) in replicas)
            _db.StringGetAsync(L2ProjectionKeys.PerInstance(processorId, instanceId)).Returns(value);
    }

    private static RedisValue Entry(string status, int ageSeconds, int interval = 10) =>
        JsonSerializer.Serialize(new ProcessorLivenessEntry(
            Now.AddSeconds(-ageSeconds), interval, status,
            new LivenessSummary(SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success)));

    private static WorkflowGraphSnapshot Snapshot(params Guid[] processors)
    {
        var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
        foreach (var id in processors)
            snapshot.Processors[id] = new ProcessorReadDto(id, "p", "1.0.0", null, "abc", null, null, null, null, Now, Now, null, null);
        return snapshot;
    }

    [Fact]
    public async Task ClassifiesEveryReplicaEvenAfterAHealthyOne()
    {
        var id = Guid.NewGuid();
        Replicas(id,
            ("good", Entry(LivenessStatus.Healthy, ageSeconds: 1)),
            ("gone", RedisValue.Null),
            ("sick", Entry(LivenessStatus.Unhealthy, ageSeconds: 1)),
            ("old", Entry(LivenessStatus.Healthy, ageSeconds: 999)),
            ("junk", "{not json"));

        var result = await new ProcessorLivenessProbe(Redis(), _clock).ProbeAsync(id, TestContext.Current.CancellationToken);

        Assert.Equal(new ProcessorLiveness(id, Replicas: 5, Healthy: 1, Absent: 1, Unhealthy: 1, Stale: 1, Malformed: 1), result);
        Assert.True(result.Live);
    }

    [Fact]
    public async Task AProcessorWithNoReplicasIsNotLiveAndItsReasonKeepsTheGatesWording()
    {
        var id = Guid.NewGuid();
        Replicas(id);

        var result = await new ProcessorLivenessProbe(Redis(), _clock).ProbeAsync(id, TestContext.Current.CancellationToken);

        Assert.False(result.Live);
        Assert.Equal("no healthy replica (0 checked: 0 absent, 0 unhealthy, 0 stale, 0 malformed)", result.Reason);
    }

    [Fact]
    public async Task CollectReportsEveryDeadProcessorAndSkipsTheLiveOnes()
    {
        var (dead1, live, dead2) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        Replicas(dead1);
        Replicas(live, ("good", Entry(LivenessStatus.Healthy, ageSeconds: 1)));
        Replicas(dead2, ("old", Entry(LivenessStatus.Healthy, ageSeconds: 999)));

        var problems = await new ProcessorLivenessValidator(Redis(), _clock)
            .CollectAsync(Snapshot(dead1, live, dead2), TestContext.Current.CancellationToken);

        Assert.Equal([dead1, dead2], problems.Select(p => ((ProcessorLivenessOffending)p.Offending).procId));
        Assert.All(problems, p => Assert.Equal("processorLiveness", p.Gate));
        Assert.Equal("no healthy replica (1 checked: 0 absent, 0 unhealthy, 1 stale, 0 malformed)",
            ((ProcessorLivenessOffending)problems[1].Offending).reason);
    }
}

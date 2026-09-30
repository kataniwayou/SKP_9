using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using Orchestrator.L1;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The reader is the one place that knows L2's key layout, and the only place the orchestrator touches
/// L2 at all. The activation tests drive its happy path; these cover the paths they cannot reach — a
/// live-set member that is not a workflow id, which is survivable by design and may not take a
/// hydration pass down, and a Redis fault on the store read, which is the fence on the other side:
/// what is survivable stops exactly where the store's own faults begin. A store that will not
/// deserialize is <c>LiveSetActivationTests.ACorruptStoreReadsAsAbsentAndDoesNotThrow</c>.
/// </summary>
public sealed class L2WorkflowReaderTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S1 = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    private readonly IDatabase _db = Substitute.For<IDatabase>();
    private readonly L2WorkflowReader _reader;

    public L2WorkflowReaderTests()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(_db);
        _reader = new L2WorkflowReader(redis, NullLogger<L2WorkflowReader>.Instance);
    }

    private void WriteStore(string? cron, params Guid[] stepIds) =>
        _db.HashGetAsync(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField, Arg.Any<CommandFlags>())
            .Returns((RedisValue)JsonSerializer.Serialize(
                new WorkflowStoreProjection(
                    EntryStepIds: [stepIds.Length > 0 ? stepIds[0] : Guid.Empty],
                    Cron: cron,
                    Steps: stepIds
                        .Select(id => new StepL1(id, EntryCondition: 1, ProcessorId: P, Payload: "{\"k\":1}", NextStepIds: []))
                        .ToList()),
                MessagingJson.Options));

    [Fact]
    public async Task ReadsTheRootAndItsStepsIntoOneDefinition()
    {
        WriteStore("0 * * * *", S1);

        var definition = await _reader.ReadAsync(W, CancellationToken.None);

        Assert.NotNull(definition);
        Assert.Equal(W, definition.WorkflowId);
        Assert.Equal("0 * * * *", definition.Cron);
        Assert.Equal([S1], definition.EntryStepIds);
        var step = Assert.Single(definition.Steps);
        Assert.Equal(S1, step.StepId);
        Assert.Equal(1, step.EntryCondition);
        Assert.Equal(P, step.ProcessorId);
        Assert.Equal("{\"k\":1}", step.Payload);
    }

    [Fact]
    public async Task ReturnsNullWhenTheRootKeyIsAbsent()
    {
        // Nothing stubbed: an unstubbed HashGetAsync yields default(RedisValue), which is what an
        // absent key or field looks like.
        Assert.Null(await _reader.ReadAsync(W, CancellationToken.None));
    }

    [Fact]
    public async Task LetsARedisFaultOnTheStoreReadEscape()
    {
        // The other half of the corrupt-store decision. Reading a bad store as absent must not be wide
        // enough to swallow this: spec §7.4 classifies an L2 read fault as RequeueAndTrip, which only
        // the consumer can do, and only if the fault reaches it.
        _db.HashGetAsync(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.StoreField, Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down"));

        await Assert.ThrowsAsync<RedisConnectionException>(
            () => _reader.ReadAsync(W, CancellationToken.None));
    }

    [Fact]
    public async Task ReadsEveryWorkflowIdFromTheLiveSetAndSkipsWhatIsNotOne()
    {
        _db.SetMembersAsync(L2ProjectionKeys.Live(), Arg.Any<CommandFlags>())
            .Returns([W.ToString("D"), "not-a-workflow-id", S1.ToString("D")]);

        var ids = await _reader.ReadAllIdsAsync(CancellationToken.None);

        Assert.Equal([W, S1], ids);
    }

    [Fact]
    public async Task LivenessIsAskedOfTheLiveSetForTheWorkflowAskedAbout()
    {
        // Both answers are stubbed, and they differ. Leaving the negative to the substitute's default
        // would have let an implementation that ignores its argument pass — which is precisely the
        // implementation the stop path cannot survive, since it verifies one workflow's removal.
        _db.SetContainsAsync(L2ProjectionKeys.Live(), W.ToString("D"), Arg.Any<CommandFlags>()).Returns(true);
        _db.SetContainsAsync(L2ProjectionKeys.Live(), S1.ToString("D"), Arg.Any<CommandFlags>()).Returns(false);

        Assert.True(await _reader.IsLiveAsync(W, CancellationToken.None));
        Assert.False(await _reader.IsLiveAsync(S1, CancellationToken.None));
    }
}

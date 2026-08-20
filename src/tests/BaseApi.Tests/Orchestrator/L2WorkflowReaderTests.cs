using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Orchestrator.L1;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestrator;

/// <summary>
/// The reader is the one place that knows L2's key layout, and the only place the orchestrator touches
/// L2 at all. The activation tests drive its happy path; these cover the two damaged-store paths they
/// cannot reach — a root listing a step key that is not there, and an index member that is not a
/// workflow id — because both are survivable by design and neither may take a hydration pass down.
/// </summary>
public sealed class L2WorkflowReaderTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S1 = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid S2 = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    private readonly IDatabase _db = Substitute.For<IDatabase>();
    private readonly L2WorkflowReader _reader;

    public L2WorkflowReaderTests()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(_db);
        _reader = new L2WorkflowReader(redis, NullLogger<L2WorkflowReader>.Instance);
    }

    private void WriteRoot(string? cron, params Guid[] stepIds) =>
        _db.StringGetAsync(L2ProjectionKeys.Root(W), Arg.Any<CommandFlags>())
            .Returns((RedisValue)JsonSerializer.Serialize(
                new WorkflowRootProjection(
                    EntryStepIds: [stepIds.Length > 0 ? stepIds[0] : Guid.Empty],
                    StepIds: [.. stepIds],
                    Cron: cron,
                    Liveness: new LivenessProjection(DateTime.UtcNow, 3600, "Pending")),
                MessagingJson.Options));

    private void WriteStep(Guid stepId) =>
        _db.StringGetAsync(L2ProjectionKeys.Step(W, stepId), Arg.Any<CommandFlags>())
            .Returns((RedisValue)JsonSerializer.Serialize(
                new StepProjection(
                    EntryCondition: 1, ProcessorId: P, Payload: "{\"k\":1}", NextStepIds: []),
                MessagingJson.Options));

    [Fact]
    public async Task ReadsTheRootAndItsStepsIntoOneDefinition()
    {
        WriteRoot("0 * * * *", S1);
        WriteStep(S1);

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
        // Nothing stubbed: an unstubbed StringGetAsync yields default(RedisValue), which is what an
        // absent key looks like.
        Assert.Null(await _reader.ReadAsync(W, CancellationToken.None));
    }

    [Fact]
    public async Task SkipsAStepTheRootListsButL2NoLongerHolds()
    {
        // A torn projection is survivable: the workflow is still worth running with the steps that are
        // there, and the next start rewrites the whole key set anyway.
        WriteRoot("0 * * * *", S1, S2);
        WriteStep(S1);

        var definition = await _reader.ReadAsync(W, CancellationToken.None);

        Assert.NotNull(definition);
        Assert.Equal(S1, Assert.Single(definition.Steps).StepId);
    }

    [Fact]
    public async Task ReadsEveryWorkflowIdFromTheParentIndexAndSkipsWhatIsNotOne()
    {
        _db.SetMembersAsync(L2ProjectionKeys.ParentIndex(), Arg.Any<CommandFlags>())
            .Returns([W.ToString("D"), "not-a-workflow-id", S1.ToString("D")]);

        var ids = await _reader.ReadAllIdsAsync(CancellationToken.None);

        Assert.Equal([W, S1], ids);
    }

    [Fact]
    public async Task ExistenceIsAskedOfTheRootKey()
    {
        _db.KeyExistsAsync(L2ProjectionKeys.Root(W), Arg.Any<CommandFlags>()).Returns(true);

        Assert.True(await _reader.ExistsAsync(W, CancellationToken.None));
        Assert.False(await _reader.ExistsAsync(S1, CancellationToken.None));
    }
}

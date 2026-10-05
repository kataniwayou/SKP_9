using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts.Projections;
using Microsoft.AspNetCore.Mvc;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Orchestration;

public sealed class LiveWorkflowListTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task ListsEveryRunningWorkflowSortedAndSkipsMembersThatAreNotIds()
    {
        var l2 = new InMemoryL2();
        var (a, b) = (Guid.NewGuid(), Guid.NewGuid());
        await l2.Db.SetAddAsync(L2ProjectionKeys.Live(), b.ToString("D"));
        await l2.Db.SetAddAsync(L2ProjectionKeys.Live(), "not-a-workflow");
        await l2.Db.SetAddAsync(L2ProjectionKeys.Live(), a.ToString("D"));

        var ids = await new L2LiveSet(l2.Multiplexer).ListAsync(Ct);

        Assert.Equal(new[] { a, b }.OrderBy(x => x), ids);
    }

    [Fact]
    public async Task AnEmptyLiveSetIsAnEmptyList()
    {
        Assert.Empty(await new L2LiveSet(new InMemoryL2().Multiplexer).ListAsync(Ct));
    }

    [Fact]
    public async Task ARedisFaultPropagatesTaggedWithItsOperation()
    {
        var db = Substitute.For<IDatabase>();
        db.SetMembersAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.UnableToConnect, "down"));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(db);

        var ex = await Assert.ThrowsAsync<RedisConnectionException>(() => new L2LiveSet(redis).ListAsync(Ct));

        Assert.Equal("ListLiveWorkflows", ex.Data["redisOp"]);
    }

    [Fact]
    public async Task TheControllerAnswersTheList()
    {
        var id = Guid.NewGuid();
        var reader = Substitute.For<ILiveWorkflowReader>();
        reader.ListAsync(Arg.Any<CancellationToken>()).Returns(new[] { id });

        var result = await new OrchestrationController(service: null!, reader).Live(Ct);

        Assert.Equal([id], Assert.IsAssignableFrom<IReadOnlyList<Guid>>(Assert.IsType<OkObjectResult>(result.Result).Value));
    }
}

using BaseApi.Tests.Support;
using BaseConsole.Core.Naming;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class StepRoleResolverTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");

    private static async Task<InMemoryL2> WithRole(string role)
    {
        var l2 = new InMemoryL2();
        await l2.Db.HashSetAsync(L2ProjectionKeys.StepRole(W, S), L2ProjectionKeys.RoleField, role, When.Always, CommandFlags.None);
        return l2;
    }

    private static StepRoleResolver Resolver(InMemoryL2 l2)
        => new(new RedisStepRoleSource(l2.Multiplexer), NullLogger<StepRoleResolver>.Instance);

    [Fact]
    public async Task ARoleIsReadFromTheWorkflowsKey()
        => Assert.Equal("terminal", await Resolver(await WithRole("terminal")).RoleAsync(W, S));

    [Fact]
    public async Task ARoleIsCachedUntilTheWorkflowIsForgotten()
    {
        var l2 = await WithRole("terminal");
        var resolver = Resolver(l2);
        await resolver.RoleAsync(W, S);

        await l2.Db.HashSetAsync(L2ProjectionKeys.StepRole(W, S), L2ProjectionKeys.RoleField, "intermediate", When.Always, CommandFlags.None);
        Assert.Equal("terminal", await resolver.RoleAsync(W, S));

        resolver.Forget(W);
        Assert.Equal("intermediate", await resolver.RoleAsync(W, S));
    }

    [Fact]
    public async Task AMissingRoleIsNullAndNotGuessed()
        => Assert.Null(await Resolver(new InMemoryL2()).RoleAsync(W, S));

    [Fact]
    public async Task AStoreFaultIsNullAndNotThrown()
    {
        var source = Substitute.For<IStepRoleSource>();
        source.ReadRoleAsync(W, S).Returns(Task.FromException<string?>(new RedisConnectionException(ConnectionFailureType.SocketFailure, "down")));

        Assert.Null(await new StepRoleResolver(source, NullLogger<StepRoleResolver>.Instance).RoleAsync(W, S));
    }

    [Fact]
    public void ANullRoleOpensNoScope()
        => Assert.Null(StepRoleResolver.BeginScope(NullLogger.Instance, null));
}

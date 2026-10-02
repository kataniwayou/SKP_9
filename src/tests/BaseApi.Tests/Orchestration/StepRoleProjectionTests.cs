using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Messaging;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Messaging.Transport;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>Each workflow's step roles, written with its projection and removed with its steps.</summary>
public sealed class StepRoleProjectionTests
{
    private static readonly Guid W1 = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid W2 = Guid.Parse("99999999-9999-9999-9999-999999999999");
    private static readonly Guid A = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid B = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    private static readonly Guid C = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");
    private static readonly Guid P = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private static StepL1 Step(Guid id, params Guid[] next) => new(id, 1, P, "{}", [.. next]);

    private static WorkflowL1 Def(Guid w, Guid entry, params StepL1[] steps)
        => new(w, [entry], "0 * * * * *", [.. steps], [], new Dictionary<Guid, string>());

    private static Task StartAsync(InMemoryL2 l2, WorkflowL1 d, FakeStepRows? rows = null) =>
        new StartOrchestrationHandler(
                new L2ProjectionWriter(l2.Multiplexer, rows ?? FakeStepRows.Everything()), new L2LiveSet(l2.Multiplexer),
                Substitute.For<IQueueFanoutPublisher>(), NullLogger<StartOrchestrationHandler>.Instance)
            .HandleAsync(JsonSerializer.SerializeToUtf8Bytes(new StartOrchestration(d), MessagingJson.Options),
                         CancellationToken.None);

    private static string? Role(InMemoryL2 l2, Guid w, Guid s) => l2.HashValue(L2ProjectionKeys.StepRole(w, s), L2ProjectionKeys.RoleField);

    [Fact]
    public void TheClassifierAppliesTheThreeRules()
    {
        var roles = StepRoleClassifier.Classify([A], [Step(A, B), Step(B, C), Step(C)]);

        Assert.Equal(StepRoles.Entry, roles[A]);
        Assert.Equal(StepRoles.Intermediate, roles[B]);
        Assert.Equal(StepRoles.Terminal, roles[C]);
    }

    [Fact]
    public void AnEntryStepWithNoSuccessorsIsEntry()
        => Assert.Equal(StepRoles.Entry, StepRoleClassifier.Classify([A], [Step(A)])[A]);

    [Fact]
    public async Task AStartWritesARoleKeyForEveryStep()
    {
        var l2 = new InMemoryL2();

        await StartAsync(l2, Def(W1, A, Step(A, B), Step(B, C), Step(C)));

        Assert.Equal("entry", Role(l2, W1, A));
        Assert.Equal("intermediate", Role(l2, W1, B));
        Assert.Equal("terminal", Role(l2, W1, C));
    }

    [Fact]
    public async Task ASharedStepHasEachWorkflowsOwnRole()
    {
        var l2 = new InMemoryL2();

        await StartAsync(l2, Def(W1, A, Step(A, B), Step(B)));       // B is terminal here
        await StartAsync(l2, Def(W2, A, Step(A, B), Step(B, C), Step(C))); // and intermediate here

        Assert.Equal("terminal", Role(l2, W1, B));
        Assert.Equal("intermediate", Role(l2, W2, B));
    }

    [Fact]
    public async Task DroppingAStepDeletesOnlyThisWorkflowsRoleKey()
    {
        var l2 = new InMemoryL2();
        await StartAsync(l2, Def(W1, A, Step(A, B), Step(B)));
        await StartAsync(l2, Def(W2, A, Step(A, B), Step(B)));

        // B is dropped from W1; its step row still exists (W2 uses it).
        await StartAsync(l2, Def(W1, A, Step(A)));

        Assert.Null(Role(l2, W1, B));
        Assert.Equal("terminal", Role(l2, W2, B));
        Assert.Equal("entry", Role(l2, W1, A));
    }

    [Fact]
    public async Task ARoleChangesWithTheGraphAtTheNextStart()
    {
        var l2 = new InMemoryL2();
        await StartAsync(l2, Def(W1, A, Step(A, B), Step(B)));

        await StartAsync(l2, Def(W1, A, Step(A, B), Step(B, C), Step(C)));

        Assert.Equal("intermediate", Role(l2, W1, B));
    }

    [Fact]
    public async Task AStopDeletesNoRoleKey()
    {
        var l2 = new InMemoryL2();
        await StartAsync(l2, Def(W1, A, Step(A, B), Step(B)));

        await new StopOrchestrationHandler(new L2LiveSet(l2.Multiplexer), Substitute.For<IQueueFanoutPublisher>(),
                NullLogger<StopOrchestrationHandler>.Instance)
            .HandleAsync(JsonSerializer.SerializeToUtf8Bytes(new StopOrchestration(W1), MessagingJson.Options), CancellationToken.None);

        Assert.Equal("terminal", Role(l2, W1, B));
    }
}

using System.Text.Json;
using BaseApi.Core.Exceptions;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow.Graph;
using FluentValidation;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Redis stand-ins for the liveness gate: every processor live, none live, or Redis down.</summary>
internal static class RedisStub
{
    public static IConnectionMultiplexer AllLive(FakeTimeProvider clock)
    {
        var db = Substitute.For<IDatabase>();
        db.SetMembersAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(new RedisValue[] { "i1" });
        db.StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns((RedisValue)JsonSerializer.Serialize(
            new ProcessorLivenessEntry(clock.GetUtcNow().UtcDateTime, 10, LivenessStatus.Healthy,
                new LivenessSummary(SchemaOutcome.Success, SchemaOutcome.Success, SchemaOutcome.Success))));
        return Wrap(db);
    }

    public static IConnectionMultiplexer NoneLive()
    {
        var db = Substitute.For<IDatabase>();
        db.SetMembersAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(Array.Empty<RedisValue>());
        return Wrap(db);
    }

    public static IConnectionMultiplexer Down()
    {
        var db = Substitute.For<IDatabase>();
        db.SetMembersAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .ThrowsAsync(new RedisConnectionException(ConnectionFailureType.UnableToConnect, "down"));
        return Wrap(db);
    }

    private static IConnectionMultiplexer Wrap(IDatabase db)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase().Returns(db);
        return redis;
    }
}

public sealed class WorkflowValidatorTests
{
    [Fact]
    public async Task AStoredWorkflowWithNoProblemsIsValid()
    {
        await using var h = new GraphHarness();
        var b = await h.StepAsync(await h.ProcessorAsync(), "b");
        var a = await h.StepAsync(await h.ProcessorAsync(), "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);

        var result = await h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(wf, null, h.Ct);

        Assert.True(result.Valid);
        Assert.Empty(result.Problems);
    }

    [Fact]
    public async Task ADraftThatCreatesACycleReportsItWithoutThrowing()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var bLoaded = loaded.Steps.Single(s => s.Id == b);
        h.Forget();

        var draft = GraphHarness.Request([a], loaded.Workflow.UpdatedAt,
            steps: [new GraphStepDto(b, bLoaded.UpdatedAt, "b", "1.0.0", null, proc, [a], StepEntryCondition.PreviousCompleted)]);
        var result = await h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(wf, draft, h.Ct);

        Assert.False(result.Valid);
        var cycle = Assert.Single(result.Problems);
        Assert.Equal("cycle", cycle.Gate);
        Assert.Equal("Workflow contains a cycle", cycle.Title);
    }

    [Fact]
    public async Task EveryGateReportsAtOnce()
    {
        await using var h = new GraphHarness();
        var (sOut, sIn) = (await h.SchemaAsync("out"), await h.SchemaAsync("in"));
        var cfg = await h.SchemaAsync("cfg", definition: """{"type":"object","required":["url"]}""");
        var child = await h.StepAsync(await h.ProcessorAsync("child", input: sIn, config: cfg), "child");
        var parent = await h.StepAsync(await h.ProcessorAsync("parent", output: sOut), "parent", child);
        var asg = await h.AssignmentAsync(child, "{}");
        var wf = await h.WorkflowAsync("wf", [parent], [asg]);

        var result = await h.Validator(RedisStub.NoneLive()).ValidateAsync(wf, null, h.Ct);

        Assert.False(result.Valid);
        Assert.Equal(["schemaEdge", "payloadConfigSchema", "processorLiveness", "processorLiveness"], result.Problems.Select(p => p.Gate));
    }

    [Fact]
    public async Task ADraftForAWorkflowThatDoesNotExistYetIsValidated()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var (wf, a) = (Guid.NewGuid(), Guid.NewGuid());

        var result = await h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(wf,
            GraphHarness.Request([a], steps: [GraphHarness.NewStep(a, proc, "a", a)]), h.Ct);

        Assert.Equal("cycle", Assert.Single(result.Problems).Gate);
    }

    [Fact]
    public async Task NoDraftAndNoSuchWorkflowIsNotFound()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<NotFoundException>(() => h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(Guid.NewGuid(), null, h.Ct));
    }

    [Fact]
    public async Task AnEmptyIdIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<ValidationException>(() => h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(Guid.Empty, null, h.Ct));
    }

    [Fact]
    public async Task ADraftWithFieldErrorsIsStillA400()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<ValidationException>(() =>
            h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(Guid.NewGuid(), GraphHarness.Request(entry: []), h.Ct));
    }

    [Fact]
    public async Task RedisDownIsATaggedFaultNotANotLiveAnswer()
    {
        // Review focus 2.
        await using var h = new GraphHarness();
        var a = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [a]);

        var ex = await Assert.ThrowsAsync<RedisConnectionException>(() => h.Validator(RedisStub.Down()).ValidateAsync(wf, null, h.Ct));

        Assert.Equal("ValidateLiveness", ex.Data["redisOp"]);
    }
}

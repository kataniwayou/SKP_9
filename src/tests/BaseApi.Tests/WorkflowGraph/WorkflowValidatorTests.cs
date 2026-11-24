using System.Text.Json;
using BaseApi.Core.Exceptions;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Step;
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

        var result = await h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(wf, h.Ct);

        Assert.True(result.Valid);
        Assert.Empty(result.Problems);
    }

    [Fact]
    public async Task AStoredCycleIsReportedWithoutThrowing()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        h.Db.StepNextSteps.Add(new StepNextSteps { StepId = b, NextStepId = a });
        await h.Db.SaveChangesAsync(h.Ct);
        var wf = await h.WorkflowAsync("wf", [a]);

        var result = await h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(wf, h.Ct);

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

        var result = await h.Validator(RedisStub.NoneLive()).ValidateAsync(wf, h.Ct);

        Assert.False(result.Valid);
        Assert.Equal(["schemaEdge", "payloadConfigSchema", "processorLiveness", "processorLiveness"], result.Problems.Select(p => p.Gate));
    }

    [Fact]
    public async Task NoSuchWorkflowIsNotFound()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<NotFoundException>(() => h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(Guid.NewGuid(), h.Ct));
    }

    [Fact]
    public async Task AnEmptyIdIsAValidationFailure()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<ValidationException>(() => h.Validator(RedisStub.AllLive(h.Clock)).ValidateAsync(Guid.Empty, h.Ct));
    }

    [Fact]
    public async Task RedisDownIsATaggedFaultNotANotLiveAnswer()
    {
        // Review focus 2.
        await using var h = new GraphHarness();
        var a = await h.StepAsync(await h.ProcessorAsync());
        var wf = await h.WorkflowAsync("wf", [a]);

        var ex = await Assert.ThrowsAsync<RedisConnectionException>(() => h.Validator(RedisStub.Down()).ValidateAsync(wf, h.Ct));

        Assert.Equal("ValidateLiveness", ex.Data["redisOp"]);
    }
}

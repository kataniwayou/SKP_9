using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Projection;

/// <summary>
/// The start-driven key layout, pinned as literals: BaseApi writes these, the orchestrator and the
/// processors read them, and the Python tools address them by string. A shape that drifts on one side
/// reads as an empty store on the other, and nothing at runtime says so.
/// </summary>
public sealed class L2KeyLayoutTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    [Fact]
    public void EveryEntityKeyCarriesItsTypeSegment()
    {
        Assert.Equal("skp:wf:11111111-1111-1111-1111-111111111111", L2ProjectionKeys.Workflow(W));
        Assert.Equal("skp:step:22222222-2222-2222-2222-222222222222", L2ProjectionKeys.StepEntity(S));
        Assert.Equal("skp:proc:33333333-3333-3333-3333-333333333333", L2ProjectionKeys.Processor(P));
    }

    [Fact]
    public void EntityDispatchesOnTheKind()
    {
        Assert.Equal(L2ProjectionKeys.Workflow(W), L2ProjectionKeys.Entity(L2EntityKind.Workflow, W));
        Assert.Equal(L2ProjectionKeys.StepEntity(S), L2ProjectionKeys.Entity(L2EntityKind.Step, S));
        Assert.Equal(L2ProjectionKeys.Processor(P), L2ProjectionKeys.Entity(L2EntityKind.Processor, P));
        Assert.Throws<ArgumentOutOfRangeException>(() => L2ProjectionKeys.Entity((L2EntityKind)99, W));
    }

    [Fact]
    public void TheHashFieldsAreFixed()
    {
        Assert.Equal("name", L2ProjectionKeys.NameField);
        Assert.Equal("store", L2ProjectionKeys.StoreField);
        Assert.Equal("roots", L2ProjectionKeys.RootsField);
    }

    [Fact]
    public void TheLiveSetIsOneFixedKey() => Assert.Equal("skp:live", L2ProjectionKeys.Live());

    [Fact]
    public void ProcessorInstanceKeysSitUnderTheProcessorKey()
    {
        Assert.Equal("skp:proc:33333333-3333-3333-3333-333333333333:instances", L2ProjectionKeys.ProcessorInstances(P));
        Assert.Equal("skp:proc:33333333-3333-3333-3333-333333333333:pod-0", L2ProjectionKeys.PerInstance(P, "pod-0"));
    }

    [Fact]
    public void AnInstancesKeyParsesBackToItsProcessor()
    {
        Assert.True(L2ProjectionKeys.TryParseProcessorInstances(L2ProjectionKeys.ProcessorInstances(P), out var id));
        Assert.Equal(P, id);
    }

    [Theory]
    [InlineData("skp:proc:33333333-3333-3333-3333-333333333333")]
    [InlineData("skp:proc:33333333-3333-3333-3333-333333333333:pod-0")]
    [InlineData("skp:proc:not-a-guid:instances")]
    [InlineData("skp:wf:33333333-3333-3333-3333-333333333333:instances")]
    [InlineData("skp:proc:instances")]
    public void AnythingElseDoesNotParseAsAnInstancesKey(string key)
        => Assert.False(L2ProjectionKeys.TryParseProcessorInstances(key, out _));

    [Fact]
    public void CacheKeysLiveUnderTheWorkflowKey()
    {
        Assert.Equal("skp:wf:11111111-1111-1111-1111-111111111111:cache:sk-whitelist", L2ProjectionKeys.Cache(W, "sk-whitelist"));
        Assert.StartsWith(L2ProjectionKeys.Workflow(W) + ":cache:", L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme"));
    }

    [Fact]
    public void TheRetiredShapesAreGone()
    {
        var keys = typeof(L2ProjectionKeys);
        Assert.Null(keys.GetMethod("ParentIndex"));
        Assert.Null(keys.GetMethod("Root"));
        Assert.Null(keys.GetMethod("Step"));
        Assert.Null(keys.GetMethod("Name"));
        Assert.Null(keys.GetMethod("InstanceIndex"));
        Assert.Null(keys.Assembly.GetType("Messaging.Contracts.Projections.WorkflowRootProjection"));
        Assert.Null(keys.Assembly.GetType("Messaging.Contracts.Projections.StepProjection"));
        Assert.Null(keys.Assembly.GetType("Messaging.Contracts.Projections.LivenessProjection"));
    }

    [Fact]
    public void TheStoreRoundTripsWithItsFieldNames()
    {
        var store = new WorkflowStoreProjection(
            EntryStepIds: [S],
            Cron: "0 0/5 * * * ?",
            Steps: [new StepL1(S, 4, P, "{}", [])]);

        var json = JsonSerializer.Serialize(store, MessagingJson.Options);
        var back = JsonSerializer.Deserialize<WorkflowStoreProjection>(json, MessagingJson.Options)!;

        Assert.Contains("\"entryStepIds\"", json);
        Assert.Contains("\"cron\"", json);
        Assert.Contains("\"steps\"", json);
        Assert.Equal([S], back.EntryStepIds);
        Assert.Equal("0 0/5 * * * ?", back.Cron);
        Assert.Equal(P, Assert.Single(back.Steps).ProcessorId);
    }
}

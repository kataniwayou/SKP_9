using Messaging.Contracts;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Workflow;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The flattening step, where a snapshot of rows becomes the definition that travels on the wire.
/// The junction is resolved here, while both sides are in hand, so nothing downstream has to know it
/// exists — the same treatment the assignment payload already gets.
/// </summary>
public sealed class CacheDefinitionTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");

    private static WorkflowGraphSnapshot Snapshot(params CacheReadDto[] caches)
    {
        var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);

        snapshot.Workflows[W] = new WorkflowReadDto(
            W, "wf", "1.0.0", null, [], [], caches.Select(c => c.Id).ToList(),
            DateTime.UtcNow, DateTime.UtcNow, null, null);

        foreach (var cache in caches)
        {
            snapshot.Caches[cache.Id] = cache;
        }

        return snapshot;
    }

    private static CacheReadDto Cache(string root, params (string Key, string Value)[] items)
    {
        var dto = new CacheReadDto(
            Guid.NewGuid(), $"cache-{root}", "1.0.0", null, root, items.Length, DateTime.UtcNow, DateTime.UtcNow, null, null);
        return dto;
    }

    [Fact]
    public void EveryCacheOnTheWorkflowReachesTheDefinitionAsARef()
    {
        var a = Cache("sk-whitelist", ("acme", "1"));
        var b = Cache("other-list", ("beta", "2"));
        using var snapshot = Snapshot(a, b);

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);

        Assert.Equal(
            new[] { new CacheRefL1(b.Id, "other-list"), new CacheRefL1(a.Id, "sk-whitelist") }.OrderBy(r => r.Root, StringComparer.Ordinal),
            definition.CacheRefs!.OrderBy(r => r.Root, StringComparer.Ordinal));
    }

    [Fact]
    public void TheDefinitionCarriesNoInlineItems()
    {
        using var snapshot = Snapshot(Cache("sk-whitelist", ("acme", "1"), ("alphabeta", "2")));

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);

        Assert.Empty(definition.Caches);
        Assert.Single(definition.CacheRefs!);
    }

    [Fact]
    public void AnEmptyCacheIsStillARef()
    {
        // "Allow nothing" is a legitimate configuration. Dropping the cache here would make it
        // indistinguishable from a workflow that named no cache at all.
        using var snapshot = Snapshot(Cache("sk-whitelist"));

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);

        Assert.Single(definition.CacheRefs!);
    }

    [Fact]
    public void AWorkflowWithNoCachesProducesAnEmptyList()
    {
        // Empty, never null — the writer enumerates this without a guard.
        using var snapshot = Snapshot();

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);

        Assert.Empty(definition.Caches);
        Assert.Empty(definition.CacheRefs!);
    }

    [Fact]
    public void ACacheIdNamingNoLoadedRowIsSkippedRatherThanThrowing()
    {
        // Defensive, matching how the loader's other lookups behave: the foreign key makes this
        // unreachable, and a throw here would turn an impossible state into a failed start.
        using var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
        snapshot.Workflows[W] = new WorkflowReadDto(
            W, "wf", "1.0.0", null, [], [], [Guid.NewGuid()],
            DateTime.UtcNow, DateTime.UtcNow, null, null);

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);

        Assert.Empty(definition.CacheRefs!);
    }

    [Fact]
    public void TheSnapshotClearsItsCachesOnDispose()
    {
        var snapshot = Snapshot(Cache("sk-whitelist", ("acme", "1")));

        snapshot.Dispose();

        Assert.Empty(snapshot.Caches);
    }
}

using BaseApi.Service.Features.Orchestration.Projection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// The sweep that reclaims instance-index members whose per-instance key has expired.
/// <para>
/// The store is a real in-memory implementation rather than a recording double, so these assert what
/// the index actually contains after a sweep. A double would only prove which calls were made, which
/// is the part that cannot be wrong in an interesting way.
/// </para>
/// </summary>
public sealed class L2OrphanSweeperTests
{
    /// <summary>
    /// In-memory stand-in with the semantics that matter: membership sets, live per-instance keys, and
    /// a conditional removal that consults the keys at the moment it removes.
    /// </summary>
    private sealed class FakeStore : IL2InstanceIndexStore
    {
        public Dictionary<string, HashSet<string>> Index { get; } = new();
        public HashSet<string> LiveKeys { get; } = new();
        public HashSet<string> FaultingIndexes { get; } = new();

        /// <summary>Runs just before a conditional removal, so a test can simulate a replica returning.</summary>
        public Action<string, string>? BeforeRemove { get; set; }

        public Task<IReadOnlyList<string>> ListIndexKeysAsync(CancellationToken ct)
            => Task.FromResult<IReadOnlyList<string>>(Index.Keys.ToList());

        public Task<IReadOnlyList<string>> ListMembersAsync(string indexKey, CancellationToken ct)
        {
            if (FaultingIndexes.Contains(indexKey)) throw new InvalidOperationException("store fault");
            return Task.FromResult<IReadOnlyList<string>>(Index[indexKey].ToList());
        }

        public Task<bool> TryRemoveIfAbsentAsync(string indexKey, string instanceId, CancellationToken ct)
        {
            BeforeRemove?.Invoke(indexKey, instanceId);
            if (LiveKeys.Contains($"{indexKey}:{instanceId}")) return Task.FromResult(false);
            return Task.FromResult(Index[indexKey].Remove(instanceId));
        }
    }

    private static L2OrphanSweeper Sweeper(FakeStore store)
        => new(store, NullLogger<L2OrphanSweeper>.Instance);

    private static FakeStore StoreWith(string index, params (string Instance, bool Live)[] replicas)
    {
        var store = new FakeStore { Index = { [index] = replicas.Select(r => r.Instance).ToHashSet() } };
        foreach (var (instance, live) in replicas.Where(r => r.Live))
        {
            store.LiveKeys.Add($"{index}:{instance}");
        }
        return store;
    }

    [Fact]
    public async Task RemovesAMemberWhoseKeyHasExpired()
    {
        var store = StoreWith("skp:proc:p1", ("dead", false));

        var removed = await Sweeper(store).SweepAsync(TestContext.Current.CancellationToken);

        Assert.Equal(1, removed);
        Assert.Empty(store.Index["skp:proc:p1"]);
    }

    [Fact]
    public async Task KeepsAMemberWhoseKeyIsStillLive()
    {
        var store = StoreWith("skp:proc:p1", ("alive", true));

        var removed = await Sweeper(store).SweepAsync(TestContext.Current.CancellationToken);

        Assert.Equal(0, removed);
        Assert.Equal(["alive"], store.Index["skp:proc:p1"]);
    }

    [Fact]
    public async Task ReclaimsOnlyTheDeadMembersOfAMixedIndex()
    {
        // The real shape: some replicas running, some pods long gone.
        var store = StoreWith("skp:proc:p1", ("alive", true), ("dead1", false), ("dead2", false));

        var removed = await Sweeper(store).SweepAsync(TestContext.Current.CancellationToken);

        Assert.Equal(2, removed);
        Assert.Equal(["alive"], store.Index["skp:proc:p1"]);
    }

    [Fact]
    public async Task SweepsEveryProcessorIndex()
    {
        var store = StoreWith("skp:proc:p1", ("dead", false));
        store.Index["skp:proc:p2"] = ["gone", "here"];
        store.LiveKeys.Add("skp:proc:p2:here");

        var removed = await Sweeper(store).SweepAsync(TestContext.Current.CancellationToken);

        Assert.Equal(2, removed);
        Assert.Empty(store.Index["skp:proc:p1"]);
        Assert.Equal(["here"], store.Index["skp:proc:p2"]);
    }

    [Fact]
    public async Task DoesNotEvictAReplicaThatComesBackDuringTheSweep()
    {
        // The race the conditional removal exists for: the member looks dead when listed, then its
        // replica re-registers before the removal runs. The condition is evaluated at removal time, so
        // the membership must survive.
        var store = StoreWith("skp:proc:p1", ("restarting", false));
        store.BeforeRemove = (index, instance) => store.LiveKeys.Add($"{index}:{instance}");

        var removed = await Sweeper(store).SweepAsync(TestContext.Current.CancellationToken);

        Assert.Equal(0, removed);
        Assert.Equal(["restarting"], store.Index["skp:proc:p1"]);
    }

    [Fact]
    public async Task OneFailingIndexDoesNotAbortTheRest()
    {
        // A sweep is best-effort housekeeping on a background loop. A fault on one processor must not
        // cost every processor after it in the iteration.
        var store = StoreWith("skp:proc:bad", ("dead", false));
        store.FaultingIndexes.Add("skp:proc:bad");
        store.Index["skp:proc:good"] = ["dead"];

        var removed = await Sweeper(store).SweepAsync(TestContext.Current.CancellationToken);

        Assert.Equal(1, removed);
        Assert.Empty(store.Index["skp:proc:good"]);
    }

    [Fact]
    public async Task AnIndexOfOnlyLiveReplicasIsLeftUntouched()
    {
        var store = StoreWith("skp:proc:p1", ("a", true), ("b", true));

        var removed = await Sweeper(store).SweepAsync(TestContext.Current.CancellationToken);

        Assert.Equal(0, removed);
        Assert.Equal(2, store.Index["skp:proc:p1"].Count);
    }
}

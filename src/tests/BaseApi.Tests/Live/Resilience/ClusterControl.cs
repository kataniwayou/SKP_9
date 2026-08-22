using System.Globalization;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// The three fault levers, and the restores that must outlive any failure.
/// <para>
/// <b>NetworkPolicy is not among them, and that is a finding rather than a preference.</b> The kind
/// cluster's kindnetd runs with no --network-policy argument: a deny-all-egress policy is accepted by
/// the API server and enforced by nothing. A scenario built on it would inject no fault, observe an
/// uninterrupted happy path, and pass — which is the worst failure available to a resilience suite.
/// </para>
/// <para>
/// <b>CLIENT PAUSE expires on its own deadline</b>, so a killed or crashed run cannot leave Redis
/// wedged. That is why it is re-issued on a keepalive rather than set once for the whole window: a
/// single long pause would lapse early if the scenario overran, silently shortening the outage.
/// </para>
/// </summary>
internal static class ClusterControl
{
    /// <summary>Re-issued well inside the pause it renews, so a slow kubectl cannot leave a gap.</summary>
    private static readonly TimeSpan KeepaliveInterval = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan KeepalivePause = TimeSpan.FromSeconds(45);

    public static async Task PauseRedisAsync(TimeSpan duration, CancellationToken ct) =>
        await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "exec", "redis-0", "--", "redis-cli",
            "CLIENT", "PAUSE",
            ((long)duration.TotalMilliseconds).ToString(CultureInfo.InvariantCulture), "ALL");

    public static async Task UnpauseRedisAsync(CancellationToken ct) =>
        await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "exec", "redis-0", "--", "redis-cli", "CLIENT", "UNPAUSE");

    public static async Task ScaleAsync(string kind, string name, int replicas, CancellationToken ct) =>
        await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "scale", $"{kind}/{name}",
            $"--replicas={replicas.ToString(CultureInfo.InvariantCulture)}");

    /// <summary>
    /// Blocks until every replica of a workload reports ready. Both StatefulSets here declare a
    /// readiness probe and no liveness probe, so ready is the only signal that the dependency is
    /// answering again — and rollout status is the only way to learn it without polling by hand.
    /// </summary>
    public static async Task WaitForReadyAsync(
        string kind, string name, TimeSpan budget, CancellationToken ct) =>
        await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "rollout", "status", $"{kind}/{name}",
            $"--timeout={((int)budget.TotalSeconds).ToString(CultureInfo.InvariantCulture)}s");

    /// <summary>
    /// Holds Redis paused until disposed, renewing the pause on a keepalive.
    /// <para>
    /// Disposal releases it explicitly rather than waiting the pause out, so the heal is at a moment
    /// the scenario chose. Even if disposal never runs, the pause lapses on its own — the property
    /// that made this the lever rather than a policy or a scale-down.
    /// </para>
    /// </summary>
    public static async Task<IAsyncDisposable> HoldRedisPausedAsync(CancellationToken ct)
    {
        await PauseRedisAsync(KeepalivePause, ct);
        return new RedisPause();
    }

    /// <summary>Scales a workload to zero and restores it on disposal.</summary>
    public static async Task<IAsyncDisposable> HoldScaledDownAsync(
        string kind, string name, int restoreTo, CancellationToken ct)
    {
        await ScaleAsync(kind, name, 0, ct);
        return new ScaledDown(kind, name, restoreTo);
    }

    private sealed class RedisPause : IAsyncDisposable
    {
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _keepalive;

        /// <summary>
        /// The keepalive runs on its own token, not the scenario's. Releasing the pause is the one
        /// thing that must still happen when the scenario is cancelled.
        /// </summary>
        public RedisPause() => _keepalive = KeepAliveAsync(_stop.Token);

        public async ValueTask DisposeAsync()
        {
            try
            {
                await _stop.CancelAsync();

                try
                {
                    await _keepalive;
                }
                catch (Exception)
                {
                    // The keepalive's own failure must not decide whether Redis gets released, and
                    // must never replace the exception that is already unwinding the scenario. A
                    // nonzero kubectl exit here is entirely plausible on a live cluster mid-fault --
                    // RunOrThrowAsync throws on it -- and swallowing only OperationCanceledException
                    // would let that throw skip the explicit release below and masquerade as the
                    // scenario's own failure. The pause it was renewing self-expires regardless of
                    // which way this exits; what matters is that the release still runs.
                }
            }
            finally
            {
                _stop.Dispose();

                // Its own token: the scenario's may already be cancelled, and a release that skipped
                // because the run was aborted is exactly the case the release exists for.
                using var release = new CancellationTokenSource(TimeSpan.FromMinutes(1));
                await UnpauseRedisAsync(release.Token);
            }
        }

        private static async Task KeepAliveAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(KeepaliveInterval, ct);
                await PauseRedisAsync(KeepalivePause, ct);
            }
        }
    }

    private sealed class ScaledDown : IAsyncDisposable
    {
        private readonly string _kind;
        private readonly string _name;
        private readonly int _restoreTo;

        public ScaledDown(string kind, string name, int restoreTo)
        {
            _kind = kind;
            _name = name;
            _restoreTo = restoreTo;
        }

        public async ValueTask DisposeAsync()
        {
            using var restore = new CancellationTokenSource(TimeSpan.FromMinutes(6));

            // The scale-back is the first statement in this method and nothing precedes it that
            // could throw and skip it -- that is deliberate, not incidental, and any future addition
            // to this disposer must keep it that way rather than move work ahead of the restore.
            // WaitForReadyAsync runs after, left unguarded: a rollout timeout there is real
            // information -- the workload was told to come back and did not -- so it must surface
            // rather than being swallowed the way the keepalive's own failure is swallowed in
            // RedisPause, where nothing downstream depends on the keepalive having succeeded.
            await ScaleAsync(_kind, _name, _restoreTo, restore.Token);
            await WaitForReadyAsync(_kind, _name, TimeSpan.FromMinutes(5), restore.Token);
        }
    }
}

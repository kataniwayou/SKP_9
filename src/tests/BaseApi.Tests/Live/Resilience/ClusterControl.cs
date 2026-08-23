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
/// <para>
/// <b>CLIENT UNPAUSE does not cancel an outstanding pause — it blocks until that pause expires.</b>
/// Measured directly against this cluster: issuing <c>CLIENT PAUSE 45000 ALL</c> and then, over a
/// brand-new connection, <c>CLIENT UNPAUSE</c>, the unpause itself took ~45 seconds to return — the
/// full remaining duration of the pause it was supposedly cancelling, not the near-instant reply a
/// name like "unpause" implies. That single fact sets every budget below. S2 never noticed because
/// nothing else was queued ahead of its release call. S4 did, reproducibly: RabbitMQ's own restore
/// (bounded only by how long its pod takes to become ready, which is unbounded by design) runs to
/// completion first, and the keepalive keeps renewing the Redis pause the entire time it does — so
/// by the time Redis's release finally runs, the most recent keepalive pause can still have nearly
/// its full duration left to expire, and the release has to wait that out before CLIENT UNPAUSE
/// returns at all. A 45-second pause against a 60-second release budget left no margin once real
/// cluster latency (a StatefulSet pod that just became ready is not yet fully settled) was added on
/// top, and the release timed out. The numbers below were chosen to fix that: the keepalive interval
/// and pause were shortened together, keeping the 3x renewal margin that stops the pause lapsing
/// mid-window, while cutting the worst-case wait a release can be stuck behind from ~45s to ~24s —
/// and the release's own budget was widened to two minutes, five times that worst case rather than a
/// number the old 45-second pause left almost no room inside. This also improves the property that
/// made CLIENT PAUSE the chosen lever to begin with: a killed or crashed run now leaves at most 24
/// seconds of pause behind instead of 45.
/// </para>
/// </summary>
internal static class ClusterControl
{
    /// <summary>
    /// Re-issued well inside the pause it renews (a 3x margin: 24s pause, 8s interval), so a slow
    /// kubectl cannot leave a gap. Shortened from 15s/45s alongside <see cref="KeepalivePause"/> —
    /// see the class remarks for why: a release that follows a RabbitMQ restore can still be stuck
    /// waiting out most of whatever pause the last keepalive renewed, since CLIENT UNPAUSE does not
    /// cancel it outright.
    /// </summary>
    private static readonly TimeSpan KeepaliveInterval = TimeSpan.FromSeconds(8);

    /// <summary>
    /// Shortened from 45s to 24s. The renewal margin is preserved (3x <see cref="KeepaliveInterval"/>),
    /// but the number that actually matters here is the worst case a release can be stuck behind:
    /// since CLIENT UNPAUSE blocks until the outstanding pause expires rather than cancelling it (see
    /// the class remarks), a shorter pause directly bounds how long
    /// <see cref="RedisPause.DisposeAsync"/> can be made to wait — from ~45s down to ~24s — against a
    /// release budget five times that size.
    /// </summary>
    private static readonly TimeSpan KeepalivePause = TimeSpan.FromSeconds(24);

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

    /// <summary>Scales a workload to a non-zero replica count and restores it on disposal.</summary>
    /// <remarks>
    /// Separate from <see cref="HoldScaledDownAsync"/> rather than a parameter on it, because the two
    /// mean different things to a reader: that one takes a dependency away, this one takes away
    /// SOME of it. A scenario that scaled "to zero, but one" would read as a mistake.
    /// </remarks>
    public static async Task<IAsyncDisposable> HoldScaledToAsync(
        string kind, string name, int to, int restoreTo, CancellationToken ct)
    {
        if (to <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(to), to, "use HoldScaledDownAsync to take a workload away entirely");
        }

        await ScaleAsync(kind, name, to, ct);
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
                // because the run was aborted is exactly the case the release exists for. Two
                // minutes, not one: CLIENT UNPAUSE blocks until the outstanding pause expires rather
                // than cancelling it (see the class remarks), so this budget has to clear the worst
                // case a KeepalivePause-length wait plus real cluster latency can impose, not just
                // the exec call's own round trip.
                using var release = new CancellationTokenSource(TimeSpan.FromMinutes(2));
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

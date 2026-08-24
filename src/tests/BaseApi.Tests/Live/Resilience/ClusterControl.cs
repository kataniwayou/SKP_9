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

    /// <summary>
    /// How often a disconnected replica's returning connection is closed again.
    /// <para>
    /// The client reconnects on its own, so this is not a one-shot fault: it has to be re-applied
    /// for as long as the wedge is meant to last. Five seconds against two kubectl execs per pass
    /// (~1-2s each) keeps the loop ahead of a client that reconnects immediately.
    /// </para>
    /// </summary>
    private static readonly TimeSpan DisconnectInterval = TimeSpan.FromSeconds(5);

    /// <summary>
    /// The Erlang pids of every connection a given peer host holds, from
    /// <c>rabbitmqctl -q list_connections pid name peer_host</c>.
    /// </summary>
    /// <remarks>
    /// <b>The host match is exact, and that is the whole reason this is a separate function.</b>
    /// Pod IPs on this cluster share prefixes -- <c>10.244.0.20</c> is a prefix of
    /// <c>10.244.0.205</c> -- so a StartsWith or Contains match would disconnect a replica the
    /// scenario did not name, or every replica at once, which is the broker-gone scenario rather
    /// than this one. A scenario that injects the wrong fault and still passes is the worst failure
    /// a resilience suite has available, so the parse is unit-tested away from the cluster.
    /// <para>
    /// The header row is skipped by its own content rather than by position, because <c>-q</c>
    /// suppresses the "Listing connections ..." preamble but not the column names.
    /// </para>
    /// </remarks>
    public static IReadOnlyList<string> ParseConnectionPids(string listOutput, string peerHost)
    {
        ArgumentNullException.ThrowIfNull(listOutput);

        var pids = new List<string>();
        foreach (var raw in listOutput.Split('\n'))
        {
            var columns = raw.Trim('\r').Split('\t');
            if (columns.Length < 3)
            {
                continue;
            }

            if (!string.Equals(columns[2].Trim(), peerHost, StringComparison.Ordinal))
            {
                continue;
            }

            if (string.Equals(columns[0], "pid", StringComparison.Ordinal))
            {
                continue;
            }

            pids.Add(columns[0]);
        }

        return pids;
    }

    /// <summary>
    /// Disconnects ONE processor replica from the broker and keeps it disconnected until disposed.
    /// <para>
    /// <b>The fault the suite could not previously inject.</b> Every other lever here takes a
    /// dependency away entirely, or takes a replica away entirely. This one leaves the replica
    /// running, serving HTTP and exporting metrics, and interferes only with its consumer -- which
    /// is the difference between a replica that LEFT and a replica that STOPPED WORKING.
    /// <c>Consuming by queue and replica</c> is the only panel that can resolve it.
    /// </para>
    /// <para>
    /// <b>SIGSTOP is not the way in, and that negative result is why this lever exists.</b> The
    /// processor image is distroless and carries no <c>kill</c>; an ephemeral debug container does
    /// share the PID namespace and can signal PID 1, but a frozen process stops exporting metrics
    /// too, so Prometheus cannot tell it from a departure -- the case the per-replica panels
    /// already cover. The broker can disconnect one consumer while its process carries on.
    /// </para>
    /// <para>
    /// <b>Self-healing, which is why this lever and not another.</b> Nothing is mutated that has to
    /// be put back: a killed or crashed run simply stops closing the connection and the client
    /// reconnects on its own. That is the same property that made CLIENT PAUSE the Redis lever
    /// rather than a scale-down.
    /// </para>
    /// </summary>
    public static async Task<IAsyncDisposable> HoldOneProcessorDisconnectedAsync(CancellationToken ct)
    {
        var (pod, ip) = await FirstProcessorPodAsync(ct);
        await CloseConnectionsFromAsync(ip, ct);
        return new Disconnected(pod, ip);
    }

    /// <summary>
    /// The processor replica this scenario will disconnect: first by name, so a re-run picks the
    /// same one whenever the pod set is unchanged.
    /// </summary>
    /// <remarks>
    /// Requires at least two replicas, and says so rather than proceeding. Disconnecting the only
    /// replica would be the processor-unavailable scenario wearing a different lever, and the whole
    /// point here is that a healthy peer keeps working beside the wedged one.
    /// </remarks>
    private static async Task<(string Pod, string Ip)> FirstProcessorPodAsync(CancellationToken ct)
    {
        var raw = await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "get", "pods", "-l", "app=processor-sample",
            "-o", "jsonpath={range .items[*]}{.metadata.name} {.status.podIP}{\"\\n\"}{end}");

        var pods = new List<(string Pod, string Ip)>();
        foreach (var line in raw.Split('\n'))
        {
            var columns = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (columns.Length == 2)
            {
                pods.Add((columns[0], columns[1]));
            }
        }

        pods.Sort((a, b) => string.CompareOrdinal(a.Pod, b.Pod));

        if (pods.Count < 2)
        {
            throw new InvalidOperationException(
                "the wedge scenario needs at least two processor replicas carrying pod IPs; found "
                + pods.Count.ToString(CultureInfo.InvariantCulture)
                + ". Wedging the only replica is the processor-unavailable scenario, not this one.");
        }

        return pods[0];
    }

    /// <summary>Closes every connection the given peer host holds, and reports how many there were.</summary>
    private static async Task<int> CloseConnectionsFromAsync(string peerHost, CancellationToken ct)
    {
        var listing = await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "exec", "rabbitmq-0", "--",
            "rabbitmqctl", "-q", "list_connections", "pid", "name", "peer_host");

        var pids = ParseConnectionPids(listing, peerHost);
        foreach (var pid in pids)
        {
            // close_connection takes the Erlang PID, not the connection name -- verified against
            // RabbitMQ 4.1.8 on this cluster, where the name is rejected.
            await Kubectl.RunOrThrowAsync(
                ct, "-n", Chaos.Namespace, "exec", "rabbitmq-0", "--",
                "rabbitmqctl", "close_connection", pid, "skp chaos: wedged replica scenario");
        }

        return pids.Count;
    }

    /// <summary>Blocks until the given peer host holds a broker connection again.</summary>
    private static async Task WaitForConnectionAsync(string peerHost, CancellationToken ct)
    {
        while (true)
        {
            ct.ThrowIfCancellationRequested();

            var listing = await Kubectl.RunOrThrowAsync(
                ct, "-n", Chaos.Namespace, "exec", "rabbitmq-0", "--",
                "rabbitmqctl", "-q", "list_connections", "pid", "name", "peer_host");

            if (ParseConnectionPids(listing, peerHost).Count > 0)
            {
                return;
            }

            await Task.Delay(TimeSpan.FromSeconds(2), ct);
        }
    }

    /// <summary>The toxiproxy proxy the processor's Redis connection string points at.</summary>
    private const string RedisProxy = "redis";

    /// <summary>
    /// The toxic this suite owns. Named rather than anonymous so a stale one left by a killed run
    /// can be found and cleared on the next entry.
    /// </summary>
    private const string SlowToxic = "skp-slow";

    /// <summary>
    /// Makes Redis slow for the processor -- and only for the processor -- until disposed.
    /// <para>
    /// <b>The fault class every other scenario here misses.</b> The rest remove something entirely;
    /// this one leaves Redis working and merely late. Which band matters is decided by a number
    /// already in the code: <c>L2GateOptions.ProbeTimeout</c> is 2 seconds, probed every 5. Below
    /// it the gate should stay open and the question is whether anything on the boards moves at
    /// all; above it the probe fails, and the question is whether that is distinguishable from
    /// Redis being absent.
    /// </para>
    /// <para>
    /// <b>Downstream only.</b> The toxic delays Redis's replies rather than the requests, which is
    /// what "slow dependency" means from the client's side and adds the full latency to every
    /// round trip exactly once. Delaying both directions would double it for no extra realism.
    /// </para>
    /// <para>
    /// <b>This lever is NOT self-healing, and that is its one weakness against CLIENT PAUSE.</b> A
    /// toxic has no expiry: a killed run leaves Redis slow indefinitely. Two things compensate --
    /// entry clears a stale toxic of the same name before adding its own, so a previous casualty
    /// cannot poison this run, and disposal verifies the removal actually took rather than assuming
    /// the call worked.
    /// </para>
    /// </summary>
    public static async Task<IAsyncDisposable> HoldRedisSlowAsync(TimeSpan latency, CancellationToken ct)
    {
        var pod = await ToxiproxyPodAsync(ct);

        // Tolerant: `toxic remove` exits 1 with `HTTP 404: toxic not found` when there is nothing
        // to remove, which is the normal case and not a failure.
        await RemoveSlowToxicAsync(pod, ct);

        await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "exec", pod, "--",
            "/toxiproxy-cli", "toxic", "add",
            "-t", "latency",
            "-a", "latency=" + ((long)latency.TotalMilliseconds).ToString(CultureInfo.InvariantCulture),
            "-n", SlowToxic,
            // The proxy name comes LAST: the CLI parses options before the positional argument, and
            // putting the name first fails with "Required argument 'type' was empty", which reads
            // like a missing flag rather than a misplaced one.
            RedisProxy);

        return new RedisSlow(pod);
    }

    private static async Task<string> ToxiproxyPodAsync(CancellationToken ct)
    {
        var raw = await Kubectl.RunOrThrowAsync(
            ct, "-n", Chaos.Namespace, "get", "pods", "-l", "app=toxiproxy",
            "-o", "jsonpath={.items[0].metadata.name}");

        var pod = raw.Trim();
        if (pod.Length == 0)
        {
            throw new InvalidOperationException(
                "no toxiproxy pod found; the processor's Redis connection string points at it, so "
                + "the pipeline is not running either. Apply k8s/13-toxiproxy.yaml.");
        }

        return pod;
    }

    /// <summary>Removes this suite's toxic, tolerating its absence.</summary>
    private static async Task RemoveSlowToxicAsync(string pod, CancellationToken ct) =>
        await Kubectl.RunAsync(
            ct, "-n", Chaos.Namespace, "exec", pod, "--",
            "/toxiproxy-cli", "toxic", "remove", "-n", SlowToxic, RedisProxy);

    /// <summary>Holds the latency toxic, and on disposal proves it is gone rather than assuming.</summary>
    private sealed class RedisSlow : IAsyncDisposable
    {
        private readonly string _pod;

        public RedisSlow(string pod) => _pod = pod;

        public async ValueTask DisposeAsync()
        {
            // Its own token: the scenario's may already be cancelled, and a release skipped because
            // the run was aborted is exactly the case this release exists for. Nothing here expires
            // on its own, so a skipped release leaves the stack degraded until somebody notices.
            using var release = new CancellationTokenSource(TimeSpan.FromMinutes(2));

            await RemoveSlowToxicAsync(_pod, release.Token);

            // Verified, not assumed. The remove is issued tolerantly because a 404 is normal, which
            // means a genuine failure would also pass quietly -- so the state is read back.
            var inspect = await Kubectl.RunOrThrowAsync(
                release.Token, "-n", Chaos.Namespace, "exec", _pod, "--",
                "/toxiproxy-cli", "inspect", RedisProxy);

            if (inspect.Contains(SlowToxic, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"the '{SlowToxic}' toxic is still on proxy '{RedisProxy}' after removal; Redis "
                    + "is still slow for the processor and will stay that way, because a toxic has "
                    + $"no expiry. Clear it by hand: kubectl exec -n {Chaos.Namespace} {_pod} -- "
                    + $"/toxiproxy-cli toxic remove -n {SlowToxic} {RedisProxy}");
            }
        }
    }

    /// <summary>Keeps one replica disconnected, and on disposal waits for it to reconnect.</summary>
    private sealed class Disconnected : IAsyncDisposable
    {
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _keepalive;
        private readonly string _pod;
        private readonly string _ip;

        public Disconnected(string pod, string ip)
        {
            _pod = pod;
            _ip = ip;

            // Its own token, for the reason RedisPause documents: stopping the fault is the one
            // thing that must still happen when the scenario is cancelled.
            _keepalive = KeepClosedAsync(ip, _stop.Token);
        }

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
                    // The keepalive's own failure must not replace the exception already unwinding
                    // the scenario, and must not skip the wait below. Nothing needs undoing either
                    // way: once this loop stops, the client reconnects on its own.
                }
            }
            finally
            {
                _stop.Dispose();

                // Left to surface, the way ScaledDown leaves its rollout wait unguarded: a replica
                // that never reconnects once nothing is closing it is real information -- the wedge
                // outlived the fault, which is the failure mode this scenario exists to look for.
                using var restore = new CancellationTokenSource(TimeSpan.FromMinutes(2));
                try
                {
                    await WaitForConnectionAsync(_ip, restore.Token);
                }
                catch (OperationCanceledException)
                {
                    throw new InvalidOperationException(
                        $"{_pod} ({_ip}) did not reconnect to the broker within two minutes of the "
                        + "fault being released; the wedge outlived the fault.");
                }
            }
        }

        private static async Task KeepClosedAsync(string ip, CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(DisconnectInterval, ct);
                await CloseConnectionsFromAsync(ip, ct);
            }
        }
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

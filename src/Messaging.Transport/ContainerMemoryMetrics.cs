using System.Diagnostics.Metrics;

namespace Messaging.Transport;

/// <summary>
/// The memory the CONTAINER is charged for, its limit, and the process's own working set and OS
/// threads -- what the GC instruments cannot say.
/// <para>
/// <b>Why this exists (2026-11-28).</b> The kafka-importer ran out of memory at its 384Mi limit while
/// every panel showed only the managed heap. The figure the kernel's OOM decision compares to the
/// limit is the cgroup's charge, which also holds native allocations, the runtime's committed but
/// unused heap, and page cache; and Prometheus here scrapes only what the processes report, with no
/// cAdvisor or kube-state-metrics behind it. A process reading its own cgroup is the one source that
/// works in dev and in an org-owned production Prometheus alike.
/// </para>
/// <para>
/// <b>Container figures come from the cgroup, not the process.</b> Resident memory (working set) is
/// reported too, but it is NOT what the limit is enforced against: on 2026-11-28 a file-fetcher
/// showed 139 MiB resident and an 83 MiB charge, because mapped shared libraries count toward RSS
/// and not, or not wholly, toward the charge. The memory-vs-limit panels use the charge.
/// </para>
/// <para>
/// <b>cgroup v2 first, then v1.</b> v2 exposes <c>memory.current</c>, <c>memory.max</c> and the
/// <c>anon</c> line of <c>memory.stat</c>; v1 exposes <c>memory/memory.usage_in_bytes</c>,
/// <c>memory/memory.limit_in_bytes</c> and the <c>rss</c> line. Which one a cluster runs is the
/// node's choice, not ours, so both are read.
/// </para>
/// <para>
/// <b>Nothing is reported that was not read.</b> Off Linux, outside a container, or with a file
/// missing or unparseable, that instrument reports no measurement rather than a zero: a zero
/// would draw as "no memory used". An unlimited container (<c>max</c> on v2, or the v1 sentinel of
/// a value beyond any real host) reports no limit, so the panels show no limit line rather than
/// one at 8 EiB.
/// </para>
/// </summary>
public static class ContainerMemoryMetrics
{
    /// <summary>
    /// Must match the string passed to <c>AddMeter</c> in <c>AddBaseConsoleObservability</c>. A
    /// typo'd meter name produces no error and no metrics.
    /// </summary>
    public const string MeterName = "Messaging.Transport.ContainerMemory";

    /// <summary>The cgroup's memory charge, bytes: what the OOM decision compares to the limit.</summary>
    public const string ChargeInstrument = "pipeline.container.memory";

    /// <summary>The cgroup's memory limit, bytes. Absent when the container is unlimited.</summary>
    public const string LimitInstrument = "pipeline.container.memory.limit";

    /// <summary>The anonymous part of the charge, bytes: memory the processes allocated, not file cache.</summary>
    public const string AnonInstrument = "pipeline.container.memory.anon";

    /// <summary>The process's resident memory, bytes. For comparison only; see the class note.</summary>
    public const string WorkingSetInstrument = "pipeline.process.working_set";

    /// <summary>The process's OS threads, not only the thread pool's.</summary>
    public const string ThreadsInstrument = "pipeline.process.threads";

    /// <summary>Where cgroup files are read. The real root; tests read <see cref="Read"/> with their own.</summary>
    public const string DefaultCgroupRoot = "/sys/fs/cgroup";

    // v1's "no limit" is LONG_MAX rounded down to the page size. Anything above this is no real
    // host's memory, so it is treated as no limit rather than drawn.
    private const long UnlimitedAbove = 1L << 60;

    private static readonly Meter Meter = new(MeterName);

    static ContainerMemoryMetrics()
    {
        // Registered once, in the static constructor; the Meter owns the instruments and the
        // callbacks keep them alive. Each callback reads only its own file, so one unreadable file
        // costs one instrument, not all five.
        Meter.CreateObservableGauge(ChargeInstrument, () => Observe(ReadCharge(DefaultCgroupRoot)),
            unit: "By", description: "Memory charged to this container's cgroup: what the limit is enforced against.");
        Meter.CreateObservableGauge(LimitInstrument, () => Observe(ReadLimit(DefaultCgroupRoot)),
            unit: "By", description: "This container's cgroup memory limit. Not reported when unlimited.");
        Meter.CreateObservableGauge(AnonInstrument, () => Observe(ReadAnon(DefaultCgroupRoot)),
            unit: "By", description: "Anonymous memory in this container's cgroup charge (allocations, not file cache).");
        Meter.CreateObservableGauge(WorkingSetInstrument, () => Observe(Environment.WorkingSet),
            unit: "By", description: "This process's resident memory. Not what the container limit is enforced against.");
        Meter.CreateObservableGauge(ThreadsInstrument, () => Observe(ReadThreads()),
            unit: "{thread}", description: "This process's OS threads, the thread pool's and every other.");
    }

    /// <summary>One reading of the container figures from <paramref name="root"/>; null where unreadable.</summary>
    public sealed record Reading(long? Charge, long? Limit, long? Anon);

    /// <summary>Reads all three container figures from a cgroup root. Never throws.</summary>
    public static Reading Read(string root) => new(ReadCharge(root), ReadLimit(root), ReadAnon(root));

    /// <summary>
    /// Makes sure the instruments are registered. Calling any member does this; the host calls this
    /// one by name so the dependency is visible where the meter is added.
    /// </summary>
    public static void EnsureRegistered()
    {
    }

    private static long? ReadCharge(string root)
        => ReadNumber(Path.Combine(root, "memory.current"))
           ?? ReadNumber(Path.Combine(root, "memory", "memory.usage_in_bytes"));

    private static long? ReadLimit(string root)
    {
        var limit = ReadNumber(Path.Combine(root, "memory.max"))
                    ?? ReadNumber(Path.Combine(root, "memory", "memory.limit_in_bytes"));
        return limit is > 0 and <= UnlimitedAbove ? limit : null;   // "max" parses as null already
    }

    private static long? ReadAnon(string root)
        => ReadStat(Path.Combine(root, "memory.stat"), "anon")
           ?? ReadStat(Path.Combine(root, "memory", "memory.stat"), "rss");

    private static long? ReadThreads()
    {
        // /proc/self/status is one small read on Linux; Process.Threads would allocate an object
        // per thread on every export.
        var status = ReadStat("/proc/self/status", "Threads:");
        if (status is not null)
        {
            return status;
        }

        try
        {
            using var self = System.Diagnostics.Process.GetCurrentProcess();
            return self.Threads.Count;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static long? ReadNumber(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            return long.TryParse(File.ReadAllText(path).Trim(), out var value) && value >= 0 ? value : null;
        }
        catch (Exception)
        {
            // A metrics callback must never throw into the SDK's collection loop.
            return null;
        }
    }

    /// <summary>The value on the line whose first field is <paramref name="key"/>, in a "key value" file.</summary>
    private static long? ReadStat(string path, string key)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            foreach (var line in File.ReadLines(path))
            {
                var fields = line.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
                if (fields.Length >= 2 && fields[0] == key && long.TryParse(fields[1], out var value) && value >= 0)
                {
                    return value;
                }
            }

            return null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static IEnumerable<Measurement<long>> Observe(long? value)
        => value is { } v ? [new Measurement<long>(v)] : [];
}

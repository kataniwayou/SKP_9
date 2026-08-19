namespace BaseConsole.Core.Messaging;

/// <summary>
/// This replica's own identity. A record rather than a bare string so a DI container can resolve it
/// as a constructor parameter — a bare <see cref="string"/> parameter is ambiguous to a container and
/// would fail to resolve at startup.
/// <para>
/// <b>One value, three uses.</b> It names the per-instance L2 liveness key
/// (<c>skp:proc:{processorId}:{instanceId}</c>), the exclusive reply queue
/// (<c>proc-reply-{instanceId}</c>), and the <c>service.instance.id</c> resource attribute on this
/// process's logs and metrics. They must be the same string: if they diverge, a liveness key cannot
/// be traced back to the pod that wrote it, and that is precisely the correlation an operator needs
/// when one replica of several is misbehaving. Resolve it once, here, and share it.
/// </para>
/// </summary>
public sealed record InstanceId(string Value)
{
    public string Value { get; init; } = Validated(Value);

    /// <summary>
    /// Resolves the replica identity: the Kubernetes downward-API pod name first, then the container
    /// hostname, then the machine name, and a GUID only if all of those are somehow unavailable.
    /// <para>
    /// Blank is treated as absent rather than taken literally. An unset downward-API field arrives as
    /// an empty string, not a missing variable, and naming the liveness key after nothing would fail
    /// the constructor guard at a point far from the misconfiguration.
    /// </para>
    /// </summary>
    public static InstanceId Resolve()
    {
        var resolved = FirstNonBlank(
            Environment.GetEnvironmentVariable("POD_NAME"),
            Environment.GetEnvironmentVariable("HOSTNAME"),
            Environment.MachineName);

        return new InstanceId(resolved ?? Guid.NewGuid().ToString("N"));
    }

    private static string? FirstNonBlank(params string?[] candidates)
        => candidates.FirstOrDefault(c => !string.IsNullOrWhiteSpace(c));

    private static string Validated(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        return value;
    }
}

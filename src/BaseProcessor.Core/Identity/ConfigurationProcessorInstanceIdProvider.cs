using Microsoft.Extensions.Configuration;

namespace BaseProcessor.Core.Identity;

/// <summary>
/// Default <see cref="IProcessorInstanceIdProvider"/>: reads <c>Processor:InstanceId</c> from
/// configuration, which in a pod is the environment variable <c>Processor__InstanceId</c>.
/// <para>
/// <b>Deliberately not <see cref="BaseConsole.Core.Messaging.InstanceId"/>.</b> That one resolves
/// <c>POD_NAME → HOSTNAME → MachineName</c> and always produces something, which is right for naming
/// an exclusive reply queue and wrong for keying a durable row. Under a Deployment it is the random
/// pod suffix, regenerated on every restart: wiring it in here would make every processor running
/// today ask about an instance id no row has ever held, get not-found, and wait forever. Under a
/// StatefulSet it happens to be the stable ordinal name and would have worked — but a value that is
/// correct for one workload shape and silently fatal for the other is not a default, it is a trap.
/// </para>
/// <para>
/// So the pod says so explicitly or says nothing. A StatefulSet manifest sets the variable from the
/// downward API:
/// <code>
/// - name: Processor__InstanceId
///   valueFrom:
///     fieldRef:
///       fieldPath: metadata.name
/// </code>
/// and a Deployment leaves it unset, which is why this feature changes nothing for what is already
/// running.
/// </para>
/// </summary>
public sealed class ConfigurationProcessorInstanceIdProvider : IProcessorInstanceIdProvider
{
    /// <summary>The configuration key, stated once so the boot container and the host cannot drift.</summary>
    public const string Key = "Processor:InstanceId";

    private readonly string? _instanceId;

    public ConfigurationProcessorInstanceIdProvider(IConfiguration cfg)
    {
        ArgumentNullException.ThrowIfNull(cfg);

        // Read once at construction. The value cannot legitimately change while the process runs —
        // it is this pod's name — and re-reading would let a configuration reload move the identity
        // out from under a processor that has already declared its queues against it.
        var configured = cfg[Key];
        _instanceId = string.IsNullOrWhiteSpace(configured) ? null : configured.Trim();
    }

    public string? Get() => _instanceId;
}

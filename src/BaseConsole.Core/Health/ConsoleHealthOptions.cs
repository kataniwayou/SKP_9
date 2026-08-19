namespace BaseConsole.Core.Health;

/// <summary>
/// The health listener's configuration, bound from the <c>"ConsoleHealth"</c> section.
/// </summary>
public sealed class ConsoleHealthOptions
{
    /// <summary>
    /// Port for the probe listener (default 8081). Deliberately not the application port: a worker
    /// has no application port, and pinning probes to their own number keeps the kubelet's access
    /// independent of anything the process does. Zero lets the OS choose, which is for tests.
    /// </summary>
    public int Port { get; set; } = 8081;
}

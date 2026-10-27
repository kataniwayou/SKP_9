namespace Processor.EmsExporter.Ems;

/// <summary>
/// The org's EMS server, bound from the <c>"Ems"</c> config section, for the reason
/// <c>KafkaBrokerOptions</c> gives: the server is not the workflow author's to choose, and the
/// credential that authenticates to it arrives from a <c>secretKeyRef</c>, never a step payload.
/// </summary>
public sealed class EmsServerOptions
{
    /// <summary>
    /// One URL, or a comma-separated fault-tolerant list in EMS's own form:
    /// <c>tcp://ems-a:7222,tcp://ems-b:7222</c>. <c>ssl://</c> is accepted here; the trust settings
    /// it needs arrive with the real adapter.
    /// </summary>
    public string ServerUrl { get; set; } = "";

    /// <summary>Optional: a server that admits anonymous connections needs neither.</summary>
    public string? Username { get; set; }

    public string? Password { get; set; }

    /// <summary>
    /// The largest body this pod will send. EMS is built for small messages and the server enforces
    /// its own <c>max_msg_size</c>; checking here turns an obscure server rejection into a failure
    /// that names both numbers. 10 MiB by default — set it to the server's limit.
    /// </summary>
    public long MaxMessageBytes { get; set; } = 10 * 1024 * 1024;
}

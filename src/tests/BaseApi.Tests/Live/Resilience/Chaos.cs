using Xunit;

namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// The second switch, and the addresses the resilience scenarios use.
/// <para>
/// <b>Two gates, not one.</b> The existing Live tests read the cluster; these ones break it — they
/// pause Redis and scale StatefulSets to zero. Someone exporting SKP_REALSTACK=1 to run the seven
/// existing live tests is asking to talk to the stack, not to take it down, so chaos needs its own
/// consent. Both are read inside the test rather than expressed as a trait filter, for the reason
/// RealStack already documents: this runner accepts a --filter and silently ignores it.
/// </para>
/// </summary>
internal static class Chaos
{
    public const string Category = "Chaos";

    /// <summary>The data stream the collector's elasticsearch exporter writes into.</summary>
    public const string LogIndex = "logs-generic.otel-default";

    /// <summary>True only when the operator has thrown both switches.</summary>
    public static bool Enabled =>
        RealStack.Enabled && Environment.GetEnvironmentVariable("SKP_CHAOS") == "1";

    /// <summary>Skips the calling scenario unless both switches are set.</summary>
    public static void SkipUnlessEnabled() =>
        Assert.SkipUnless(Enabled,
            "set SKP_REALSTACK=1 and SKP_CHAOS=1, and run k8s/port-forward-realstack.ps1, "
            + "to run the resilience scenarios; they pause Redis and scale StatefulSets to zero");

    public static string ElasticUrl => RealStack.Get("SKP_ES_URL", "http://localhost:19200");
    public static string PrometheusUrl => RealStack.Get("SKP_PROM_URL", "http://localhost:19090");
    public static string Namespace => RealStack.Get("SKP_K8S_NAMESPACE", "skp");

    public static Guid WorkflowId =>
        Guid.Parse(RealStack.Get("SKP_WORKFLOW_ID", "4cd8af45-1295-43db-ab2e-e955dd82b5c5"));
}

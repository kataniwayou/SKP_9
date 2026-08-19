using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The switch and the addresses for tests that talk to the real cluster.
/// <para>
/// <b>The gate is an environment variable read inside the test, not a trait filter.</b> Under
/// Microsoft.Testing.Platform a <c>--filter "Category!=RealStack"</c> is accepted and silently
/// ignored, so a filter-only guard would let every live test run in what looked like a hermetic
/// pass — and fail against infrastructure that is not there. The trait is kept as well, for
/// selecting these tests deliberately, but it is not what makes them safe.
/// </para>
/// </summary>
public static class RealStack
{
    public const string Category = "RealStack";

    /// <summary>True only when an operator has opened the port-forwards and said so.</summary>
    public static bool Enabled =>
        Environment.GetEnvironmentVariable("SKP_REALSTACK") == "1";

    /// <summary>Skips the calling test unless the real stack was explicitly enabled.</summary>
    public static void SkipUnlessEnabled() =>
        Assert.SkipUnless(Enabled,
            "set SKP_REALSTACK=1 and run k8s/port-forward-realstack.ps1 to run the live tests");

    // Defaults match k8s/port-forward-realstack.ps1. Every port is offset from its in-cluster number
    // so a forward can never collide with a local service on the standard one.
    public static string RabbitHost => Get("SKP_RABBIT_HOST", "localhost");
    public static int RabbitPort => int.Parse(Get("SKP_RABBIT_PORT", "5673"));
    public static string BaseApiUrl => Get("SKP_BASEAPI_URL", "http://localhost:18080");
    public static string OtlpEndpoint => Get("SKP_OTLP_ENDPOINT", "http://localhost:14317");
    public static string CollectorMetricsUrl => Get("SKP_COLLECTOR_METRICS_URL", "http://localhost:18889/metrics");

    private static string Get(string key, string fallback) =>
        Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : fallback;
}

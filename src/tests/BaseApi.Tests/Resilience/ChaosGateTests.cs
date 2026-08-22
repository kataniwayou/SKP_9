using BaseApi.Tests.Live.Resilience;
using BaseApi.Tests.Support;
using Xunit;

namespace BaseApi.Tests.Resilience;

/// <summary>
/// The gate is the whole safety story for a suite that pauses Redis and scales StatefulSets to zero.
/// These run hermetically and assert it is shut unless BOTH switches are thrown.
/// </summary>
/// <remarks>
/// Joins <see cref="EnvironmentCollection"/> because these tests set <c>SKP_REALSTACK</c> and
/// <c>SKP_CHAOS</c> process-wide. Other collections (the RealStack live suites, and
/// RedisReconnectLiveTests, which is deliberately kept out of RealStackCollection) read
/// <c>SKP_REALSTACK</c> via <c>RealStack.Enabled</c>/<c>SkipUnlessEnabled()</c> while running in
/// parallel with this one. Without serialising against them, a window where this suite has set
/// <c>SKP_REALSTACK=1</c> could make one of those tests see the switch thrown in a hermetic run and
/// proceed to reach infrastructure that is not there, turning a skip into a spurious failure.
/// </remarks>
[Collection(EnvironmentCollection.Name)]
public sealed class ChaosGateTests
{
    [Fact]
    public void TheGateIsClosedWhenOnlyTheRealStackSwitchIsSet()
    {
        using var _ = new EnvScope(("SKP_REALSTACK", "1"), ("SKP_CHAOS", null));

        Assert.False(Chaos.Enabled);
    }

    [Fact]
    public void TheGateIsClosedWhenOnlyTheChaosSwitchIsSet()
    {
        using var _ = new EnvScope(("SKP_REALSTACK", null), ("SKP_CHAOS", "1"));

        Assert.False(Chaos.Enabled);
    }

    [Fact]
    public void TheGateOpensOnlyWhenBothSwitchesAreSet()
    {
        using var _ = new EnvScope(("SKP_REALSTACK", "1"), ("SKP_CHAOS", "1"));

        Assert.True(Chaos.Enabled);
    }

    [Fact]
    public void TheDefaultsAddressTheForwardsTheScriptOpens()
    {
        using var _ = new EnvScope(
            ("SKP_ES_URL", null), ("SKP_PROM_URL", null),
            ("SKP_WORKFLOW_ID", null), ("SKP_K8S_NAMESPACE", null));

        Assert.Equal("http://localhost:19200", Chaos.ElasticUrl);
        Assert.Equal("http://localhost:19090", Chaos.PrometheusUrl);
        Assert.Equal(Guid.Parse("4cd8af45-1295-43db-ab2e-e955dd82b5c5"), Chaos.WorkflowId);
        Assert.Equal("skp", Chaos.Namespace);
    }

    /// <summary>Sets environment variables for the life of the scope and restores them after.</summary>
    private sealed class EnvScope : IDisposable
    {
        private readonly (string Key, string? Previous)[] _saved;

        public EnvScope(params (string Key, string? Value)[] values)
        {
            _saved = values
                .Select(v => (v.Key, Environment.GetEnvironmentVariable(v.Key)))
                .ToArray();

            foreach (var (key, value) in values)
            {
                Environment.SetEnvironmentVariable(key, value);
            }
        }

        public void Dispose()
        {
            foreach (var (key, previous) in _saved)
            {
                Environment.SetEnvironmentVariable(key, previous);
            }
        }
    }
}

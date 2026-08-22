using BaseApi.Tests.Live.Resilience;
using Xunit;

namespace BaseApi.Tests.Resilience;

/// <summary>
/// The gate is the whole safety story for a suite that pauses Redis and scales StatefulSets to zero.
/// These run hermetically and assert it is shut unless BOTH switches are thrown.
/// </summary>
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

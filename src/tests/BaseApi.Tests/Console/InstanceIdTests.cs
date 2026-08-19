using BaseConsole.Core.Messaging;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The instance id names three things that must agree: the L2 liveness key
/// <c>skp:proc:{id}:{instanceId}</c>, the reply queue <c>proc-reply-{instanceId}</c>, and the
/// <c>service.instance.id</c> stamped on this pod's logs and metrics. If they diverge, a liveness key
/// cannot be traced back to the pod that wrote it.
/// </summary>
public sealed class InstanceIdTests
{
    private static void WithEnv(string? podName, string? hostname, Action assert)
    {
        var podBefore  = Environment.GetEnvironmentVariable("POD_NAME");
        var hostBefore = Environment.GetEnvironmentVariable("HOSTNAME");
        try
        {
            Environment.SetEnvironmentVariable("POD_NAME", podName);
            Environment.SetEnvironmentVariable("HOSTNAME", hostname);
            assert();
        }
        finally
        {
            Environment.SetEnvironmentVariable("POD_NAME", podBefore);
            Environment.SetEnvironmentVariable("HOSTNAME", hostBefore);
        }
    }

    [Fact]
    public void PrefersPodNameOverEverythingElse()
    {
        // In Kubernetes this is the downward-API pod name, which is what an operator greps for.
        WithEnv("proc-sample-7d9f", "some-host", () =>
            Assert.Equal("proc-sample-7d9f", InstanceId.Resolve().Value));
    }

    [Fact]
    public void FallsBackToHostnameWhenPodNameIsAbsent()
    {
        WithEnv(null, "some-host", () =>
            Assert.Equal("some-host", InstanceId.Resolve().Value));
    }

    [Fact]
    public void FallsBackToTheMachineNameOutsideAContainer()
    {
        WithEnv(null, null, () =>
            Assert.Equal(Environment.MachineName, InstanceId.Resolve().Value));
    }

    [Fact]
    public void TreatsAnEmptyVariableAsAbsent()
    {
        // An unset downward-API field surfaces as empty, not missing. Taking it literally would name
        // the liveness key after nothing and fail the InstanceId guard.
        WithEnv("", "some-host", () =>
            Assert.Equal("some-host", InstanceId.Resolve().Value));
    }

    [Fact]
    public void ResolvingTwiceInTheSameProcessAgrees()
    {
        // Telemetry resolves it at host build and the liveness writer resolves it from DI; two
        // different answers would decouple a liveness key from its pod's logs.
        WithEnv(null, null, () =>
            Assert.Equal(InstanceId.Resolve().Value, InstanceId.Resolve().Value));
    }
}

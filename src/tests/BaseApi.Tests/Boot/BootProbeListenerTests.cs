using System.Net;
using BaseProcessor.Core.Boot;
using Xunit;

namespace BaseApi.Tests.Boot;

public sealed class BootProbeListenerTests
{
    // Port 0 lets the OS choose, so parallel test runs cannot collide on a fixed number.
    private static Task<BootProbeListener> StartAsync() =>
        BootProbeListener.StartAsync(0, TestContext.Current.CancellationToken);

    [Fact]
    public async Task StartupAndLiveAnswerHealthyWhileDiscoveryRuns()
    {
        // This is the whole reason the listener exists. Without it nothing holds :8081 during Stage 1,
        // the startup budget expires, and the kubelet restarts a pod that is starting correctly.
        await using var listener = await StartAsync();
        using var http = new HttpClient { BaseAddress = listener.Address };

        foreach (var path in new[] { "/health/startup", "/health/live" })
        {
            var response = await http.GetAsync(path, TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
    }

    [Fact]
    public async Task ReadyAnswersUnavailable()
    {
        // Readiness is the honest signal during discovery: the process is up but cannot serve.
        await using var listener = await StartAsync();
        using var http = new HttpClient { BaseAddress = listener.Address };

        var response = await http.GetAsync("/health/ready", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    [Fact]
    public async Task TheAddressIsLoopbackSoATestCanReachIt()
    {
        await using var listener = await StartAsync();

        Assert.Equal("127.0.0.1", listener.Address.Host);
        Assert.True(listener.Address.Port > 0);
    }

    [Fact]
    public async Task DisposingReleasesThePortForTheRealListener()
    {
        // Stage 2 binds the same port. If disposal did not actually release it the host would fail to
        // start, which is a far worse failure than the missed probe it is trading against.
        var listener = await StartAsync();
        var port = listener.Address.Port;
        await listener.DisposeAsync();

        await using var second = await BootProbeListener.StartAsync(
            port, TestContext.Current.CancellationToken);

        Assert.Equal(port, second.Address.Port);
    }
}

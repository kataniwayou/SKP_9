using System.Net;
using System.Text.Json;
using BaseConsole.Core.DependencyInjection;
using BaseConsole.Core.Health;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Xunit;

namespace BaseApi.Tests.Console;

/// <summary>
/// The probes Kubernetes polls. Exercised over real HTTP against a real Kestrel, because everything
/// that can go wrong here — a wrong tag filter, a wrong status code, a body that leaks — is invisible
/// to a compiler and to a unit test of the pieces.
/// </summary>
public sealed class EmbeddedHealthEndpointTests : IAsyncLifetime
{
    private ServiceProvider _outer = null!;
    private EmbeddedHealthEndpointService _endpoint = null!;
    private HttpClient _client = null!;

    private HealthStatus _readyStatus = HealthStatus.Healthy;
    private readonly StartupGate _gate = new();

    public async ValueTask InitializeAsync()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IStartupGate>(_gate);
        services.AddHealthChecks()
            .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"])
            .AddCheck<StartupHealthCheck>("startup", tags: ["startup"])
            .AddCheck("dependency", () => new HealthCheckResult(
                _readyStatus, description: "connection string is redis://secret@host"), tags: ["ready"]);

        _outer = services.BuildServiceProvider();

        // Port 0 lets the OS pick a free one, so a developer already running a console on 8081 does
        // not see this fail as a health bug.
        _endpoint = new EmbeddedHealthEndpointService(
            _outer,
            Options.Create(new ConsoleHealthOptions { Port = 0 }),
            _outer.GetRequiredService<ILoggerFactory>()
                .CreateLogger<EmbeddedHealthEndpointService>());

        await _endpoint.StartAsync(CancellationToken.None);
        _client = new HttpClient { BaseAddress = _endpoint.Address };
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _endpoint.StopAsync(CancellationToken.None);
        await _outer.DisposeAsync();
    }

    [Fact]
    public async Task LiveAnswersWhileNothingElseIsReady()
    {
        // Liveness must not depend on a dependency being up, or an outage restarts every pod.
        _readyStatus = HealthStatus.Unhealthy;

        var response = await _client.GetAsync("/health/live", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task ReadyReportsUnavailableWhenADependencyIsDown()
    {
        _readyStatus = HealthStatus.Unhealthy;

        var response = await _client.GetAsync("/health/ready", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    [Fact]
    public async Task ReadyRecoversWithoutARestart()
    {
        _readyStatus = HealthStatus.Unhealthy;
        await _client.GetAsync("/health/ready", TestContext.Current.CancellationToken);

        _readyStatus = HealthStatus.Healthy;
        var response = await _client.GetAsync("/health/ready", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task StartupFollowsTheGate()
    {
        var before = await _client.GetAsync("/health/startup", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, before.StatusCode);

        _gate.MarkReady();

        var after = await _client.GetAsync("/health/startup", TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, after.StatusCode);
    }

    [Fact]
    public async Task EachProbeReportsOnlyItsOwnChecks()
    {
        // A tag filter that matched everything would make /health/live fail on a dependency outage —
        // the exact coupling the split exists to prevent.
        var live = await _client.GetStringAsync("/health/live", TestContext.Current.CancellationToken);

        Assert.Contains("self", live);
        Assert.DoesNotContain("dependency", live);
        Assert.DoesNotContain("startup", live);
    }

    [Fact]
    public async Task TheBodyNeverCarriesCheckDescriptions()
    {
        // Descriptions are written by whoever authored the check and can carry connection strings.
        // The probe body is name and status only; detail belongs in logs, which are not public.
        _readyStatus = HealthStatus.Unhealthy;

        // GetAsync, not GetStringAsync: the latter throws on the 503 this probe is expected to return.
        var response = await _client.GetAsync("/health/ready", TestContext.Current.CancellationToken);
        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

        Assert.DoesNotContain("secret", body);
        Assert.DoesNotContain("redis://", body);

        using var json = JsonDocument.Parse(body);
        Assert.Equal("Unhealthy", json.RootElement.GetProperty("status").GetString());
        Assert.Equal("Unhealthy", json.RootElement.GetProperty("checks")
            .EnumerateArray().Single().GetProperty("status").GetString());
    }

    [Fact]
    public async Task AnUnknownPathIsNotFound()
    {
        var response = await _client.GetAsync("/health", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}

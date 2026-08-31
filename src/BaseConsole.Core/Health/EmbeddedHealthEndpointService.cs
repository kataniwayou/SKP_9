using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace BaseConsole.Core.Health;

/// <summary>
/// Serves the three Kubernetes probes — <c>/health/live</c>, <c>/health/ready</c>,
/// <c>/health/startup</c> — from a minimal Kestrel listener, so a worker with no web surface of its
/// own is still observable by the kubelet.
/// <para>
/// <b>The checks come from the outer container, not a second one.</b> The listener owns only HTTP:
/// it resolves the host's own <see cref="HealthCheckService"/> and filters by tag. Building a second
/// set of registrations inside the web host would mean every check existed twice, with nothing
/// keeping the copies honest — and the copy that mattered would be the one the kubelet could see.
/// </para>
/// <para>
/// <b>The split between the three is the whole point.</b> Liveness answers only from checks tagged
/// <c>live</c>, which must never touch a dependency: a Redis or broker blip that failed liveness
/// would restart every replica during the outage it should be riding out. Readiness may fail freely —
/// that removes the pod from service and is reversible without a restart.
/// </para>
/// <para>
/// <b>The body carries names and statuses only.</b> A check's description is free text written by
/// whoever authored it and can easily carry a connection string or an exception message; this
/// endpoint is reachable by anything that can route to the pod. Detail belongs in the logs.
/// </para>
/// </summary>
public sealed class EmbeddedHealthEndpointService : IHostedService
{
    private readonly IServiceProvider _outer;
    private readonly ConsoleHealthOptions _options;
    private readonly ILogger<EmbeddedHealthEndpointService> _logger;
    private WebApplication? _app;
    private ILogger _probeLog = NullLogger.Instance;

    public EmbeddedHealthEndpointService(
        IServiceProvider outer,
        IOptions<ConsoleHealthOptions> options,
        ILogger<EmbeddedHealthEndpointService> logger)
    {
        _outer   = outer ?? throw new ArgumentNullException(nameof(outer));
        _options = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>Where the listener actually bound, known only after <see cref="StartAsync"/>.</summary>
    public Uri? Address { get; private set; }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls($"http://0.0.0.0:{_options.Port}");
        builder.Logging.ClearProviders();   // the outer host owns logging; this one would duplicate it

        _app = builder.Build();

        // From the outer factory, so it inherits the outer host's providers and its configured
        // filters. The category is fixed rather than this class, so one settings key silences the
        // probe line here and in the API alike.
        _probeLog = _outer.GetRequiredService<ILoggerFactory>().CreateLogger(HealthProbeLog.Category);

        _app.MapGet("/health/live",    () => ProbeAsync("live"));
        _app.MapGet("/health/ready",   () => ProbeAsync("ready"));
        _app.MapGet("/health/startup", () => ProbeAsync("startup"));

        await _app.StartAsync(cancellationToken).ConfigureAwait(false);

        Address = _app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()?.Addresses
            .Select(a => new Uri(a.Replace("0.0.0.0", "127.0.0.1", StringComparison.Ordinal)))
            .FirstOrDefault();

        _logger.LogInformation("health probes listening on {Address}", Address);
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (_app is not null)
        {
            await _app.StopAsync(cancellationToken).ConfigureAwait(false);
            await _app.DisposeAsync().ConfigureAwait(false);
            _app = null;
        }
    }

    /// <summary>
    /// Runs the checks carrying <paramref name="tag"/> and renders them. A probe whose tag matches no
    /// registration reports healthy, which is the right answer: a worker that registers nothing under
    /// <c>ready</c> has nothing that can make it unready.
    /// </summary>
    private async Task<IResult> ProbeAsync(string tag)
    {
        var health = _outer.GetRequiredService<HealthCheckService>();
        var report = await health.CheckHealthAsync(r => r.Tags.Contains(tag)).ConfigureAwait(false);

        var body = new
        {
            status = report.Status.ToString(),
            checks = report.Entries
                .Select(e => new { name = e.Key, status = e.Value.Status.ToString() })
                .ToArray(),
        };

        // Degraded is deliberately a 200: it means serving but imperfect, and taking the pod out of
        // rotation for it would turn a partial degradation into an outage.
        var code = report.Status == HealthStatus.Unhealthy
            ? StatusCodes.Status503ServiceUnavailable
            : StatusCodes.Status200OK;

        HealthProbeLog.Write(_probeLog, tag, report, code);

        return Results.Json(body, statusCode: code);
    }
}

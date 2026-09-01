using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using BaseConsole.Core.Health;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;

namespace BaseProcessor.Core.Boot;

/// <summary>
/// The probe surface for the window before the real host exists: startup and liveness healthy,
/// readiness unavailable.
/// <para>
/// <b>It is what makes an unbounded Stage 1 safe.</b> Identity resolution can take as long as it
/// takes — a processor image may be deployed before anyone registers its row — and the kubelet only
/// tolerates that if something is answering. With nothing bound, the startup probe exhausts its
/// budget and the container is restarted, turning a deployment ordering the operator is allowed to
/// choose into a crash loop.
/// </para>
/// <para>
/// <b>The answers are constants, not checks.</b> There is no dependency worth consulting yet: the
/// only thing that could be reported is whether identity has resolved, and that is precisely what
/// readiness already says by answering 503 for the whole window.
/// </para>
/// </summary>
public sealed class BootProbeListener : IAsyncDisposable
{
    private readonly WebApplication _app;

    private BootProbeListener(WebApplication app, Uri address)
    {
        _app    = app;
        Address = address;
    }

    /// <summary>Where the listener actually bound. With port 0 this is known only after starting.</summary>
    public Uri Address { get; }

    /// <summary>
    /// Binds the probe surface. Port 0 lets the OS choose, which is for tests; production passes the
    /// same <c>ConsoleHealth:Port</c> the real listener will take over.
    /// </summary>
    /// <param name="port">The port the real health listener will later take over.</param>
    /// <param name="logs">
    /// The boot sequence's own factory — the same one the identity bootstrap writes through. Required
    /// rather than defaulted, because a default would mean a caller could silently reintroduce the
    /// silent probe surface this parameter exists to remove.
    /// </param>
    /// <param name="ct">Cancels the bind.</param>
    public static async Task<BootProbeListener> StartAsync(
        int port, ILoggerFactory logs, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(logs);

        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
        // Console logging belongs to the boot sequence, which owns its own factory. A second provider
        // here would print every request twice during the one window an operator is actually reading.
        builder.Logging.ClearProviders();

        var app = builder.Build();

        // The same category the real listener uses, so one query spans the boot window and everything
        // after it, and the handover between the two listeners is invisible to whoever is reading.
        var probeLog = logs.CreateLogger(typeof(HealthProbeLog));

        app.MapGet("/health/startup", () => Answer(probeLog, "startup", HealthStatus.Healthy));
        app.MapGet("/health/live",    () => Answer(probeLog, "live",    HealthStatus.Healthy));
        app.MapGet("/health/ready",   () => Answer(probeLog, "ready",   HealthStatus.Unhealthy));

        await app.StartAsync(ct).ConfigureAwait(false);

        var address = app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()?.Addresses
            .Select(a => new Uri(a.Replace("0.0.0.0", "127.0.0.1", StringComparison.Ordinal)))
            .FirstOrDefault()
            ?? throw new InvalidOperationException("the boot probe listener reported no address");

        return new BootProbeListener(app, address);
    }

    /// <summary>
    /// Logs the outcome and returns it. The report is synthesised rather than run, because the
    /// answers here are constants — but it is a real <see cref="HealthReport"/> so the line renders
    /// through the same code the real listener uses and cannot drift from it.
    /// <para>
    /// One entry, named for the only thing that is actually unknown during this window. On readiness
    /// it is unhealthy, which is what makes the line say <c>failing: identity</c> — the true reason
    /// this stage answers 503 at all. The duration is zero because nothing was checked.
    /// </para>
    /// </summary>
    private static IResult Answer(ILogger log, string tag, HealthStatus status)
    {
        var code = status == HealthStatus.Unhealthy
            ? StatusCodes.Status503ServiceUnavailable
            : StatusCodes.Status200OK;

        HealthProbeLog.Write(
            log,
            tag,
            new HealthReport(
                new Dictionary<string, HealthReportEntry>
                {
                    ["identity"] = new(status, description: null, duration: TimeSpan.Zero, exception: null, data: null),
                },
                TimeSpan.Zero),
            code);

        return Results.StatusCode(code);
    }

    /// <summary>
    /// Stops the listener and waits for the port to be released. Stage 2 binds the same port, so a
    /// disposal that returned before the socket closed would fail the real host's startup.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync().ConfigureAwait(false);
        await _app.DisposeAsync().ConfigureAwait(false);
    }
}

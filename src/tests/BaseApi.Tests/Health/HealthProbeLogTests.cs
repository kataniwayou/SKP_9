using System.Net;
using BaseApi.Core.DependencyInjection;
using BaseApi.Tests.Support;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Xunit;

using ApiProbeLog     = BaseApi.Core.Health.HealthProbeLog;
using ConsoleProbeLog = BaseConsole.Core.Health.HealthProbeLog;

namespace BaseApi.Tests.Health;

/// <summary>
/// The probe line every service writes. Two things are under test and only one of them is the text:
/// the other is that the API's copy and the workers' copy have not drifted apart, which is the whole
/// reason the line is worth having. A single log query has to cover all three services, and nothing
/// but this test stops one copy from being edited alone.
/// </summary>
public sealed class HealthProbeLogTests
{
    private static HealthReport Report(params (string Name, HealthStatus Status)[] entries) =>
        new(
            entries.ToDictionary(
                e => e.Name,
                e => new HealthReportEntry(
                    e.Status,
                    // Deliberately a secret. A description is free text and this one must never reach
                    // the log line, exactly as it never reaches the probe body.
                    description: "connection string is redis://secret@host",
                    duration: TimeSpan.FromMilliseconds(1),
                    exception: null,
                    data: null)),
            TimeSpan.FromMilliseconds(12.345));

    private static string Render(
        Action<ILogger, string, HealthReport, int> write,
        string tag,
        HealthReport report,
        int code,
        out LogLevel level)
    {
        var log = new RecordingLogger<HealthProbeLogTests>();
        write(log, tag, report, code);
        var record = Assert.Single(log.Records);
        level = record.Level;
        return record.Message;
    }

    /// <summary>
    /// The drift lock. The same report through both copies must produce the same string; if someone
    /// edits one template, this is what fails.
    /// </summary>
    [Theory]
    [InlineData("live",    HealthStatus.Healthy,   200)]
    [InlineData("ready",   HealthStatus.Degraded,  200)]
    [InlineData("startup", HealthStatus.Unhealthy, 503)]
    public void Both_copies_render_the_same_line(string tag, HealthStatus status, int code)
    {
        var report = Report(("self", HealthStatus.Healthy), ("dependency", status));

        var api     = Render(ApiProbeLog.Write,     tag, report, code, out var apiLevel);
        var console = Render(ConsoleProbeLog.Write, tag, report, code, out var consoleLevel);

        Assert.Equal(console, api);
        Assert.Equal(consoleLevel, apiLevel);
    }

    /// <summary>
    /// A healthy probe carries no trailing detail — the common case is the one that must stay short,
    /// because it is the one that repeats every ten seconds forever.
    /// </summary>
    [Fact]
    public void Healthy_probe_renders_status_code_and_duration_only()
    {
        var message = Render(
            ConsoleProbeLog.Write,
            "live",
            Report(("self", HealthStatus.Healthy)),
            200,
            out var level);

        Assert.Equal("live probe Healthy (200) in 12.35ms", message);
        Assert.Equal(LogLevel.Information, level);
    }

    /// <summary>
    /// Failing checks are named, sorted, and carry nothing else. Sorted because HealthReport.Entries
    /// is a dictionary: unsorted, the same failure would render two ways across consecutive probes
    /// and defeat any attempt to group the line.
    /// </summary>
    [Fact]
    public void Unhealthy_probe_names_failing_checks_sorted_and_withholds_descriptions()
    {
        var message = Render(
            ConsoleProbeLog.Write,
            "ready",
            Report(
                ("redis",    HealthStatus.Unhealthy),
                ("postgres", HealthStatus.Unhealthy),
                ("self",     HealthStatus.Healthy)),
            503,
            out _);

        Assert.Equal("ready probe Unhealthy (503) in 12.35ms; failing: postgres, redis", message);
        Assert.DoesNotContain("secret", message, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Information regardless of outcome, which is the configured contract: one level means one
    /// filter key — <c>Logging:LogLevel:HealthProbe</c> — turns the line off everywhere. It also means
    /// a failure cannot be kept while the healthy chatter is dropped, and that trade is deliberate.
    /// </summary>
    [Fact]
    public void Level_is_information_even_when_unhealthy()
    {
        Render(ConsoleProbeLog.Write, "live", Report(("self", HealthStatus.Unhealthy)), 503, out var level);
        Assert.Equal(LogLevel.Information, level);
    }

    /// <summary>
    /// The API's real endpoint over real HTTP. The unit tests above prove the two templates match;
    /// this proves the API actually reaches one of them, which the response-writer wiring could
    /// silently fail to do while every other test still passed.
    /// </summary>
    [Fact]
    public async Task Api_endpoint_logs_the_outcome_of_a_real_request()
    {
        var recorder = new RecordingProvider();

        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(recorder);
        builder.Services.AddHealthChecks()
            .AddCheck("self",       () => HealthCheckResult.Healthy(),   tags: ["live"])
            .AddCheck("dependency", () => HealthCheckResult.Unhealthy(), tags: ["live"]);

        var app = builder.Build();
        BaseApiApplicationBuilderExtensions.MapProbe(app, "live");
        await app.StartAsync(TestContext.Current.CancellationToken);

        try
        {
            var address = app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()!.Addresses.First();
            using var client = new HttpClient { BaseAddress = new Uri(address) };

            var response = await client.GetAsync("/health/live", TestContext.Current.CancellationToken);

            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
            var line = Assert.Single(recorder.Snapshot(), r => r.Category == typeof(ApiProbeLog).FullName);
            Assert.Equal(LogLevel.Information, line.Level);
            // The status code in the line is the one the client actually received.
            Assert.StartsWith("live probe Unhealthy (503) in", line.Message, StringComparison.Ordinal);
            Assert.EndsWith("; failing: dependency", line.Message, StringComparison.Ordinal);
        }
        finally
        {
            await app.StopAsync(TestContext.Current.CancellationToken);
            await app.DisposeAsync();
        }
    }

    /// <summary>
    /// The workers' real endpoint over real HTTP, for the same reason: the probe logger is resolved
    /// from the <i>outer</i> host's factory, and that indirection is exactly what a refactor breaks.
    /// The embedded host clears its own providers, so a line reaching this recorder proves the outer
    /// factory was used and not the listener's.
    /// </summary>
    [Fact]
    public async Task Worker_endpoint_logs_the_outcome_of_a_real_request()
    {
        var recorder = new RecordingProvider();

        var services = new ServiceCollection();
        services.AddLogging(b =>
        {
            b.ClearProviders();
            b.AddProvider(recorder);
        });
        services.AddHealthChecks()
            .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"]);

        await using var outer = services.BuildServiceProvider();
        var endpoint = new BaseConsole.Core.Health.EmbeddedHealthEndpointService(
            outer,
            Options.Create(new BaseConsole.Core.Health.ConsoleHealthOptions { Port = 0 }),
            outer.GetRequiredService<ILoggerFactory>()
                .CreateLogger<BaseConsole.Core.Health.EmbeddedHealthEndpointService>());

        await endpoint.StartAsync(CancellationToken.None);

        try
        {
            using var client = new HttpClient { BaseAddress = endpoint.Address };

            var response = await client.GetAsync("/health/live", TestContext.Current.CancellationToken);

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var line = Assert.Single(recorder.Snapshot(), r => r.Category == typeof(ConsoleProbeLog).FullName);
            Assert.Equal(LogLevel.Information, line.Level);
            Assert.StartsWith("live probe Healthy (200) in", line.Message, StringComparison.Ordinal);
        }
        finally
        {
            await endpoint.StopAsync(CancellationToken.None);
        }
    }

    /// <summary>
    /// Captures records with their category, which is the part under test here — the shared
    /// <c>RecordingLogger</c> keeps the message but not the category it was written under.
    /// </summary>
    private sealed class RecordingProvider : ILoggerProvider
    {
        private readonly List<(string Category, LogLevel Level, string Message)> _records = [];

        public ILogger CreateLogger(string categoryName) => new Sink(this, categoryName);

        public void Dispose() { }

        /// <summary>A copy, because Kestrel may still be writing on another thread.</summary>
        public IReadOnlyList<(string Category, LogLevel Level, string Message)> Snapshot()
        {
            lock (_records)
            {
                return _records.ToArray();
            }
        }

        private void Add(string category, LogLevel level, string message)
        {
            lock (_records)
            {
                _records.Add((category, level, message));
            }
        }

        private sealed class Sink : ILogger
        {
            private readonly RecordingProvider _owner;
            private readonly string _category;

            public Sink(RecordingProvider owner, string category)
            {
                _owner    = owner;
                _category = category;
            }

            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel level,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => _owner.Add(_category, level, formatter(state, exception));
        }
    }
}

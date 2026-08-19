using BaseConsole.Core.Configuration;
using BaseConsole.Core.Messaging;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;

namespace BaseConsole.Core.DependencyInjection;

/// <summary>
/// OpenTelemetry for a worker: logs through the Microsoft.Extensions.Logging bridge, and metrics with
/// runtime instrumentation. No traces pipeline — the collector receives none and the SDK emits none.
/// <para>
/// The deltas from the API-side equivalent are the absence of ASP.NET Core and HttpClient
/// instrumentation. A worker has no inbound request surface beyond its health probes, so those
/// instrumentations would produce nothing but noise from the probe traffic itself.
/// </para>
/// </summary>
public static class BaseConsoleObservabilityExtensions
{
    /// <summary>
    /// Takes the host builder rather than the service collection, because
    /// <c>builder.Logging.AddOpenTelemetry</c> needs the <see cref="ILoggingBuilder"/> surface. The
    /// host builder exposes both logging and services.
    /// </summary>
    /// <param name="builder">The host builder, exposing both logging and services.</param>
    /// <param name="cfg">The worker's configuration, supplying the service name and version.</param>
    /// <param name="source">
    /// The application type stamped on every record's resource — <c>worker</c> for every background
    /// host, paired with <c>webapi</c> on the API side. Required rather than defaulted, because it is
    /// the stable answer to "what kind of process emitted this" and a new worker must not be able to
    /// ship without one.
    /// <para>
    /// Deliberately coarser than <c>service.name</c>, and not a substitute for it: the type says what
    /// shape of process produced the record, while the service name says which role —
    /// <c>processor</c>, <c>orchestrator</c>, <c>keeper</c> — it plays. One term selects every
    /// worker, the other one role within them. It is deliberately not the library name: a host that
    /// dropped this library but kept the shape would still be a <c>worker</c>.
    /// </para>
    /// <para>
    /// Neither of them names the processor's <i>row</i>. That identity arrives from the database long
    /// after this method runs, and an OTel resource is materialised once when the provider is built
    /// and is immutable thereafter, so a row-derived name can only ever ride per-record.
    /// </para>
    /// </param>
    public static IHostApplicationBuilder AddBaseConsoleObservability(
        this IHostApplicationBuilder builder, IConfiguration cfg, string source)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(cfg);
        ArgumentException.ThrowIfNullOrWhiteSpace(source);

        // Fail fast at the boundary rather than letting null reach the resource builder and surface
        // as an opaque SDK argument exception.
        var serviceName    = cfg.Require("Service:Name");
        var serviceVersion = cfg.Require("Service:Version");

        // The same replica identity that names this process's liveness key and reply queue. Sharing
        // one resolver is what lets an operator pivot from an L2 key to that pod's records; two
        // independent answers would decouple them.
        var instanceId = InstanceId.Resolve().Value;

        // The application type rides on both resources under each signal's own casing convention:
        // PascalCase on logs, camelCase on metrics. It is resource-level, never per record, because
        // it cannot vary within a process — which is exactly why the processor's row identity, which
        // does change within a process, cannot live here.
        var logAttrs = new[]
        {
            new KeyValuePair<string, object>("service.instance.id", instanceId),
            new KeyValuePair<string, object>("Source", source),
        };
        var metricAttrs = new[]
        {
            new KeyValuePair<string, object>("service.instance.id", instanceId),
            new KeyValuePair<string, object>("source", source),
        };

        // Logs must go through builder.Logging.AddOpenTelemetry, not the services-side logging
        // registration: the latter creates a parallel provider that bypasses the logging filters.
        builder.Logging.AddOpenTelemetry(o =>
        {
            o.IncludeFormattedMessage = true;
            // Load-bearing: it is what serializes a BeginScope dictionary — the correlation id among
            // them — as telemetry attributes rather than dropping it.
            o.IncludeScopes           = true;
            o.ParseStateValues        = true;
            o.SetResourceBuilder(ResourceBuilder.CreateDefault()
                .AddService(serviceName: serviceName, serviceVersion: serviceVersion)
                .AddAttributes(logAttrs));
            o.AddOtlpExporter();
        });

        // The versioned service name is set on the meter provider's own resource via
        // SetResourceBuilder, never via the shared ConfigureResource. In this OpenTelemetry version
        // the shared configuration overrides the logs provider's own resource builder, so a versioned
        // name set there leaks onto logs — which breaks any log query filtering on the bare service
        // name. A per-provider resource keeps metrics versioned while logs stay bare.
        builder.Services.AddOpenTelemetry()
            .WithMetrics(m => m
                .SetResourceBuilder(ResourceBuilder.CreateDefault()
                    // A combined name-and-version, so every metric series carries one human label.
                    // serviceVersion is deliberately not passed separately: it is already
                    // interpolated into the name here, and passing it too would restate the same
                    // value as a second label on every series. Logs are unaffected — their service
                    // name has no version suffix, so they still carry service.version.
                    .AddService(serviceName: $"{serviceName}_{serviceVersion}")
                    .AddAttributes(metricAttrs))
                // No ASP.NET Core or HttpClient instrumentation: a worker's only inbound surface is
                // its own health probes, so those would measure nothing but the probing.
                .AddRuntimeInstrumentation()
                .AddOtlpExporter());

        return builder;
    }
}

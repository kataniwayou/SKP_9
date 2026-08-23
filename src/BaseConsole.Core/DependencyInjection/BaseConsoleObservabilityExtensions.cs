using BaseConsole.Core.Configuration;
using BaseConsole.Core.Gating;
using BaseConsole.Core.Messaging;
using Messaging.Transport;
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
    /// </param>
    /// <param name="serviceName">
    /// The resolved role name. Null falls back to <c>Service:Name</c> in configuration.
    /// <para>
    /// A processor passes the name from its database row, resolved before the host was built. That is
    /// the only way it can reach a resource at all: an OTel resource is materialised once when the
    /// provider is built and is immutable thereafter.
    /// </para>
    /// </param>
    /// <param name="serviceVersion">
    /// The resolved version. Null falls back to <c>Service:Version</c> in configuration.
    /// </param>
    /// <param name="resourceAttributes">
    /// Extra attributes stamped on both resources, each under its own signal's casing. This is where
    /// <c>ProcessorId</c> rides: it is the only value that identifies a processor exactly, because
    /// name and version are unconstrained columns and two different builds can share them.
    /// </param>
    public static IHostApplicationBuilder AddBaseConsoleObservability(
        this IHostApplicationBuilder builder,
        IConfiguration cfg,
        string source,
        string? serviceName = null,
        string? serviceVersion = null,
        IEnumerable<ResourceAttribute>? resourceAttributes = null)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(cfg);
        ArgumentException.ThrowIfNullOrWhiteSpace(source);

        // Configuration is the fallback, not the authority. A caller that resolved a real identity
        // knows something configuration cannot, so Require is consulted only when it did not.
        var name    = serviceName    ?? cfg.Require("Service:Name");
        var version = serviceVersion ?? cfg.Require("Service:Version");

        // The same replica identity that names this process's liveness key and reply queue. Sharing
        // one resolver is what lets an operator pivot from an L2 key to that pod's records; two
        // independent answers would decouple them.
        var instanceId = InstanceId.Resolve().Value;

        var extra = (resourceAttributes ?? []).ToList();

        // The application type rides on both resources under each signal's own casing convention:
        // PascalCase on logs, camelCase on metrics. It is resource-level, never per record, because
        // it cannot vary within a process — and neither can anything else stamped here, which is why
        // the caller must already know the identity by the time it calls.
        var logAttrs = new List<KeyValuePair<string, object>>
        {
            new("service.instance.id", instanceId),
            new("Source", source),
        };
        logAttrs.AddRange(extra.Select(a => new KeyValuePair<string, object>(a.LogKey, a.Value)));

        var metricAttrs = new List<KeyValuePair<string, object>>
        {
            new("service.instance.id", instanceId),
            new("source", source),
        };
        metricAttrs.AddRange(extra.Select(a => new KeyValuePair<string, object>(a.MetricKey, a.Value)));

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
                .AddService(serviceName: name, serviceVersion: version)
                .AddAttributes(logAttrs));
            o.AddOtlpExporter();
        });

        // The resource is set on the meter provider's own builder via SetResourceBuilder, never via
        // the shared ConfigureResource. In this OpenTelemetry version the shared configuration
        // overrides the logs provider's own resource builder, so anything set there leaks onto logs.
        // A per-provider resource keeps the two independent.
        builder.Services.AddOpenTelemetry()
            .WithMetrics(m => m
                .SetResourceBuilder(ResourceBuilder.CreateDefault()
                    // Name and version as separate attributes, not interpolated into one string. The
                    // interpolation this replaces existed to give a sentinel a single readable label;
                    // with a real identity it only buries the version inside the name and leaves logs
                    // and metrics disagreeing about what service.name means.
                    .AddService(serviceName: name, serviceVersion: version)
                    .AddAttributes(metricAttrs))
                // The whole consistency mechanism in three lines: both the orchestrator host and
                // every processor host already call this method, so both roles emit the same
                // instruments and a new worker cannot ship without them. The names come from
                // constants rather than literals because a typo here produces no error and no
                // metrics.
                .AddMeter(EgressMeter.Name)
                .AddMeter(IngressMetrics.MeterName)
                .AddMeter(L2GateMetrics.MeterName)
                // Bucket boundaries for the send-latency histogram, on the shared call so both roles
                // inherit them. Without a view the SDK applies a default ladder built for
                // milliseconds while the instrument records seconds, and every observation collapses
                // into the first bucket -- a histogram that answers quantiles with its own bucket
                // edge instead of a latency. See EgressMeter.LatencySecondsBoundaries.
                .AddView(
                    EgressMeter.DurationInstrument,
                    new ExplicitBucketHistogramConfiguration
                    {
                        Boundaries = EgressMeter.LatencySecondsBoundaries(),
                    })
                // No ASP.NET Core or HttpClient instrumentation: a worker's only inbound surface is
                // its own health probes, so those would measure nothing but the probing.
                .AddRuntimeInstrumentation()
                .AddOtlpExporter());

        return builder;
    }
}

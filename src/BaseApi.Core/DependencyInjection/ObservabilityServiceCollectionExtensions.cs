using Messaging.Transport;
using BaseApi.Core.Configuration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// OpenTelemetry wiring: logs through the Microsoft.Extensions.Logging bridge, and metrics with
/// ASP.NET Core, HttpClient and runtime instrumentation. There is deliberately no traces pipeline —
/// the collector receives none and the SDK emits none.
/// </summary>
public static class ObservabilityServiceCollectionExtensions
{
    /// <summary>
    /// Takes the host builder rather than the service collection, because
    /// <c>builder.Logging.AddOpenTelemetry</c> needs the <see cref="ILoggingBuilder"/> surface. The
    /// host builder exposes both logging and services.
    /// </summary>
    /// <param name="builder">The host builder, exposing both logging and services.</param>
    /// <param name="cfg">The application's configuration, supplying the service name and version.</param>
    /// <param name="source">
    /// The application type stamped on every record's resource — <c>webapi</c> here, paired with
    /// <c>worker</c> on the console side. Required, and mirrored by the console host's equivalent, so
    /// one attribute selects a process shape across the whole stack. It names the shape, never the
    /// role: which role a process plays is <c>service.name</c>, one level finer.
    /// </param>
    public static IHostApplicationBuilder AddBaseApiObservability(
        this IHostApplicationBuilder builder, IConfiguration cfg, string source)
    {
        // Fail fast at the boundary rather than letting null reach the resource builder and surface
        // as an opaque SDK argument exception.
        var serviceName    = cfg.Require("Service:Name");
        var serviceVersion = cfg.Require("Service:Version");

        // Resolve the per-replica instance id exactly once per process and apply it to both the logs
        // and metrics resources. Resolving once is a correctness requirement: calling the resolver
        // twice risks the GUID fallback differing between them, so the two signals would carry
        // different instance labels.
        var instanceId = ResolveInstanceId();

        // The application type rides on both resources under each signal's own casing convention:
        // PascalCase on logs, camelCase on metrics. It is resource-level, never per record, because
        // it cannot vary within a process.
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
            o.IncludeScopes           = true;
            o.ParseStateValues        = true;
            o.SetResourceBuilder(ResourceBuilder.CreateDefault()
                .AddService(serviceName: serviceName, serviceVersion: serviceVersion)
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
                    // Name and version as separate attributes, not interpolated into one string —
                    // the same shape the console base library emits. The interpolation this replaces
                    // buried the version inside service.name, which cost the metrics side its
                    // service.version label entirely and left logs and metrics disagreeing about
                    // what service.name meant. The Prometheus exporter derives exported_job from
                    // service.name, so the suffix leaked into that label too.
                    .AddService(serviceName: serviceName, serviceVersion: serviceVersion)
                    .AddAttributes(metricAttrs))
                // The metrics-side ASP.NET Core instrumentation is parameterless in this version —
                // there is no filter overload on the meter provider builder — so health-endpoint
                // metrics are filtered at the collector instead.
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation()
                // Queue depth and attached consumers. The API is the only process that can
                // observe orchestrator-control while the orchestrator is gone -- it is the one
                // publishing start and stop requests into it, which pile up there with nothing
                // to take them. See QueueDepthMetrics.
                .AddMeter(QueueDepthMetrics.MeterName)
                .AddOtlpExporter());

        return builder;
    }

    /// <summary>
    /// Resolves the per-replica instance id from POD_NAME, then HOSTNAME, then the machine name,
    /// falling back to a new GUID. Duplicated in the console base library, which is forbidden from
    /// referencing this assembly.
    /// <para>
    /// Blank counts as absent rather than being taken literally: a downward-API field that resolved
    /// to nothing arrives as an empty or whitespace value, not a missing variable, and stamping that
    /// on every record as <c>service.instance.id</c> would silently anonymise the whole replica.
    /// </para>
    /// <para>
    /// <b>Drift guard:</b> <c>BaseConsole.Core.Messaging.InstanceId.Resolve</c> mirrors this
    /// precedence, and a test asserts the two agree across the cases that distinguish them. Edit both
    /// together.
    /// </para>
    /// </summary>
    private static string ResolveInstanceId()
    {
        var candidates = new[]
        {
            Environment.GetEnvironmentVariable("POD_NAME"),
            Environment.GetEnvironmentVariable("HOSTNAME"),
            Environment.MachineName,
        };

        // The machine name is effectively non-null; the GUID is the final fallback.
        return Array.Find(candidates, c => !string.IsNullOrWhiteSpace(c))
               ?? Guid.NewGuid().ToString("N");
    }
}

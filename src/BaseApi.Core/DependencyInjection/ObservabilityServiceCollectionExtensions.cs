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
    /// The coarse emitter class stamped on every log record's resource. Required, and mirrored by the
    /// console host's equivalent, so one attribute selects an emitter class across the whole stack.
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

        // The emitter class rides on both resources under each signal's own casing convention:
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

        // The versioned service name is set on the meter provider's own resource via
        // SetResourceBuilder, never via the shared ConfigureResource. In this OpenTelemetry version
        // the shared configuration overrides the logs provider's own resource builder, so a
        // versioned name set there leaks onto logs — which breaks any log query that filters on the
        // bare service name. A per-provider resource keeps metrics versioned while logs stay bare.
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
                // The metrics-side ASP.NET Core instrumentation is parameterless in this version —
                // there is no filter overload on the meter provider builder — so health-endpoint
                // metrics are filtered at the collector instead.
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation()
                .AddOtlpExporter());

        return builder;
    }

    /// <summary>
    /// Resolves the per-replica instance id from POD_NAME, then HOSTNAME, then the machine name,
    /// falling back to a new GUID. Duplicated independently in the console base library, which is
    /// forbidden from referencing this assembly.
    /// <para>
    /// <b>Drift guard:</b> this precedence expression is mirrored byte-for-byte in the console base
    /// library's equivalent resolver and in the test that exists to catch precedence drift. Edit all
    /// three together.
    /// </para>
    /// </summary>
    private static string ResolveInstanceId() =>
        Environment.GetEnvironmentVariable("POD_NAME")
        ?? Environment.GetEnvironmentVariable("HOSTNAME")
        ?? Environment.MachineName
        ?? Guid.NewGuid().ToString("N");   // the machine name is effectively non-null; the GUID is the final fallback
}

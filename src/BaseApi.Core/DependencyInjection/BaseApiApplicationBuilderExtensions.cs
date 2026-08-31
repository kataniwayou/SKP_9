using Asp.Versioning.ApiExplorer;
using BaseApi.Core.Health;
using BaseApi.Core.Middleware;
using HealthChecks.UI.Client;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// The middleware pipeline, in a locked order:
/// <list type="number">
///   <item><c>UseExceptionHandler</c> first, so it wraps everything after it.</item>
///   <item>The correlation-id middleware, which stamps the id onto the request items.</item>
///   <item><c>UseRouting</c>.</item>
///   <item>Swagger and its UI, in development only.</item>
///   <item>The three health endpoints, each selected by tag.</item>
/// </list>
/// <c>MapControllers</c> is deliberately left to the composition root rather than called here, so a
/// test host can map controllers independently of this pipeline.
/// </summary>
public static class BaseApiApplicationBuilderExtensions
{
    public static WebApplication UseBaseApi(this WebApplication app)
    {
        app.UseExceptionHandler();                                       // must be first
        app.UseMiddleware<CorrelationIdMiddleware>();
        app.UseRouting();
        // CORS is deliberately omitted — no policy is specified for this service.

        if (app.Environment.IsDevelopment())
        {
            app.UseSwagger();
            app.UseSwaggerUI(opts =>
            {
                foreach (var description in app.DescribeApiVersions())
                {
                    opts.SwaggerEndpoint(
                        $"/swagger/{description.GroupName}/swagger.json",
                        description.GroupName.ToUpperInvariant());
                }
            });
        }

        MapProbe(app, "live");
        MapProbe(app, "ready");
        MapProbe(app, "startup");

        return app;
    }

    /// <summary>
    /// One endpoint, selected by tag, that logs its outcome and then renders the body exactly as
    /// before. The log line is deliberately identical to the one the workers' embedded endpoint
    /// writes — same category, same template — so a single query covers the API, the orchestrator and
    /// every processor rather than three service-shaped variants of the same question.
    /// <para>
    /// The ASP.NET Core request log already reports these hits, but only as a URL and a status code,
    /// and only on a host that has request logging enabled. A worker has neither. This line is what
    /// makes the three services answer the same way.
    /// </para>
    /// </summary>
    /// <remarks>
    /// Internal rather than private so a test can map it onto a bare host and drive it over real
    /// HTTP. <c>UseBaseApi</c> itself needs the whole API service graph — versioning, Swagger,
    /// EF — which would make the probe's log line untestable in practice.
    /// </remarks>
    internal static void MapProbe(WebApplication app, string tag) =>
        app.MapHealthChecks($"/health/{tag}", new HealthCheckOptions
        {
            Predicate      = c => c.Tags.Contains(tag),
            ResponseWriter = (context, report) =>
            {
                // The middleware sets the status code from ResultStatusCodes before invoking the
                // writer, so this reads the value the kubelet will actually receive rather than a
                // second, independently derived guess at it.
                HealthProbeLog.Write(
                    context.RequestServices
                        .GetRequiredService<ILoggerFactory>()
                        .CreateLogger(HealthProbeLog.Category),
                    tag,
                    report,
                    context.Response.StatusCode);

                return UIResponseWriter.WriteHealthCheckUIResponse(context, report);
            },
        });
}

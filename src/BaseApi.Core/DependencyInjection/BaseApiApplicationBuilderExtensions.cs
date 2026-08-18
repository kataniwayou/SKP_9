using Asp.Versioning.ApiExplorer;
using BaseApi.Core.Middleware;
using HealthChecks.UI.Client;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Hosting;

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

        app.MapHealthChecks("/health/live", new HealthCheckOptions
        {
            Predicate      = c => c.Tags.Contains("live"),
            ResponseWriter = UIResponseWriter.WriteHealthCheckUIResponse,
        });
        app.MapHealthChecks("/health/ready", new HealthCheckOptions
        {
            Predicate      = c => c.Tags.Contains("ready"),
            ResponseWriter = UIResponseWriter.WriteHealthCheckUIResponse,
        });
        app.MapHealthChecks("/health/startup", new HealthCheckOptions
        {
            Predicate      = c => c.Tags.Contains("startup"),
            ResponseWriter = UIResponseWriter.WriteHealthCheckUIResponse,
        });

        return app;
    }
}

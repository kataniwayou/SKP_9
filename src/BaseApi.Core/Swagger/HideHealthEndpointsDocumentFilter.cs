using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace BaseApi.Core.Swagger;

/// <summary>
/// Removes any path starting with <c>/health</c> from the generated OpenAPI document. Health
/// endpoints are mapped directly rather than as controller actions, so they usually do not reach the
/// API explorer at all — this filter is defence in depth, mirroring the same exclusion applied to
/// trace instrumentation.
/// </summary>
internal sealed class HideHealthEndpointsDocumentFilter : IDocumentFilter
{
    public void Apply(OpenApiDocument swaggerDoc, DocumentFilterContext context)
    {
        var pathsToRemove = swaggerDoc.Paths
            .Where(kv => kv.Key.StartsWith("/health", StringComparison.OrdinalIgnoreCase))
            .Select(kv => kv.Key)
            .ToList();

        foreach (var path in pathsToRemove)
        {
            swaggerDoc.Paths.Remove(path);
        }
    }
}

using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace BaseApi.Core.Swagger;

/// <summary>
/// Documents <c>X-Correlation-Id</c> as an optional header parameter on every operation. The server
/// generates the value when it is absent and echoes it on the response header. The 128-character
/// maximum matches the guard in
/// <see cref="BaseApi.Core.Middleware.CorrelationIdMiddleware"/>.
/// </summary>
internal sealed class CorrelationIdHeaderOperationFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        operation.Parameters ??= new List<OpenApiParameter>();
        operation.Parameters.Add(new OpenApiParameter
        {
            Name        = "X-Correlation-Id",
            In          = ParameterLocation.Header,
            Required    = false,
            Description = "Optional correlation ID for request tracking. If absent, the server " +
                          "generates a new 32-char hex value and echoes it on the response header.",
            Schema      = new OpenApiSchema { Type = "string", MaxLength = 128 },
        });
    }
}

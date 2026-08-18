using Asp.Versioning.ApiExplorer;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace BaseApi.Core.Swagger;

/// <summary>
/// Generates one Swagger document per discovered <see cref="ApiVersionDescription"/>, so adding a
/// new API version is just an <c>[ApiVersion]</c> attribute on a sibling controller.
/// </summary>
internal sealed class ConfigureSwaggerOptions : IConfigureOptions<SwaggerGenOptions>
{
    private readonly IApiVersionDescriptionProvider _provider;
    private readonly IConfiguration _cfg;

    public ConfigureSwaggerOptions(IApiVersionDescriptionProvider provider, IConfiguration cfg)
    {
        _provider = provider;
        _cfg = cfg;
    }

    public void Configure(SwaggerGenOptions options)
    {
        foreach (var description in _provider.ApiVersionDescriptions)
        {
            options.SwaggerDoc(description.GroupName, new OpenApiInfo
            {
                Title       = _cfg["Service:Name"] ?? "sk-api",
                Version     = description.ApiVersion.ToString(),
                Description = "Steps API — workflow-engine CRUD foundation."
                            + (description.IsDeprecated ? " DEPRECATED." : ""),
            });
        }

        options.OperationFilter<CorrelationIdHeaderOperationFilter>();
        options.DocumentFilter<HideHealthEndpointsDocumentFilter>();
    }
}

using Asp.Versioning;
using BaseApi.Core.Swagger;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// HTTP wiring: controllers, URL-segment API versioning, the API explorer and Swagger generation.
/// The versioning chain must run before <c>AddSwaggerGen</c>, because
/// <see cref="ConfigureSwaggerOptions"/> resolves <c>IApiVersionDescriptionProvider</c>, which the
/// API explorer registers.
/// </summary>
internal static class HttpServiceCollectionExtensions
{
    internal static IServiceCollection AddBaseApiHttp(
        this IServiceCollection services, IConfiguration cfg)
    {
        services.AddControllers();

        services.AddApiVersioning(opts =>
        {
            opts.DefaultApiVersion = new ApiVersion(1, 0);
            opts.AssumeDefaultVersionWhenUnspecified = true;
            opts.ReportApiVersions = true;
            // The URL-segment reader is the default when the route template contains {version:apiVersion}.
        })
        .AddMvc()                                  // requires the Asp.Versioning.Mvc package, not just .Http
        .AddApiExplorer(opts =>
        {
            opts.GroupNameFormat = "'v'VVV";        // renders as "v1"
            opts.SubstituteApiVersionInUrl = true;  // {version:apiVersion} becomes "1"
        });

        services.AddEndpointsApiExplorer();
        services.AddSwaggerGen();
        services.AddTransient<IConfigureOptions<SwaggerGenOptions>, ConfigureSwaggerOptions>();

        return services;
    }
}

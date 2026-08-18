using System.Reflection;
using FluentValidation;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// Wires FluentValidation validator auto-discovery by assembly scan, registering each validator as
/// scoped to match the request-scoped persistence lifetime. The <c>params</c> signature lets the
/// production composition root pass one assembly and a test host pass its own alongside it.
/// </summary>
public static class ValidationServiceCollectionExtensions
{
    public static IServiceCollection AddBaseApiValidation(
        this IServiceCollection services,
        params Assembly[] assemblies)
    {
        foreach (var assembly in assemblies)
        {
            services.AddValidatorsFromAssembly(
                assembly,
                lifetime: ServiceLifetime.Scoped,
                includeInternalTypes: false);
        }
        return services;
    }
}

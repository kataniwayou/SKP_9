using System.Reflection;
using BaseApi.Core.Mapping;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// Auto-discovers every closed-generic <see cref="IEntityMapper{TEntity,TCreate,TUpdate,TRead}"/>
/// implementation in the supplied assemblies and registers each as a singleton. Mappers are
/// stateless: the source generator emits pure functions with no fields and no captured services.
///
/// <para>
/// The scan uses <see cref="Assembly.GetExportedTypes()"/> rather than
/// <see cref="Assembly.GetTypes()"/>, so a partially-built assembly during an incremental IDE build
/// cannot raise <see cref="ReflectionTypeLoadException"/>.
/// </para>
/// </summary>
public static class MappingServiceCollectionExtensions
{
    public static IServiceCollection AddBaseApiMapping(
        this IServiceCollection services,
        params Assembly[] assemblies)
    {
        foreach (var assembly in assemblies)
        {
            foreach (var type in assembly.GetExportedTypes())
            {
                if (type.IsAbstract || type.IsInterface) continue;

                var closedInterfaces = type.GetInterfaces()
                    .Where(i => i.IsGenericType &&
                                i.GetGenericTypeDefinition() == typeof(IEntityMapper<,,,>));

                foreach (var closedInterface in closedInterfaces)
                {
                    services.AddSingleton(closedInterface, type);
                }
            }
        }
        return services;
    }
}

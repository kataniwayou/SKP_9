using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Orchestration.Loading;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Orchestration.Validation;
using Messaging.Transport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// Per-feature registration for the orchestration feature folder, wired by
/// <see cref="BaseApi.Service.Composition.AppFeatures.AddAppFeatures"/> after the entity features.
/// <para>
/// Simpler than the entity feature extensions: no abstract-base service alias is needed, because
/// <see cref="OrchestrationController"/> injects the concrete <see cref="OrchestrationService"/>
/// directly — there is no abstract base for orchestration to inherit from.
/// </para>
/// <para>
/// <b>Registered elsewhere, deliberately not here:</b>
/// <list type="bullet">
///   <item>The entity mappers, discovered by the closed-generic mapper scan.</item>
///   <item>The <see cref="BaseDbContext"/> alias, registered scoped by the persistence wiring.</item>
/// </list>
/// </para>
/// </summary>
internal static class OrchestrationServiceCollectionExtensions
{
    public static IServiceCollection AddOrchestrationFeature(this IServiceCollection services)
    {
        // Scoped, because the loader and the service both depend on the scoped context — a
        // singleton here would be a captive-dependency bug. The snapshot itself is not registered:
        // the loader constructs it directly, and only its logger comes from the container.
        //
        // The service is registered through an explicit factory rather than the typed overload
        // because its constructor is internal: the signature exposes internal seam types, which the
        // compiler forbids on a public constructor, while the class stays public and sealed so the
        // controller can inject the concrete type. A typed registration reflects for a public
        // constructor and would fail at build validation; the factory invokes the internal one
        // directly from inside this assembly.
        services.AddScoped<OrchestrationService>(sp => new OrchestrationService(
            sp.GetRequiredService<BaseDbContext>(),
            sp.GetRequiredService<IWorkflowGraphLoader>(),
            sp.GetRequiredService<CycleDetector>(),
            sp.GetRequiredService<SchemaEdgeValidator>(),
            sp.GetRequiredService<PayloadConfigSchemaValidator>(),
            sp.GetRequiredService<ProcessorLivenessValidator>(),
            sp.GetRequiredService<IQueueSender>(),
            sp.GetRequiredService<ILogger<OrchestrationService>>()));
        services.AddScoped<IWorkflowGraphLoader, WorkflowGraphLoader>();
        services.AddScoped<CycleDetector>();
        services.AddScoped<SchemaEdgeValidator>();
        services.AddScoped<PayloadConfigSchemaValidator>();
        // The liveness gate's multiplexer and time-provider dependencies are already in the
        // container, registered by the base API wiring.
        services.AddScoped<ProcessorLivenessValidator>();

        // The projection read/write pair, used only by the queue handlers. Scoped so a handler
        // resolved per delivery gets its own, matching every other dependency in this folder; both
        // are stateless over an injected multiplexer, so the lifetime costs nothing.
        services.AddScoped<L2Cleanup>();
        services.AddScoped<L2ProjectionWriter>();

        // Registered here so it lands after the core not-found, validation and database handlers
        // and before the split-out catch-all, which the composition root registers last — after
        // this method has run. Reachable, and emits a 422.
        services.AddExceptionHandler<OrchestrationValidationExceptionHandler>();
        return services;
    }
}

using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Board;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Liveness;
using BaseApi.Service.Features.Molecule;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Composition;

/// <summary>
/// Aggregates the six per-entity feature registrations and the orchestration feature into one call,
/// invoked from the composition root after the base API registration. Each per-entity extension
/// registers its concrete service plus the abstract-base alias its empty-body controller injects.
/// The orchestration extension is simpler, because its controller injects the concrete service
/// directly.
/// <para>
/// Internal, because the composition root lives in the same assembly — and the base API library
/// stays unaware of the concrete entity types, which is the abstraction boundary.
/// </para>
/// </summary>
internal static class AppFeatures
{
    public static IServiceCollection AddAppFeatures(this IServiceCollection services, IConfiguration cfg)
    {
        services.AddExceptionHandler<BadHttpRequestExceptionHandler>();   // Kestrel's 413 etc., ahead of the catch-all
        services.AddSchemaFeature();
        services.AddCacheFeature();
        services.AddProcessorFeature();
        services.AddStepFeature();
        services.AddAssignmentFeature();
        services.AddWorkflowFeature();
        services.AddOrchestrationFeature();
        services.AddMoleculeFeature();
        services.AddLivenessFeature(cfg);
        // Waits for the migration runner's flag, then fills missing board locations from old layouts once.
        services.AddHostedService<LocationFillService>();
        return services;
    }
}

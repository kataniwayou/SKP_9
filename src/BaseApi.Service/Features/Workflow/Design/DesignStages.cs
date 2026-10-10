using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// The dry run's stages in the spec's order (plan 8 §4.3): schemas, processors, caches, steps, wires, assignments,
/// workflow; then deletes (2026-10-10), once nothing of this workflow lists what goes.
/// </summary>
internal static class DesignStages
{
    public static IReadOnlyList<IDesignStage> Ordered(IServiceProvider sp) =>
    [
        sp.GetRequiredService<SchemaStage>(),
        sp.GetRequiredService<ProcessorStage>(),
        sp.GetRequiredService<CacheStage>(),
        sp.GetRequiredService<StepStage>(),
        sp.GetRequiredService<WireStage>(),
        sp.GetRequiredService<AssignmentStage>(),
        sp.GetRequiredService<WorkflowStage>(),
        sp.GetRequiredService<DeleteStage>(),
    ];
}

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>The dry run's stages in the spec's order (plan 8 §4.3): schemas, processors, caches, steps, wires, assignments, workflow.</summary>
internal static class DesignStages
{
    public static IReadOnlyList<IDesignStage> Ordered(IServiceProvider sp) => [];
}

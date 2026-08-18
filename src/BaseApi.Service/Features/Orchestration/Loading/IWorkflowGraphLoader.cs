using BaseApi.Service.Features.Orchestration;

namespace BaseApi.Service.Features.Orchestration.Loading;

internal interface IWorkflowGraphLoader
{
    Task<WorkflowGraphSnapshot> LoadL1Async(IReadOnlyList<Guid> workflowIds, CancellationToken ct);
}

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>Creates or replaces a workflow's whole graph in one commit.</summary>
public interface IWorkflowGraphSaver
{
    /// <summary>Saves the graph and returns it re-read.</summary>
    Task<WorkflowGraphDto> SaveAsync(Guid workflowId, GraphSaveRequest request, CancellationToken ct);
}

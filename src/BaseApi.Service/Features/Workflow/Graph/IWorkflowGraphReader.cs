namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>Reads a workflow's whole graph for the editor.</summary>
public interface IWorkflowGraphReader
{
    /// <summary>The graph, or <see cref="BaseApi.Core.Exceptions.NotFoundException"/> when the workflow does not exist.</summary>
    Task<WorkflowGraphDto> ReadAsync(Guid workflowId, CancellationToken ct);
}

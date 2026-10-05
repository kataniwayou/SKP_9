using BaseApi.Service.Features.Workflow.Graph;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// One start-gate problem, described exactly as a start's 422 describes it: the gate, its title, the
/// detail, and the gate's offending payload (entity ids and flattened messages only).
/// </summary>
public sealed record WorkflowProblemDto(string Gate, string Title, string Detail, object Offending);

/// <summary>Every problem a start of this workflow would refuse, from every gate, in gate order.</summary>
public sealed record WorkflowValidationDto(bool Valid, List<WorkflowProblemDto> Problems);

/// <summary>
/// Runs every workflow-start gate against a draft, or the stored workflow when there is none, without
/// saving and without starting. One implementation of each rule: the studio never re-implements them.
/// </summary>
public interface IWorkflowValidator
{
    Task<WorkflowValidationDto> ValidateAsync(Guid workflowId, GraphSaveRequest? draft, CancellationToken ct);
}

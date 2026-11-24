namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// One start-gate problem, described exactly as a start's 422 describes it: the gate, its title, the
/// detail, and the gate's offending payload (entity ids and flattened messages only).
/// </summary>
public sealed record WorkflowProblemDto(string Gate, string Title, string Detail, object Offending);

/// <summary>Every problem a start of this workflow would refuse, from every gate, in gate order.</summary>
public sealed record WorkflowValidationDto(bool Valid, List<WorkflowProblemDto> Problems);

/// <summary>
/// Runs every workflow-start gate against the stored workflow, without starting. One implementation of
/// each rule: the board never re-implements them.
/// </summary>
public interface IWorkflowValidator
{
    Task<WorkflowValidationDto> ValidateAsync(Guid workflowId, CancellationToken ct);
}

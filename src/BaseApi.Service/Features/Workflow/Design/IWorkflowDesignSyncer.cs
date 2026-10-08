namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>Saves the SKP Studio's design of one workflow (plan 8 §4.2-§4.3).</summary>
public interface IWorkflowDesignSyncer
{
    /// <summary>
    /// Stores the design on the workflow (always), then dry-runs it and, only when it finds no errors,
    /// aligns the real entities with it in one transaction. <see cref="FluentValidation.ValidationException"/>
    /// for a body that is not a design; <see cref="BaseApi.Core.Exceptions.NotFoundException"/> for an unknown workflow.
    /// </summary>
    Task<DesignOutcomeDto> SaveAsync(Guid workflowId, DesignSaveRequest request, CancellationToken ct);
}

using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Core.Services;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Workflow service. Unlike the step service, which has one junction, the workflow has two — its
/// entry steps and its assignments — and the override syncs both within a single save.
/// <para>
/// The override runs between the add and the save in the locked create order, so every staged change
/// commits in the same transaction.
/// </para>
/// <para>
/// On create it inserts one row per entry-step id, which the validator requires to be non-empty, and
/// one row per assignment id when that collection is present. On update it first removes every
/// existing row for this workflow from <i>both</i> junctions, then inserts the new sets —
/// remove-and-replace, so clients submit the desired final state for both collections.
/// </para>
/// </summary>
public sealed class WorkflowService :
    BaseService<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto>
{
    public WorkflowService(
        IValidator<WorkflowCreateDto> createValidator,
        IValidator<WorkflowUpdateDto> updateValidator,
        IEntityMapper<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> mapper,
        IRepository<WorkflowEntity> repo,
        BaseDbContext dbContext)
        : base(createValidator, updateValidator, mapper, repo, dbContext) { }

    /// <summary>
    /// Synchronizes both junctions with the entry-step and assignment collections on whichever DTO
    /// was supplied. Called between the add or update and the save, inside the locked verb order.
    /// </summary>
    protected override async Task SyncJunctionsAsync(
        WorkflowEntity entity,
        WorkflowCreateDto? createDto,
        WorkflowUpdateDto? updateDto,
        CancellationToken ct)
    {
        var entryStepsSet = DbContext.Set<WorkflowEntrySteps>();
        var assignmentsSet = DbContext.Set<WorkflowAssignments>();

        // On update, clear the existing rows on both junctions before adding the new ones.
        if (updateDto is not null)
        {
            var existingEntrySteps = await entryStepsSet
                .Where(j => j.WorkflowId == entity.Id)
                .ToListAsync(ct);
            if (existingEntrySteps.Count > 0)
            {
                entryStepsSet.RemoveRange(existingEntrySteps);
            }

            var existingAssignments = await assignmentsSet
                .Where(j => j.WorkflowId == entity.Id)
                .ToListAsync(ct);
            if (existingAssignments.Count > 0)
            {
                assignmentsSet.RemoveRange(existingAssignments);
            }
        }

        // The entry-step collection is required and non-empty by the DTO and validator contract.
        var entryStepIds = createDto?.EntryStepIds ?? updateDto?.EntryStepIds ?? new List<Guid>();
        if (entryStepIds.Count > 0)
        {
            var rows = entryStepIds.Select(stepId => new WorkflowEntrySteps
            {
                WorkflowId = entity.Id,
                StepId = stepId,
            });
            await entryStepsSet.AddRangeAsync(rows, ct);
        }

        // The assignment collection is optional, so insert only when it is present and non-empty.
        var assignmentIds = createDto?.AssignmentIds ?? updateDto?.AssignmentIds;
        if (assignmentIds is { Count: > 0 })
        {
            var rows = assignmentIds.Select(assignmentId => new WorkflowAssignments
            {
                WorkflowId = entity.Id,
                AssignmentId = assignmentId,
            });
            await assignmentsSet.AddRangeAsync(rows, ct);
        }
    }
}

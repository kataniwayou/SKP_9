using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Core.Services;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Workflow service. Unlike the step service, which has one junction, the workflow has three — its
/// entry steps, its assignments and its caches — and the override syncs all three within a single
/// save.
/// <para>
/// The override runs between the add and the save in the locked create order, so every staged change
/// commits in the same transaction.
/// </para>
/// <para>
/// On create it inserts one row per entry-step id, which the validator requires to be non-empty, and
/// one row per assignment id or cache id when that collection is present. On update it first removes
/// every existing row for this workflow from <i>all three</i> junctions, then inserts the new sets —
/// remove-and-replace, so clients submit the desired final state for every collection.
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
    /// Synchronizes all three junctions with the entry-step, assignment and cache collections on
    /// whichever DTO was supplied. Called between the add or update and the save, inside the locked
    /// verb order.
    /// </summary>
    protected override async Task SyncJunctionsAsync(
        WorkflowEntity entity,
        WorkflowCreateDto? createDto,
        WorkflowUpdateDto? updateDto,
        CancellationToken ct)
    {
        var entryStepsSet = DbContext.Set<WorkflowEntrySteps>();
        var assignmentsSet = DbContext.Set<WorkflowAssignments>();
        var cachesSet = DbContext.Set<WorkflowCaches>();

        // On update, clear the existing rows on all three junctions before adding the new ones.
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

            var existingCaches = await cachesSet
                .Where(j => j.WorkflowId == entity.Id)
                .ToListAsync(ct);

            if (existingCaches.Count > 0)
            {
                cachesSet.RemoveRange(existingCaches);
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

        // The cache collection is optional, so insert only when it is present and non-empty.
        var cacheIds = createDto?.CacheIds ?? updateDto?.CacheIds;

        if (cacheIds is { Count: > 0 })
        {
            var rows = cacheIds.Select(cacheId => new WorkflowCaches
            {
                WorkflowId = entity.Id,
                CacheId = cacheId,
            });

            await cachesSet.AddRangeAsync(rows, ct);
        }
    }

    /// <summary>
    /// Populates <see cref="WorkflowReadDto.EntryStepIds"/>, <see cref="WorkflowReadDto.AssignmentIds"/>
    /// and <see cref="WorkflowReadDto.CacheIds"/> from the three junction tables — the same enrichment
    /// technique <c>WorkflowGraphLoader</c> uses for the orchestration path, applied to the read path
    /// so a client can see the bindings it wrote.
    /// <para>
    /// One query per junction for the whole batch, keyed by workflow id, rather than one pair per row.
    /// A workflow with no assignments (or no caches) gets an empty list rather than null: null used to
    /// mean "not populated", and leaving it would keep the field ambiguous exactly where it is now
    /// meaningful.
    /// </para>
    /// </summary>
    protected override async Task<IReadOnlyList<WorkflowReadDto>> EnrichReadAsync(
        IReadOnlyList<WorkflowReadDto> dtos, CancellationToken ct)
    {
        if (dtos.Count == 0)
        {
            return dtos;
        }

        var ids = dtos.Select(d => d.Id).ToList();

        var entryRows = await DbContext.Set<WorkflowEntrySteps>().AsNoTracking()
            .Where(j => ids.Contains(j.WorkflowId))
            .ToListAsync(ct);
        var entryLookup = entryRows.GroupBy(j => j.WorkflowId)
            .ToDictionary(g => g.Key, g => g.Select(j => j.StepId).ToList());

        var assignmentRows = await DbContext.Set<WorkflowAssignments>().AsNoTracking()
            .Where(j => ids.Contains(j.WorkflowId))
            .ToListAsync(ct);
        var assignmentLookup = assignmentRows.GroupBy(j => j.WorkflowId)
            .ToDictionary(g => g.Key, g => g.Select(j => j.AssignmentId).ToList());

        var cacheRows = await DbContext.Set<WorkflowCaches>().AsNoTracking()
            .Where(j => ids.Contains(j.WorkflowId))
            .ToListAsync(ct);

        var cacheLookup = cacheRows.GroupBy(j => j.WorkflowId)
            .ToDictionary(g => g.Key, g => g.Select(j => j.CacheId).ToList());

        return dtos
            .Select(d => d with
            {
                EntryStepIds = entryLookup.GetValueOrDefault(d.Id) ?? new List<Guid>(),
                AssignmentIds = assignmentLookup.GetValueOrDefault(d.Id) ?? new List<Guid>(),
                CacheIds = cacheLookup.GetValueOrDefault(d.Id) ?? new List<Guid>(),
            })
            .ToList();
    }
}

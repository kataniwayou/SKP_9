using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Core.Services;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Step;

/// <summary>
/// Step service. It overrides the junction-sync hook to persist the next-step collection into the
/// <see cref="StepNextSteps"/> table. The override runs between the add and the save in the locked
/// create order, so every staged change commits in the same transaction.
/// <para>
/// On create it inserts one junction row per next-step id. On update it first removes every existing
/// row for this step, then inserts the new set — remove-and-replace, so clients submit the desired
/// final state rather than a delta.
/// </para>
/// </summary>
public sealed class StepService :
    BaseService<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto>
{
    public StepService(
        IValidator<StepCreateDto> createValidator,
        IValidator<StepUpdateDto> updateValidator,
        IEntityMapper<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> mapper,
        IRepository<StepEntity> repo,
        BaseDbContext dbContext)
        : base(createValidator, updateValidator, mapper, repo, dbContext) { }

    /// <summary>
    /// Synchronizes the junction rows with the next-step collection on whichever DTO was supplied.
    /// Called between the add or update and the save, inside the locked verb order.
    /// </summary>
    protected override async Task SyncJunctionsAsync(
        StepEntity entity,
        StepCreateDto? createDto,
        StepUpdateDto? updateDto,
        CancellationToken ct)
    {
        var junctionSet = DbContext.Set<StepNextSteps>();

        // On update, clear the existing rows before adding the new ones.
        if (updateDto is not null)
        {
            var existing = await junctionSet
                .Where(j => j.StepId == entity.Id)
                .ToListAsync(ct);
            if (existing.Count > 0)
            {
                junctionSet.RemoveRange(existing);
            }
        }

        var newIds = createDto?.NextStepIds ?? updateDto?.NextStepIds;
        if (newIds is { Count: > 0 })
        {
            var rows = newIds.Select(nextId => new StepNextSteps
            {
                StepId = entity.Id,
                NextStepId = nextId,
            });
            await junctionSet.AddRangeAsync(rows, ct);
        }
    }
}

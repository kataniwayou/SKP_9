using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Exceptions;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>One stage of the dry run (plan 8 §4.3), run in order by <see cref="WorkflowDesignSyncer"/>.</summary>
internal interface IDesignStage
{
    Task RunAsync(DesignRun run, CancellationToken ct);
}

/// <summary>
/// One design save's state while the stages run: the request, every error so far, and what later stages
/// depend on (failed copies and steps, created and deleted assignments).
/// </summary>
internal sealed class DesignRun
{
    /// <summary>The owned-entity conflict message (spec §4.3), exactly.</summary>
    public const string Conflict = "changed by someone else since you opened it";

    private readonly BaseDbContext _db;
    private readonly IDesignTransaction _tx;
    private int _units;

    public DesignRun(Guid workflowId, DesignSaveRequest request, BaseDbContext db, IDesignTransaction tx)
    {
        WorkflowId = workflowId;
        Request = request;
        _db = db;
        _tx = tx;
    }

    public Guid WorkflowId { get; }
    public DesignSaveRequest Request { get; }
    public List<DesignErrorDto> Errors { get; } = [];
    public HashSet<Guid> FailedSchemas { get; } = [];
    public HashSet<Guid> FailedSteps { get; } = [];
    public List<Guid> CreatedAssignments { get; } = [];
    public List<Guid> DeletedAssignments { get; } = [];

    public void Fail(string kind, Guid id, string stage, string? field, string message) =>
        Errors.Add(new DesignErrorDto(kind, id, stage, field, message));

    /// <summary>Stale when the stored row is newer than what the designer loaded, or no stamp was sent.</summary>
    public static bool IsStale(DateTime stored, DateTime? loaded) => loaded is null || stored > loaded.Value;

    /// <summary>
    /// One entity's change inside its own savepoint (spec §4.3): <paramref name="stageChange"/> loads, checks
    /// and stages the change, returning why it may not happen; with no reason it is saved. A reason, or a
    /// database error at the save, rolls back to the savepoint and becomes this entity's error, and the
    /// stages go on. The tracker is cleared either way, so nothing of a failed entity reaches the next save.
    /// True when the change was applied.
    /// </summary>
    public async Task<bool> UnitAsync(string kind, Guid id, string stage, Func<Task<List<FieldError>>> stageChange, CancellationToken ct, bool shared = false)
    {
        // A shared entity is last write wins: if someone else's write lands between the load and the save, the
        // unit runs again on a fresh load rather than reporting the owned conflict. Owned entities report it.
        for (var attempt = 1; ; attempt++)
        {
            var savepoint = $"design_unit_{++_units}";
            await _tx.SavepointAsync(savepoint, ct);
            try
            {
                var problems = await stageChange();
                if (problems.Count > 0)
                {
                    foreach (var p in problems) Fail(kind, id, stage, p.Field, p.Message);
                    await _tx.RollbackToSavepointAsync(savepoint, ct);
                    return false;
                }
                await _db.SaveChangesAsync(ct);
                await _tx.ReleaseSavepointAsync(savepoint, ct);
                return true;
            }
            catch (DbUpdateException ex)
            {
                // not the request's token: a cancelled request must still leave the transaction usable for its rollback
                await _tx.RollbackToSavepointAsync(savepoint, CancellationToken.None);
                if (shared && ex is DbUpdateConcurrencyException && attempt < SharedAttempts) continue;
                var (field, message) = Describe(ex, shared);
                Fail(kind, id, stage, field, message);
                return false;
            }
            finally
            {
                _db.ChangeTracker.Clear();
            }
        }
    }

    private const int SharedAttempts = 3;

    private static (string? Field, string Message) Describe(DbUpdateException ex, bool shared)
    {
        if (ex is DbUpdateConcurrencyException) return (null, shared ? "The database refused this change." : Conflict);
        if (PostgresExceptionMapper.TryMap(ex, out _, out var detail, out var column))
            return (column is null ? null : DesignFields.FieldOf(column), detail);
        return (null, "The database refused this change.");
    }
}

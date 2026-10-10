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
    /// <summary>Steps the steps stage created (2026-10-10, paste): the wires stage writes their next steps.</summary>
    public HashSet<Guid> CreatedSteps { get; } = [];
    public List<Guid> CreatedAssignments { get; } = [];
    public List<Guid> DeletedAssignments { get; } = [];
    /// <summary>Assignments the assignment stage unlinked from this workflow (deleted ones that it listed).</summary>
    public HashSet<Guid> UnlinkedAssignments { get; } = [];
    /// <summary>The names of this design's assignments as the assignment stage found them (a deleted one keeps its name for the log).</summary>
    public Dictionary<Guid, string> AssignmentNames { get; } = [];

    /// <summary>What the save did, in order (the answer's <see cref="DesignOutcomeDto.Log"/>).</summary>
    public List<DesignLogDto> Log { get; } = [];

    private readonly Dictionary<Guid, string> _labels = [];
    private Tally? _tally;

    /// <summary>An entity's error: the answer's error list, and an error line in the log naming it.</summary>
    public void Fail(string kind, Guid id, string stage, string? field, string message)
    {
        Errors.Add(new DesignErrorDto(kind, id, stage, field, message));
        Log.Add(new DesignLogDto(stage, "error", kind, id, $"{LabelOf(kind, id)}: {(field is null ? "" : field + ": ")}{message}"));
        if (_tally is { } t && t.Stage == stage) t.Refused.Add(id);
    }

    /// <summary>A line of the log that is not about one entity's change (the store, the outcome).</summary>
    public void Note(string stage, string kind, string message, string level = "info") =>
        Log.Add(new DesignLogDto(stage, level, kind, null, message));

    /// <summary>How the log names an entity, e.g. <c>step 'a'</c>; the stages name what they load.</summary>
    public void Label(Guid id, string label) => _labels[id] = label;

    public string LabelOf(string kind, Guid id) => _labels.TryGetValue(id, out var label) ? label : $"{kind} {id}";

    /// <summary>
    /// A stage starts: one line with how many entities it has to look at, or one line saying it has none
    /// (and then <see cref="EndStage"/> writes nothing).
    /// </summary>
    public void BeginStage(string stage, int count, string noun)
    {
        _tally = new Tally(stage, count);
        Note(stage, "stage", count == 0 ? $"{stage}: nothing to do" : $"{stage}: {count} {noun}");
    }

    /// <summary>
    /// One entity this stage changed, with what changed; counted under <paramref name="verb"/> (e.g. "updated"), unless
    /// this stage already refused it (then it is counted once, as refused, and the line still says what it changed).
    /// </summary>
    /// <param name="kind">The entity kind.</param>
    /// <param name="id">The entity.</param>
    /// <param name="verb">What the stage's counts call it ("updated", "created").</param>
    /// <param name="message">What changed.</param>
    /// <param name="sentence">The message goes on after the label as one sentence ("step 'x' created"), not after a colon.</param>
    public void Changed(string kind, Guid id, string verb, string message, bool sentence = false)
    {
        var t = _tally ?? throw new InvalidOperationException("Changed outside a stage.");
        if (!t.Refused.Contains(id)) t.Done[verb] = t.Done.GetValueOrDefault(verb) + 1;
        Log.Add(new DesignLogDto(t.Stage, "info", kind, id, $"{LabelOf(kind, id)}{(sentence ? " " : ": ")}{message}"));
    }

    /// <summary>One entity this stage looked at and left as it was (no line of its own, only the count; refused wins).</summary>
    public void Unchanged(Guid id)
    {
        var t = _tally ?? throw new InvalidOperationException("Unchanged outside a stage.");
        if (!t.Refused.Contains(id)) t.Unchanged++;
    }

    /// <summary>The save is rolled back: every change line so far is marked undone (the database never kept it).</summary>
    public void MarkRolledBack()
    {
        for (var i = 0; i < Log.Count; i++)
        {
            var l = Log[i];
            if (l.Level == "info" && l.Id is not null && l.Kind != "stage" && l.Kind != "outcome") Log[i] = l with { RolledBack = true };
        }
    }

    /// <summary>A stage is done: one line with its counts ("steps: 3 updated, 1 unchanged, 1 refused").</summary>
    public void EndStage()
    {
        if (_tally is not { } t) return;
        _tally = null;
        if (t.Count == 0) return;
        var parts = t.Done.Select(kv => $"{kv.Value} {kv.Key}").ToList();
        if (t.Unchanged > 0) parts.Add($"{t.Unchanged} unchanged");
        if (t.Refused.Count > 0) parts.Add($"{t.Refused.Count} refused");
        Log.Add(new DesignLogDto(t.Stage, t.Refused.Count > 0 ? "error" : "info", "stage",
            null, $"{t.Stage}: {(parts.Count == 0 ? "nothing changed" : string.Join(", ", parts))}"));
    }

    private sealed class Tally(string stage, int count)
    {
        public string Stage { get; } = stage;
        public int Count { get; } = count;
        public Dictionary<string, int> Done { get; } = [];
        public int Unchanged { get; set; }
        public HashSet<Guid> Refused { get; } = [];
    }

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

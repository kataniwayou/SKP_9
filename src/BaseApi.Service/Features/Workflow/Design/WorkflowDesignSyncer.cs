using System.Text.Json;
using System.Text.Json.Serialization;
using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// Store, dry run, then align (plan 8 §4.3). The design is stored on its own commit with no conflict
/// check (last write wins). Then one transaction runs every stage in order; each entity is a savepoint,
/// so one save reports every error at once. Any error: roll back (the real entities never hold part of
/// a design; the stored design stays). None: empty the stored design and commit.
/// <para>
/// <b>Nothing here judges the design.</b> No cycle, schema-edge, payload or liveness check: those are
/// start checks. The stages run only the field rules the CRUD endpoints already enforce.
/// </para>
/// </summary>
internal sealed class WorkflowDesignSyncer : IWorkflowDesignSyncer
{
    private static readonly JsonSerializerOptions StoredJson = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly BaseDbContext _db;
    private readonly IDesignStore _store;
    private readonly IDesignTransactions _transactions;
    private readonly IReadOnlyList<IDesignStage> _stages;

    public WorkflowDesignSyncer(BaseDbContext db, IDesignStore store, IDesignTransactions transactions, IReadOnlyList<IDesignStage> stages)
    {
        _db = db;
        _store = store;
        _transactions = transactions;
        _stages = stages;
    }

    private static string Count(int n, string one, string? many = null) => $"{n} {(n == 1 ? one : many ?? one + "s")}";

    public async Task<DesignOutcomeDto> SaveAsync(Guid workflowId, DesignSaveRequest request, CancellationToken ct)
    {
        DesignShape.ThrowIfMalformed(workflowId, request);

        // ---- 1. Store: always, on its own commit; the layout goes to Layout, the rest to Design. ----
        var design = JsonSerializer.Serialize(request with { Layout = null }, StoredJson);
        if (!await _store.StoreAsync(workflowId, design, request.Layout!.Value.GetRawText(), ct))
            throw new NotFoundException(nameof(WorkflowEntity), workflowId);
        _db.ChangeTracker.Clear();

        // ---- 2. The stages, in one transaction, collecting every error. ----------------------------
        await using var tx = await _transactions.BeginAsync(ct);
        var run = new DesignRun(workflowId, request, _db, tx);
        run.Note("store", "workflow", "design stored on the workflow (the design and its layout), whatever the dry run finds");
        run.Note("outcome", "outcome", "dry run started: every stage in one transaction, each entity in its own savepoint");
        try
        {
            foreach (var stage in _stages)
                await stage.RunAsync(run, ct);

            if (run.Errors.Count > 0)
            {
                await tx.RollbackAsync(CancellationToken.None);
                var refused = run.Errors.Select(e => e.Id).Distinct().Count();
                run.Note("outcome", "outcome",
                    $"dry run failed: {Count(run.Errors.Count, "error")} on {Count(refused, "entity", "entities")}", "error");
                run.Note("outcome", "outcome", "rolled back: no entity was changed; the design stays stored on the workflow", "error");
                return new DesignOutcomeDto(false, run.Errors, run.Log);
            }

            // ---- 3. Aligned: the real entities now hold the design, so the stored one goes. --------
            var changes = run.Log.Count(l => l.Level == "info" && l.Id is not null && l.Kind != "stage");
            run.Note("outcome", "outcome", $"dry run passed: {Count(changes, "change")}, no errors");
            await _store.ClearAsync(workflowId, ct);
            await tx.CommitAsync(ct);
            run.Note("outcome", "outcome", "committed: the entities hold the design; the stored design is emptied");
            return new DesignOutcomeDto(true, [], run.Log);
        }
        finally
        {
            _db.ChangeTracker.Clear();
        }
    }
}

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
        try
        {
            foreach (var stage in _stages)
                await stage.RunAsync(run, ct);

            if (run.Errors.Count > 0)
            {
                await tx.RollbackAsync(CancellationToken.None);
                return new DesignOutcomeDto(false, run.Errors);
            }

            // ---- 3. Aligned: the real entities now hold the design, so the stored one goes. --------
            await _store.ClearAsync(workflowId, ct);
            await tx.CommitAsync(ct);
            return new DesignOutcomeDto(true, []);
        }
        finally
        {
            _db.ChangeTracker.Clear();
        }
    }
}

using BaseApi.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>Writes and empties the stored design (plan 8 §4.3, first step).</summary>
internal interface IDesignStore
{
    /// <summary>Stores the design and the layout on the workflow row and commits; false when the workflow does not exist.</summary>
    Task<bool> StoreAsync(Guid workflowId, string design, string layout, CancellationToken ct);

    /// <summary>Empties the stored design, inside whatever transaction the context has open.</summary>
    Task ClearAsync(Guid workflowId, CancellationToken ct);
}

/// <summary>
/// One UPDATE each, never through the change tracker: the audit interceptor does not see it, so the
/// workflow's <c>UpdatedAt</c> stays what the designer loaded (the workflow stage checks against it),
/// and no concurrency token is involved (last write wins, spec §1.6).
/// </summary>
internal sealed class RelationalDesignStore : IDesignStore
{
    private readonly BaseDbContext _db;

    public RelationalDesignStore(BaseDbContext db) => _db = db;

    public async Task<bool> StoreAsync(Guid workflowId, string design, string layout, CancellationToken ct) =>
        await _db.Set<WorkflowEntity>().Where(w => w.Id == workflowId)
            .ExecuteUpdateAsync(s => s.SetProperty(w => w.Design, design).SetProperty(w => w.Layout, layout), ct) > 0;

    public Task ClearAsync(Guid workflowId, CancellationToken ct) =>
        _db.Set<WorkflowEntity>().Where(w => w.Id == workflowId)
            .ExecuteUpdateAsync(s => s.SetProperty(w => w.Design, (string?)null), ct);
}

/// <summary>The dry run's one transaction, with a savepoint per entity.</summary>
internal interface IDesignTransaction : IAsyncDisposable
{
    Task SavepointAsync(string name, CancellationToken ct);
    Task RollbackToSavepointAsync(string name, CancellationToken ct);
    Task ReleaseSavepointAsync(string name, CancellationToken ct);
    Task CommitAsync(CancellationToken ct);
    Task RollbackAsync(CancellationToken ct);
}

internal interface IDesignTransactions
{
    Task<IDesignTransaction> BeginAsync(CancellationToken ct);
}

/// <summary>
/// EF Core's own transaction and savepoints on the scoped context. Legal because the context has no
/// retrying execution strategy (as <c>RelationalGraphDryRun</c> notes). Disposing without a commit
/// rolls back, so an exception never leaves part of a design behind.
/// </summary>
internal sealed class RelationalDesignTransactions : IDesignTransactions
{
    private readonly BaseDbContext _db;

    public RelationalDesignTransactions(BaseDbContext db) => _db = db;

    public async Task<IDesignTransaction> BeginAsync(CancellationToken ct) =>
        new Relational(await _db.Database.BeginTransactionAsync(ct));

    private sealed class Relational : IDesignTransaction
    {
        private readonly IDbContextTransaction _tx;

        public Relational(IDbContextTransaction tx) => _tx = tx;

        public Task SavepointAsync(string name, CancellationToken ct) => _tx.CreateSavepointAsync(name, ct);
        public Task RollbackToSavepointAsync(string name, CancellationToken ct) => _tx.RollbackToSavepointAsync(name, ct);
        public Task ReleaseSavepointAsync(string name, CancellationToken ct) => _tx.ReleaseSavepointAsync(name, ct);
        public Task CommitAsync(CancellationToken ct) => _tx.CommitAsync(ct);
        public Task RollbackAsync(CancellationToken ct) => _tx.RollbackAsync(ct);
        public ValueTask DisposeAsync() => _tx.DisposeAsync();
    }
}

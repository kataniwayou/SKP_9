using BaseApi.Core.Persistence;

namespace BaseApi.Service.Features.Orchestration.Validation;

/// <summary>Runs work whose database writes must not survive it.</summary>
internal interface IGraphDryRun
{
    Task<T> RunAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken ct);
}

/// <summary>
/// A transaction that is always rolled back. Everything the work does through the scoped context --
/// the graph saver's writes, the loader's reads of them -- runs on that transaction's connection, so
/// the reads see the uncommitted rows and nothing is ever committed. The tracker is cleared afterwards,
/// because the saver leaves the rolled-back entities tracked. Legal here because the context has no
/// retrying execution strategy.
/// </summary>
internal sealed class RelationalGraphDryRun : IGraphDryRun
{
    private readonly BaseDbContext _db;

    public RelationalGraphDryRun(BaseDbContext db) => _db = db ?? throw new ArgumentNullException(nameof(db));

    public async Task<T> RunAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken ct)
    {
        await using var transaction = await _db.Database.BeginTransactionAsync(ct);
        try
        {
            return await work(ct);
        }
        finally
        {
            // Not the request's token: a cancelled request must still roll back.
            await transaction.RollbackAsync(CancellationToken.None);
            _db.ChangeTracker.Clear();
        }
    }
}

using Microsoft.EntityFrameworkCore;
using BaseApi.Core.Entities;
using BaseApi.Core.Persistence;

namespace BaseApi.Core.Persistence.Repositories;

/// <summary>
/// Concrete generic repository. The constructor takes the abstract <see cref="BaseDbContext"/> so
/// the type system enforces that only a context with snake_case naming, audit interception and
/// <c>xmin</c> concurrency tokens wired can construct one.
/// </summary>
public sealed class Repository<TEntity> : IRepository<TEntity> where TEntity : BaseEntity
{
    private readonly DbSet<TEntity> _set;

    public Repository(BaseDbContext db) => _set = db.Set<TEntity>();

    public Task<TEntity?> GetAsync(Guid id, CancellationToken cancellationToken)
        => _set.FirstOrDefaultAsync(e => e.Id == id, cancellationToken);

    public async Task<IReadOnlyList<TEntity>> ListAsync(CancellationToken cancellationToken)
        => await _set.ToListAsync(cancellationToken);

    // DbSet<T>.AddAsync is only genuinely async for sequence-backed value generators; for these
    // GUID-keyed entities it completes synchronously and the async wrapper allocates a state machine
    // per call. Create is a per-request hot path, so this uses the sync variant and returns a
    // completed task to keep the interface signature stable.
    public Task AddAsync(TEntity entity, CancellationToken cancellationToken)
    {
        _set.Add(entity);
        return Task.CompletedTask;
    }

    public void Update(TEntity entity) => _set.Update(entity);

    public async Task DeleteAsync(Guid id, CancellationToken cancellationToken)
    {
        var entity = await _set.FirstOrDefaultAsync(e => e.Id == id, cancellationToken);
        if (entity is null) return;
        _set.Remove(entity);
    }
}

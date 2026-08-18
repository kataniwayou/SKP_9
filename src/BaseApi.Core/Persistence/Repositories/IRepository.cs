using BaseApi.Core.Entities;

namespace BaseApi.Core.Persistence.Repositories;

/// <summary>
/// Generic repository over an audit-stamped <see cref="BaseEntity"/> subtype.
///
/// <para>
/// Exactly five methods, deliberately: no <c>IQueryable</c> leakage, no exists helper, no predicate
/// overload. Junction entities do not derive from <see cref="BaseEntity"/> and are reached through
/// <c>DbContext.Set&lt;TJunction&gt;()</c> from the entity-specific service instead.
/// </para>
///
/// <para>
/// <b>Unit of work:</b> the service owns <c>SaveChangesAsync</c>. Repository methods only stage
/// changes on the change tracker, so a service can compose a multi-entity transaction and save once
/// at the boundary.
/// </para>
/// </summary>
public interface IRepository<TEntity> where TEntity : BaseEntity
{
    /// <summary>Returns the entity by id, or null when missing. The service turns null into a not-found.</summary>
    Task<TEntity?> GetAsync(Guid id, CancellationToken cancellationToken);

    /// <summary>Returns all rows. There is no paging.</summary>
    Task<IReadOnlyList<TEntity>> ListAsync(CancellationToken cancellationToken);

    /// <summary>Stages an add on the change tracker. The service calls save.</summary>
    Task AddAsync(TEntity entity, CancellationToken cancellationToken);

    /// <summary>Stages an update on the change tracker. The service calls save.</summary>
    /// <remarks>Synchronous because the underlying call does no I/O; an async shape would be a lie.</remarks>
    void Update(TEntity entity);

    /// <summary>
    /// Load-then-remove: fetches by id, then stages a remove. Returns silently when missing, leaving
    /// not-found semantics to the service. Loading first is what preserves the <c>xmin</c>
    /// concurrency check, since it tracks the row's current value.
    /// </summary>
    Task DeleteAsync(Guid id, CancellationToken cancellationToken);
}

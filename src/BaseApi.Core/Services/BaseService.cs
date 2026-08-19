using BaseApi.Core.Entities;
using BaseApi.Core.Exceptions;
using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Core.Services;

/// <summary>
/// Abstract generic orchestrator owning the locked six-step create order:
/// <list type="number">
///   <item>validate explicitly, rather than relying on automatic model validation</item>
///   <item>map the create DTO to a new entity</item>
///   <item>stage the add, putting the entity in the Added state</item>
///   <item><see cref="SyncJunctionsAsync"/>, the hook concrete services override</item>
///   <item>save, at which point the audit interceptor stamps the fields and <c>xmin</c> advances</item>
///   <item>map back to the read DTO, so the audit fields are visible to the caller</item>
/// </list>
/// Update mirrors the same order minus the add. A missing row surfaces as
/// <see cref="NotFoundException"/>, and database update failures bubble to the exception-handler
/// chain rather than being caught here.
/// </summary>
public abstract class BaseService<TEntity, TCreate, TUpdate, TRead>
    where TEntity : BaseEntity
    where TCreate : class
    where TUpdate : class
{
    private readonly IValidator<TCreate> _createValidator;
    private readonly IValidator<TUpdate> _updateValidator;
    private readonly IEntityMapper<TEntity, TCreate, TUpdate, TRead> _mapper;
    private readonly IRepository<TEntity> _repo;

    /// <summary>
    /// Exposed as a property so a derived service can reach the change tracker inside its
    /// <see cref="SyncJunctionsAsync"/> override and enqueue junction rows under the same
    /// transaction.
    /// </summary>
    protected BaseDbContext DbContext { get; }

    /// <summary>
    /// Concrete services pass the five dependencies through. All five are resolved by the base API
    /// registration chain. A concrete service that needs logging takes its own typed logger in its
    /// own constructor.
    /// </summary>
    protected BaseService(
        IValidator<TCreate> createValidator,
        IValidator<TUpdate> updateValidator,
        IEntityMapper<TEntity, TCreate, TUpdate, TRead> mapper,
        IRepository<TEntity> repo,
        BaseDbContext dbContext)
    {
        // The messages use the namespace-qualified name rather than the simple one, so a consumer
        // with same-named types in different namespaces does not go looking at the wrong type.
        _createValidator = createValidator
            ?? throw new InvalidOperationException(
                $"No IValidator<{typeof(TCreate).FullName}> registered. Concrete validator must " +
                $"inherit AbstractValidator<{typeof(TCreate).FullName}> and be discoverable by " +
                "AddBaseApiValidation's assembly scan.");
        _updateValidator = updateValidator
            ?? throw new InvalidOperationException(
                $"No IValidator<{typeof(TUpdate).FullName}> registered. Concrete validator must " +
                $"inherit AbstractValidator<{typeof(TUpdate).FullName}> and be discoverable by " +
                "AddBaseApiValidation's assembly scan.");
        _mapper    = mapper    ?? throw new ArgumentNullException(nameof(mapper));
        _repo      = repo      ?? throw new ArgumentNullException(nameof(repo));
        DbContext  = dbContext ?? throw new ArgumentNullException(nameof(dbContext));
    }

    /// <summary>
    /// The read-side counterpart to <see cref="SyncJunctionsAsync"/>. A collection that lives in a
    /// junction table is invisible to the mapper — the entity has no property for it, and the read
    /// DTO's constructor requires one, so the mapper assigns null. This is where an entity that owns
    /// junctions puts it back.
    /// <para>
    /// The batch overload exists so a list read costs one extra query rather than one per row. It is
    /// the default implementation for the single overload too, which keeps the two from drifting.
    /// </para>
    /// </summary>
    protected virtual Task<IReadOnlyList<TRead>> EnrichReadAsync(
        IReadOnlyList<TRead> dtos, CancellationToken ct) => Task.FromResult(dtos);

    private async Task<TRead> EnrichOneAsync(TRead dto, CancellationToken ct)
        => (await EnrichReadAsync(new[] { dto }, ct))[0];

    /// <summary>Returns the full list mapped to read DTOs, with junction collections populated.</summary>
    public async Task<IReadOnlyList<TRead>> ListAsync(CancellationToken ct)
    {
        var entities = await _repo.ListAsync(ct);
        return await EnrichReadAsync(entities.Select(_mapper.ToRead).ToList(), ct);
    }

    /// <summary>Returns one entity by id, throwing <see cref="NotFoundException"/> when missing.</summary>
    public async Task<TRead> GetByIdAsync(Guid id, CancellationToken ct)
    {
        var entity = await _repo.GetAsync(id, ct);
        if (entity is null) throw new NotFoundException(typeof(TEntity).Name, id);
        return await EnrichOneAsync(_mapper.ToRead(entity), ct);
    }

    /// <summary>
    /// Creates an entity in the locked six-step order. Junction inserts happen between the add and
    /// the save, so the whole graph commits atomically: if a junction insert violates a foreign key,
    /// the parent entity rolls back with it.
    /// </summary>
    public async Task<TRead> CreateAsync(TCreate dto, CancellationToken ct)
    {
        await _createValidator.ValidateAndThrowAsync(dto, ct);          // 1
        var entity = _mapper.ToEntity(dto);                              // 2
        await _repo.AddAsync(entity, ct);                                // 3
        await SyncJunctionsAsync(entity, dto, default, ct);              // 4
        await DbContext.SaveChangesAsync(ct);                            // 5
        // After the save, deliberately: the junction rows staged in step 4 are only queryable once
        // they are committed, and the response has to report what was persisted rather than echo
        // back what was asked for.
        return await EnrichOneAsync(_mapper.ToRead(entity), ct);          // 6
    }

    /// <summary>
    /// Updates an entity, mirroring the create order without the add, since the entity already
    /// exists. Virtual so a service can layer a precondition in front of this order.
    /// </summary>
    public virtual async Task<TRead> UpdateAsync(Guid id, TUpdate dto, CancellationToken ct)
    {
        await _updateValidator.ValidateAndThrowAsync(dto, ct);
        var entity = await _repo.GetAsync(id, ct);
        if (entity is null) throw new NotFoundException(typeof(TEntity).Name, id);
        _mapper.Update(dto, entity);
        await SyncJunctionsAsync(entity, default, dto, ct);
        await DbContext.SaveChangesAsync(ct);
        return await EnrichOneAsync(_mapper.ToRead(entity), ct);
    }

    /// <summary>
    /// Deletes an entity, load-then-remove.
    /// <para>
    /// There is deliberately no application-layer "is anything still referencing this?" pre-check:
    /// the <c>ON DELETE RESTRICT</c> foreign keys are the guard. Postgres refuses the delete with
    /// SQLSTATE 23001, a restrict violation — not the 23503 the create path raises — which the
    /// exception mapper turns into a 422.
    /// </para>
    /// </summary>
    public async Task DeleteAsync(Guid id, CancellationToken ct)
    {
        var existing = await _repo.GetAsync(id, ct);
        if (existing is null) throw new NotFoundException(typeof(TEntity).Name, id);
        await _repo.DeleteAsync(id, ct);
        await DbContext.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Override site for many-to-many junction sync. Called after the add, while the entity is in
    /// the Added state, and before the save. Exactly one of <paramref name="createDto"/> and
    /// <paramref name="updateDto"/> is non-null. The default does nothing.
    /// </summary>
    protected virtual Task SyncJunctionsAsync(
        TEntity entity, TCreate? createDto, TUpdate? updateDto, CancellationToken ct)
        => Task.CompletedTask;
}

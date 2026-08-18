using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Diagnostics;
using BaseApi.Core.Entities;

namespace BaseApi.Core.Persistence.Interceptors;

/// <summary>
/// Stamps the audit fields on <see cref="BaseEntity"/>-derived entries before they are written.
///
/// <para>
/// A caller-set non-empty <see cref="BaseEntity.Id"/> is honoured; a new GUID is generated only when
/// the id is empty.
/// </para>
///
/// <para>
/// <b>UTC only.</b> Every timestamp is <see cref="DateTimeKind.Utc"/>, because Npgsql 8 rejects a
/// non-UTC write to a <c>timestamptz</c> column with an InvalidCastException. Time comes from
/// <see cref="TimeProvider"/> so tests can pin it.
/// </para>
///
/// <para>
/// <b>Async only.</b> This overrides the async save path alone, so a synchronous
/// <c>SaveChanges()</c> will not stamp anything — production code must save asynchronously.
/// </para>
///
/// <para>
/// A null HTTP context is safe: on a non-HTTP path such as background work, a migration or a unit
/// test, the user is simply null and the created-by and updated-by fields are stamped null, with no
/// exception and no warning.
/// </para>
/// </summary>
public sealed class AuditInterceptor : SaveChangesInterceptor
{
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly TimeProvider _clock;

    public AuditInterceptor(IHttpContextAccessor httpContextAccessor, TimeProvider clock)
    {
        _httpContextAccessor = httpContextAccessor;
        _clock = clock;
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        var context = eventData.Context;
        if (context is null)
        {
            return base.SavingChangesAsync(eventData, result, cancellationToken);
        }

        var now = _clock.GetUtcNow().UtcDateTime; // UTC by construction
        var user = _httpContextAccessor.HttpContext?.User?.Identity?.Name; // null off the HTTP path

        foreach (EntityEntry<BaseEntity> entry in context.ChangeTracker.Entries<BaseEntity>())
        {
            switch (entry.State)
            {
                case EntityState.Added:
                    if (entry.Entity.Id == Guid.Empty)
                    {
                        entry.Entity.Id = Guid.NewGuid();
                    }
                    entry.Entity.CreatedAt = now;
                    entry.Entity.UpdatedAt = now;
                    entry.Entity.CreatedBy = user;
                    entry.Entity.UpdatedBy = user;
                    break;

                case EntityState.Modified:
                    // Defensive: stop a caller overwriting the creation fields through an update.
                    entry.Property(nameof(BaseEntity.CreatedAt)).IsModified = false;
                    entry.Property(nameof(BaseEntity.CreatedBy)).IsModified = false;
                    entry.Entity.UpdatedAt = now;
                    entry.Entity.UpdatedBy = user;
                    break;
            }
        }

        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }
}

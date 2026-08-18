namespace BaseApi.Core.Entities;

/// <summary>
/// Abstract base for all audit-stamped domain entities.
///
/// <para>
/// Concrete entities inherit the id and audit fields. Junction entities deliberately do not derive
/// from this type, which is also what excludes them from the <c>xmin</c> shadow-property iteration in
/// <c>BaseDbContext.OnModelCreating</c>.
/// </para>
///
/// <para>
/// Every server-controlled field is stamped by the audit interceptor on save. Production code must
/// not assign them manually. The interceptor honours a caller-set non-empty id, but the HTTP paths
/// exclude the id from create DTOs.
/// </para>
/// </summary>
public abstract class BaseEntity
{
    public Guid Id { get; set; }

    public string Name { get; set; } = string.Empty;

    public string Version { get; set; } = string.Empty;

    /// <remarks>UTC by convention — set by the audit interceptor, never assigned manually. Npgsql 8
    /// rejects a non-UTC write to timestamptz with an InvalidCastException.</remarks>
    public DateTime CreatedAt { get; set; }

    /// <remarks>UTC by convention — set by the audit interceptor, never assigned manually. Npgsql 8
    /// rejects a non-UTC write to timestamptz with an InvalidCastException.</remarks>
    public DateTime UpdatedAt { get; set; }

    public string? CreatedBy { get; set; }

    public string? UpdatedBy { get; set; }

    public string? Description { get; set; }
}

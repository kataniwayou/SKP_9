namespace BaseApi.Core.Validation;

/// <summary>
/// Marker interface exposing the three narrative fields shared by every domain DTO — create, update
/// and read — used as the generic constraint on <see cref="BaseDtoValidator{T}"/> so shared
/// validation rules can target them by member name.
///
/// <para>
/// Field nullability mirrors <see cref="BaseApi.Core.Entities.BaseEntity"/>: <c>Name</c> and
/// <c>Version</c> are non-null with an empty-string default, and <c>Description</c> is nullable.
/// </para>
///
/// <para>
/// Server-side fields — <c>Id</c>, <c>CreatedAt</c>, <c>UpdatedAt</c>, <c>CreatedBy</c> and
/// <c>UpdatedBy</c> — are deliberately not on this interface. They are owned by the audit
/// interceptor and never appear on inbound DTOs.
/// </para>
/// </summary>
public interface IBaseDto
{
    string Name { get; }
    string Version { get; }
    string? Description { get; }
}

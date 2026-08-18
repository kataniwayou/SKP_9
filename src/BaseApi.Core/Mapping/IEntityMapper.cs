namespace BaseApi.Core.Mapping;

/// <summary>
/// Generic three-method mapping contract consumed by <c>BaseService</c> and implemented per entity by
/// a Mapperly <c>[Mapper] partial class</c>.
///
/// <para>
/// <list type="bullet">
///   <item><see cref="ToEntity"/>: build a new entity from the create DTO. Audit fields are stamped by the audit interceptor on save.</item>
///   <item><see cref="Update"/>: mutate the existing target in place, so change tracking and the <c>xmin</c> concurrency token can detect conflicts.</item>
///   <item><see cref="ToRead"/>: project an entity to the read DTO for HTTP responses.</item>
/// </list>
/// </para>
///
/// <para>
/// <b>Server-side fields are excluded by two mechanisms, and both are required.</b> On the source
/// side, update DTOs do not expose <c>Id</c> or the audit fields, and Mapperly cannot map what is not
/// on the source. On the target side, each mapper's <c>Update</c> method must declare
/// <c>[MapperIgnoreTarget]</c> for <c>Id</c> and the four audit fields: Mapperly 4.x defaults to
/// requiring mappings in both directions, so an unmapped target member raises RMG012 — which
/// Directory.Build.props promotes to an error.
/// </para>
/// </summary>
public interface IEntityMapper<TEntity, TCreate, TUpdate, TRead>
{
    TEntity ToEntity(TCreate dto);
    void    Update(TUpdate dto, TEntity target);
    TRead   ToRead(TEntity entity);
}

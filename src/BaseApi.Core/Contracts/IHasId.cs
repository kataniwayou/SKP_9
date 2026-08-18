namespace BaseApi.Core.Contracts;

/// <summary>
/// Marker interface for read DTOs, so
/// <see cref="Controllers.BaseController{TEntity,TCreate,TUpdate,TRead}"/> can read <c>Id</c> in its
/// <c>CreatedAtAction</c> call without dynamic dispatch or reflection.
/// </summary>
public interface IHasId
{
    /// <summary>The unique identifier surfaced on the read DTO.</summary>
    Guid Id { get; }
}

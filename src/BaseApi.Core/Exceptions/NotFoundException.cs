namespace BaseApi.Core.Exceptions;

/// <summary>
/// Thrown by service-layer code when a lookup by id returns no row.
///
/// <para>
/// Claimed by <c>NotFoundExceptionHandler</c> in the exception-handler chain, which produces an HTTP
/// 404 carrying the message as <c>detail</c> plus <c>resourceType</c> and <c>resourceId</c>
/// extensions for clients that want to branch programmatically.
/// </para>
/// </summary>
public sealed class NotFoundException : Exception
{
    public string ResourceType { get; }
    public object Id { get; }

    /// <param name="resourceType">Human-readable resource type name, such as "Schema".</param>
    /// <param name="id">
    /// The identifier of the missing resource. This value appears verbatim in the 404 response body,
    /// so pass only safe, client-visible identifiers such as a GUID or numeric id — never a raw
    /// database key, a file path, or a user-supplied string.
    /// </param>
    public NotFoundException(string resourceType, object id)
        : base($"{resourceType} with id '{id}' was not found.")
    {
        ResourceType = resourceType;
        Id = id;
    }
}

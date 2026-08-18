namespace BaseApi.Service.Features.Schema;

/// <summary>
/// Thrown when something tries to mutate the <c>Definition</c> of a schema that a processor already
/// references — a definition is frozen once referenced. Claimed by
/// <see cref="SchemaDefinitionFrozenExceptionHandler"/>, which turns it into a 409. It carries only
/// the schema id, mirroring the information-disclosure guard on the not-found exception.
/// </summary>
public sealed class SchemaDefinitionFrozenException : Exception
{
    public Guid SchemaId { get; }

    public SchemaDefinitionFrozenException(Guid schemaId)
        : base($"Schema '{schemaId}' is referenced by a processor; its Definition cannot be modified.")
        => SchemaId = schemaId;
}

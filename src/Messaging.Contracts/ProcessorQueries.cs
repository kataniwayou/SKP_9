namespace Messaging.Contracts;

// Identity lookup by source hash. The found-response fields mirror ProcessorReadDto's
// { Id, InputSchemaId?, OutputSchemaId?, ConfigSchemaId? } plus Name and Version, which together are
// the processor's metric identity. Separate found/not-found responses let the client pattern-match.
public sealed record GetProcessorBySourceHash(string SourceHash);
public sealed record ProcessorIdentityFound(
    Guid Id, Guid? InputSchemaId, Guid? OutputSchemaId, Guid? ConfigSchemaId,
    string Name, string Version);
public sealed record ProcessorIdentityNotFound(string SourceHash);

// Schema-definition lookup by schema id.
public sealed record GetSchemaDefinition(Guid SchemaId);
public sealed record SchemaDefinitionFound(string Definition);
public sealed record SchemaDefinitionNotFound(Guid SchemaId);

// A request whose required field arrived as its type default. Distinct from not-found: not-found is
// an answer about the data, this is an answer about the request. The caller can log and stop
// retrying something that will never succeed.
public sealed record MalformedRequest(string Field);

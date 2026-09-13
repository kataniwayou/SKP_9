namespace Messaging.Contracts;

// Identity lookup by source hash and, optionally, instance id. The found-response fields mirror
// ProcessorReadDto's { Id, InputSchemaId?, OutputSchemaId?, ConfigSchemaId? } plus Name and Version,
// which together are the processor's metric identity. Separate found/not-found responses let the
// client pattern-match.
//
// InstanceId is null for a processor whose replicas share one registration — the shape every
// processor deployed as a Deployment has — and carries the pod's stable ordinal name for one
// deployed as a StatefulSet, where each pod holds a row, an identity and therefore a work queue of
// its own. It is nullable rather than a second message type because the two are one question asked
// with more or less precision, and the serving side narrows by hash either way.
//
// Adding it is compatible in both directions, which is why the rollout needs no ordering: MessagingJson
// sets no UnmappedMemberHandling, so an old client's payload binds this to null on a new server, and a
// new client's extra field is ignored by an old one.
public sealed record GetProcessorBySourceHash(string SourceHash, string? InstanceId = null);
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

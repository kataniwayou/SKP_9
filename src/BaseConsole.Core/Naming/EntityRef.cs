using Messaging.Contracts.Projections;

namespace BaseConsole.Core.Naming;

/// <summary>An id together with the kind of entity it names — all a reader needs to address its L2 hash.</summary>
public readonly record struct EntityRef(L2EntityKind Kind, Guid Id);

namespace BaseConsole.Core.Naming;

/// <summary>
/// Where display names come from: the <c>name</c> field of each entity's own hash — <c>skp:wf:{id}</c>,
/// <c>skp:step:{id}</c> or <c>skp:proc:{id}</c>, addressed by <see cref="EntityRef"/>.
/// Read-only. Returns only the ids it found. It may throw; the resolver above it never does.
/// </summary>
public interface IEntityNameSource
{
    Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<EntityRef> refs);
}

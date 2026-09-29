namespace BaseConsole.Core.Naming;

/// <summary>
/// Where display names come from: the <c>skp:name:{id}</c> keys BaseApi writes on every start.
/// Read-only. Returns only the ids it found. It may throw; the resolver above it never does.
/// </summary>
public interface IEntityNameSource
{
    Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<Guid> ids);
}

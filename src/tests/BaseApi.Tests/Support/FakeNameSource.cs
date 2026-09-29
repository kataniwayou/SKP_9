using BaseConsole.Core.Naming;

namespace BaseApi.Tests.Support;

/// <summary>A name source over a dictionary that counts its reads and can be told to fault.</summary>
internal sealed class FakeNameSource(Dictionary<Guid, string>? names = null) : IEntityNameSource
{
    public Dictionary<Guid, string> Names { get; } = names ?? new();

    public Exception? Fault { get; set; }

    public int Reads { get; private set; }

    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<Guid> ids)
    {
        Reads++;
        if (Fault is not null)
        {
            return Task.FromException<IReadOnlyDictionary<Guid, string>>(Fault);
        }

        IReadOnlyDictionary<Guid, string> found = ids.Where(Names.ContainsKey).ToDictionary(id => id, id => Names[id]);
        return Task.FromResult(found);
    }
}

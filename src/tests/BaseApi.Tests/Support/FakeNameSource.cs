using BaseConsole.Core.Naming;

namespace BaseApi.Tests.Support;

/// <summary>A name source over a dictionary that counts its reads and can be told to fault.</summary>
internal sealed class FakeNameSource(Dictionary<Guid, string>? names = null) : IEntityNameSource
{
    public Dictionary<Guid, string> Names { get; } = names ?? new();

    public Exception? Fault { get; set; }

    /// <summary>When true, <see cref="ReadNamesAsync"/> returns a task that never completes -- a
    /// stalled (not faulted) store, e.g. a Redis connection stuck behind CLIENT PAUSE.</summary>
    public bool Stall { get; set; }

    public int Reads { get; private set; }

    /// <summary>Every reference asked for, in order, across all reads — so a test can assert the kind
    /// each id was asked under.</summary>
    public List<EntityRef> Requested { get; } = new();

    public Task<IReadOnlyDictionary<Guid, string>> ReadNamesAsync(IReadOnlyCollection<EntityRef> refs)
    {
        Reads++;
        Requested.AddRange(refs);
        if (Stall)
        {
            return new TaskCompletionSource<IReadOnlyDictionary<Guid, string>>().Task;
        }

        if (Fault is not null)
        {
            return Task.FromException<IReadOnlyDictionary<Guid, string>>(Fault);
        }

        IReadOnlyDictionary<Guid, string> found = refs.Select(r => r.Id).Where(Names.ContainsKey)
            .ToDictionary(id => id, id => Names[id]);
        return Task.FromResult(found);
    }
}

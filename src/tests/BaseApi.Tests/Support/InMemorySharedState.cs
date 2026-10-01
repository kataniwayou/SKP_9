using System.Collections.Concurrent;
using BaseProcessor.Core.Shared;

namespace BaseApi.Tests.Support;

/// <summary>
/// One processor's shared entries, in memory. Hand the SAME instance to two consumers to model two
/// replicas of one processor; a fresh instance models every replica having died.
/// </summary>
internal sealed class InMemorySharedState : IProcessorSharedState
{
    private readonly ConcurrentDictionary<string, string> _entries = new(StringComparer.Ordinal);

    public IReadOnlyDictionary<string, string> Entries => _entries;

    public Task<string?> GetAsync(string name)
        => Task.FromResult(_entries.TryGetValue(name, out var value) ? value : null);

    public Task<bool> SetAsync(string name, string value)
    {
        _entries[name] = value;
        return Task.FromResult(true);
    }
}

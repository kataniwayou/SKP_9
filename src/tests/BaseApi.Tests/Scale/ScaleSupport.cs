using BaseApi.Service.Features.Cache;
using Messaging.Transport;
using Xunit;

namespace BaseApi.Tests.Scale;

/// <summary>The switch and the shared generator of the big-data proof (spec 7). Off unless <c>SKP_SCALE=1</c>.</summary>
public static class ScaleGate
{
    public const string Category = "Scale";

    public static bool Enabled => Environment.GetEnvironmentVariable("SKP_SCALE") == "1";

    /// <summary>Skips unless the operator asked for the scale run AND a Postgres is named.</summary>
    public static void SkipUnlessDb() =>
        Assert.SkipUnless(Enabled && Support.PostgresFixture.Enabled,
            "set SKP_SCALE=1 and SKP_TEST_PG to run the scale tests");

    /// <summary>Skips unless the operator asked for the scale run AND the real stack is up.</summary>
    public static void SkipUnlessLive() =>
        Assert.SkipUnless(Enabled && Live.RealStack.Enabled,
            "set SKP_SCALE=1 and SKP_REALSTACK=1 (port-forward up) to run the live scale tests");

    public static void Log(string line) => TestContext.Current.TestOutputHelper?.WriteLine(line);
}

/// <summary>Keys <c>k{n:D7}</c>, values 500 characters, both deterministic from <c>n</c>.</summary>
public static class ScaleData
{
    public const int BatchSize = 50_000;
    public const int Batches = 20;
    public const int ValueChars = 500;

    public static string Key(int n, char prefix = 'k') => $"{prefix}{n:D7}";

    public static string Value(int n) => string.Create(ValueChars, n, static (span, seed) =>
    {
        const string alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
        var x = (uint)seed * 2654435761u + 12345u;
        for (var i = 0; i < span.Length; i++)
        {
            x = x * 1664525u + 1013904223u;
            span[i] = alphabet[(int)((x >> 16) % (uint)alphabet.Length)];
        }
    });

    /// <summary>Items n in [from, from+count).</summary>
    public static List<CacheItemDto> Items(int from, int count, char prefix = 'k')
    {
        var list = new List<CacheItemDto>(count);
        for (var n = from; n < from + count; n++) list.Add(new CacheItemDto(Key(n, prefix), Value(n)));
        return list;
    }
}

/// <summary>Drops every message: the scale tests measure the database path, not the queue.</summary>
internal sealed class NullSender : IQueueSender
{
    public int Count;

    public Task SendAsync<T>(string queue, string type, T body, CancellationToken ct,
        string? replyTo = null, string? correlationId = null)
    {
        Interlocked.Increment(ref Count);
        return Task.CompletedTask;
    }
}

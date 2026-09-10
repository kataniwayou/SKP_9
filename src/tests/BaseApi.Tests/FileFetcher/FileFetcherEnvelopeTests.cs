using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// What this processor puts on the wire. The envelope IS the contract across the split, so its
/// keys, its casing and its base64 are asserted here rather than assumed.
/// </summary>
public sealed class FileFetcherEnvelopeTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filefetcher-env-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private const string CsvPayload =
        """{"AllowedExtensions":[".csv"],"MinimumSizeBytes":0,"MaximumSizeBytes":4096}""";

    private async Task<List<ProcessedData>> SendsFor(string name, string text, Guid executionId)
    {
        var path = Path.Combine(_dir, name);
        await File.WriteAllTextAsync(path, text);

        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var processor = new FileFetcherProcessor(
            new RecordingLogger<FileFetcherProcessor>(), Options.Create(new FileFetcherOptions()));
        processor.BeginDispatch(new DispatchState(sender, C, W, S, P));

        await processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            CsvPayload, executionId, CancellationToken.None);

        return sends;
    }

    [Fact]
    public async Task OneBranchIsSentOnTheDispatchsOwnExecutionId()
    {
        // A transform, not a source: the lineage it was handed is the lineage it continues.
        var sends = await SendsFor("orders.csv", "id,name", E);

        var branch = Assert.Single(sends);
        Assert.Equal(E, branch.ExecutionId);
    }

    [Fact]
    public async Task TheEnvelopeCarriesCamelCaseKeysAndBase64Content()
    {
        var sends = await SendsFor("orders.csv", "id,name", E);

        using var doc = JsonDocument.Parse(Assert.Single(sends).Data);
        var root = doc.RootElement;

        Assert.Equal("orders.csv", root.GetProperty("fileName").GetString());
        Assert.Equal(".csv", root.GetProperty("extension").GetString());
        Assert.Equal(7, root.GetProperty("sizeBytes").GetInt64());
        Assert.Equal("id,name", Encoding.UTF8.GetString(root.GetProperty("content").GetBytesFromBase64()));
    }

    [Fact]
    public async Task EveryKeyIsPresentEvenWhenItsValueIsNull()
    {
        // The registered schema requires the keys, so DefaultIgnoreCondition.Never is load-bearing
        // rather than stylistic.
        var sends = await SendsFor("orders.csv", "id,name", E);

        using var doc = JsonDocument.Parse(Assert.Single(sends).Data);
        foreach (var key in new[]
                 { "fileName", "extension", "sizeBytes", "createdUtc", "modifiedUtc", "content" })
        {
            Assert.True(doc.RootElement.TryGetProperty(key, out _), key);
        }
    }

    [Fact]
    public async Task TheEnvelopeCarriesNoPath()
    {
        // The path is a location the downstream has no business knowing, and carrying it here would
        // put it one edit from the output document.
        var sends = await SendsFor("orders.csv", "id,name", E);

        var json = Encoding.UTF8.GetString(Assert.Single(sends).Data);
        Assert.DoesNotContain(_dir.Replace('\\', '/'), json.Replace('\\', '/'), StringComparison.Ordinal);
        Assert.False(JsonDocument.Parse(json).RootElement.TryGetProperty("filePath", out _));
    }

    [Fact]
    public async Task AnEmptyFileIsAnEmptyContentString()
    {
        var sends = await SendsFor("empty.csv", "", E);

        using var doc = JsonDocument.Parse(Assert.Single(sends).Data);
        Assert.Equal("", doc.RootElement.GetProperty("content").GetString());
        Assert.Equal(0, doc.RootElement.GetProperty("sizeBytes").GetInt64());
    }
}

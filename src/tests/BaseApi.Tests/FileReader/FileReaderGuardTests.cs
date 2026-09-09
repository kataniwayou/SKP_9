using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileReader;
using Xunit;

namespace BaseApi.Tests.FileReader;

public sealed class FileReaderGuardTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filereader-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>A real file on disk. The thing under test IS the filesystem interaction.</summary>
    private string WriteFile(string name, int bytes)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllBytes(path, new byte[bytes]);
        return path;
    }

    private static (FileReaderProcessor Processor, RecordingLogger<FileReaderProcessor> Log) Build(
        long podCeiling = 33_554_432)
    {
        var log = new RecordingLogger<FileReaderProcessor>();
        var processor = new FileReaderProcessor(
            log, Options.Create(new FileReaderOptions { MaxFileSizeBytes = podCeiling }));
        processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return (processor, log);
    }

    private static string Payload(string extension, long min, long max)
        => JsonSerializer.Serialize(new
        {
            ExpectedExtension = extension,
            MinimumSizeBytes = min,
            MaximumSizeBytes = max,
        });

    private static Task Run(FileReaderProcessor processor, string path, string payload)
        => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            payload, E, CancellationToken.None);

    [Fact]
    public async Task AnEmptyPayloadFailsTheStep()
    {
        // No meaningful default extension exists. Inventing one would have this processor accept
        // files nobody asked for, so an absent payload is a workflow authoring error.
        var (processor, _) = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.Contains("needs a step payload", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APayloadCeilingAboveThePodCeilingFailsTheStep()
    {
        // Not clamped. Clamping means the author asked for 100MB, got failures at 32, and nothing
        // said why.
        var (processor, _) = Build(podCeiling: 1024);
        var path = WriteFile("a.csv", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("above this pod's ceiling", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMissingFileFailsTheStepNamingThePath()
    {
        var (processor, _) = Build();
        var path = Path.Combine(_dir, "absent.csv");

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));

        // The message IS the operator-facing contract — ProcessDispatchHandler logs it verbatim —
        // so it is asserted here rather than on a RecordingLogger record the author no longer writes.
        Assert.Equal($"reading {path} failed: it does not exist", ex.Message);
    }

    [Fact]
    public async Task TheWrongExtensionFailsTheStep()
    {
        var (processor, _) = Build();
        var path = WriteFile("orders.txt", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));

        Assert.StartsWith($"file {path} rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("expected .csv", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheExtensionComparisonIsCaseInsensitive()
    {
        // Windows fixtures and Linux pods disagree about case, and the extension is a business
        // expectation rather than a filesystem fact.
        var (processor, _) = Build();
        var path = WriteFile("orders.CSV", 10);

        // Reaching the not-yet-implemented read means the extension guard passed.
        await Assert.ThrowsAsync<NotImplementedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));
    }

    [Fact]
    public async Task AFileBelowTheFloorFailsTheStep()
    {
        var (processor, _) = Build();
        var path = WriteFile("orders.csv", 5);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 10, 4096)));

        Assert.Contains("below the 10 byte floor", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFileAboveTheCeilingFailsTheStep()
    {
        var (processor, _) = Build();
        var path = WriteFile("orders.csv", 5000);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));

        Assert.Contains("above the 4096 byte ceiling", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheSizeGuardsRunBeforeTheFileIsOpened()
    {
        // The whole point of stage 1 being dry. An oversize file held open exclusively by another
        // process must still be REJECTED rather than reported unreadable — FileInfo.Length does not
        // need the handle that File.ReadAllBytes does.
        var (processor, _) = Build();
        var path = WriteFile("orders.csv", 5000);

        using var exclusive = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.None);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload(".csv", 0, 4096)));

        Assert.Contains("above the 4096 byte ceiling", ex.Message, StringComparison.Ordinal);
    }
}

using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests.FileFetcher;

/// <summary>
/// The dry checks: payload, extension, size. Every one of these must fail BEFORE the file is opened,
/// which is the whole reason this processor exists as a separate hop.
/// </summary>
public sealed class FileFetcherGuardTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-filefetcher-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    /// <summary>A real file on disk. The thing under test IS the filesystem interaction.</summary>
    private string WriteFile(string name, int bytes)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllBytes(path, new byte[bytes]);
        return path;
    }

    private static FileFetcherProcessor Build(long podCeiling = 33_554_432)
    {
        var processor = new FileFetcherProcessor(
            new RecordingLogger<FileFetcherProcessor>(),
            Options.Create(new FileFetcherOptions { MaxFileSizeBytes = podCeiling }));
        processor.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return processor;
    }

    private static string Payload(string[]? extensions, long min, long max)
        => JsonSerializer.Serialize(new
        {
            AllowedExtensions = extensions,
            MinimumSizeBytes = min,
            MaximumSizeBytes = max,
        });

    private static Task Run(FileFetcherProcessor processor, string path, string payload)
        => processor.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            payload, E, CancellationToken.None);

    [Fact]
    public async Task AnAbsentPayloadFailsTheStep()
    {
        // An absent payload IS a malformed payload, and it shares the prefix so one query finds
        // every payload fault including the commonest one.
        var processor = Build();

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => processor.ExecuteAsync([], "", E, CancellationToken.None));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("needs AllowedExtensions", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMalformedExtensionEntryIsQuotedBack()
    {
        var processor = Build();
        var path = WriteFile("a.zip", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".zip", "zip"], 0, 4096)));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("'zip'", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task APayloadCeilingAboveThePodCeilingFailsTheStep()
    {
        // Not clamped. Clamping means the author asked for 100MB, got failures at 32, and nothing
        // said why.
        var processor = Build(podCeiling: 1024);
        var path = WriteFile("a.csv", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], 0, 4096)));

        Assert.StartsWith("step payload rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("above this pod's ceiling", ex.Message, StringComparison.Ordinal);
        Assert.Contains("FileFetcher__MaxFileSizeBytes", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ANegativeFloorFailsTheStep()
    {
        var processor = Build();
        var path = WriteFile("a.csv", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], -1, 4096)));

        Assert.Contains("MinimumSizeBytes must not be negative", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFloorAboveTheCeilingFailsTheStep()
    {
        var processor = Build();
        var path = WriteFile("a.csv", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], 4096, 100)));

        Assert.Contains("is above MaximumSizeBytes", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AMissingFileFailsTheStepNamingThePath()
    {
        // "reading", not "rejected": an absent file is not a file that broke a rule, and the two
        // classes are searched separately.
        var processor = Build();
        var path = Path.Combine(_dir, "absent.csv");

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], 0, 4096)));

        Assert.StartsWith($"reading {path} failed: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("it does not exist", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnExtensionOutsideTheWhitelistIsRejectedAndTheListIsNamed()
    {
        var processor = Build();
        var path = WriteFile("report.pdf", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".zip", ".tar", ".csv"], 0, 4096)));

        Assert.StartsWith($"file {path} rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("extension '.pdf' is not in the allowed list (.zip, .tar, .csv)",
                        ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnyExtensionIsAdmittedUnderTheWildcard()
    {
        var processor = Build();
        var path = WriteFile("report.pdf", 10);

        // No throw is the assertion.
        await Run(processor, path, Payload(["*.*"], 0, 4096));
    }

    [Fact]
    public async Task AnOmittedExtensionListAdmitsEverything()
    {
        // The fallback and the default are the same value, and this is where that is visible.
        var processor = Build();
        var path = WriteFile("report.pdf", 10);

        await Run(processor, path, Payload(null, 0, 4096));
    }

    [Fact]
    public async Task AFileBelowTheFloorIsRejected()
    {
        var processor = Build();
        var path = WriteFile("a.csv", 10);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], 100, 4096)));

        Assert.StartsWith($"file {path} rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("is below the 100 byte floor", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AFileAboveTheCeilingIsRejected()
    {
        var processor = Build();
        var path = WriteFile("a.csv", 500);

        var ex = await Assert.ThrowsAsync<FailedException>(
            () => Run(processor, path, Payload([".csv"], 0, 100)));

        Assert.StartsWith($"file {path} rejected: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("is above the 100 byte ceiling", ex.Message, StringComparison.Ordinal);
    }
}

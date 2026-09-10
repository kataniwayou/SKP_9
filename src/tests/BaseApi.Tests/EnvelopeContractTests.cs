using System.IO.Compression;
using System.Text;
using System.Text.Json;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Validation;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Options;
using NSubstitute;
using Processor.ArchiveExpander;
using Processor.ArchiveExpander.Extractors;
using Processor.FileFetcher;
using Xunit;

namespace BaseApi.Tests;

/// <summary>
/// THE CONTRACT ACROSS THE SPLIT, and the one thing neither pod can verify alone.
/// <para>
/// The envelope is described in four places that nothing keeps in sync: FileFetcher's
/// <c>FetchedFile</c> (all fields required), ArchiveExpander's <c>FetchedFile</c> (all fields
/// optional), and the two schema files. Each half's own tests pass happily while the halves disagree.
/// This class runs both real processors back to back and validates the bytes in between against both
/// registered schemas, so a divergence fails here rather than in the cluster.
/// </para>
/// </summary>
public sealed class EnvelopeContractTests : IDisposable
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    private readonly string _dir = Directory.CreateTempSubdirectory("skp-envelope-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static string FetcherOutputSchema()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "schema", "fetcher-output.json"));

    private static string ExpanderInputSchema()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "schema", "input.json"));

    /// <summary>Runs the real fetcher and returns the single branch it sent.</summary>
    private async Task<byte[]> Fetch(string name, byte[] content, string payload)
    {
        var path = Path.Combine(_dir, name);
        await File.WriteAllBytesAsync(path, content);

        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var fetcher = new FileFetcherProcessor(
            new RecordingLogger<FileFetcherProcessor>(),
            Options.Create(new FileFetcherOptions()));
        fetcher.BeginDispatch(new BaseProcessor.Core.Processing.DispatchState(sender, C, W, S, P));

        await fetcher.ExecuteAsync(
            Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { filePath = path })),
            payload, E, CancellationToken.None);

        return Assert.Single(sends).Data;
    }

    /// <summary>Runs the real expander over an envelope and returns the document it sent.</summary>
    private static async Task<byte[]> Expand(byte[] envelope, string payload)
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var expander = new ArchiveExpanderProcessor(
            new RecordingLogger<ArchiveExpanderProcessor>(),
            new FileContentBuilder(
                [new ZipExtractor()], Options.Create(new ArchiveExpanderOptions())));
        expander.BeginDispatch(new BaseProcessor.Core.Processing.DispatchState(sender, C, W, S, P));

        await expander.ExecuteAsync(envelope, payload, E, CancellationToken.None);

        return Assert.Single(sends).Data;
    }

    private const string AnyFile =
        """{"AllowedExtensions":["*.*"],"MinimumSizeBytes":0,"MaximumSizeBytes":1048576}""";

    private static byte[] Zip(params (string Name, string Text)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, text) in entries)
            {
                using var writer = new StreamWriter(archive.CreateEntry(name).Open());
                writer.Write(text);
            }
        }

        return buffer.ToArray();
    }

    [Fact]
    public async Task WhatTheFetcherSendsSatisfiesBothRegisteredSchemas()
    {
        // The two schema files are duplicates across assemblies that must not reference each other.
        // This is what catches them drifting.
        var envelope = await Fetch("orders.csv", Encoding.UTF8.GetBytes("id,name"), AnyFile);

        Assert.True(ProcessorJsonSchemaValidator.TryValidate(FetcherOutputSchema(), envelope, out var a),
                    string.Join("; ", a));
        Assert.True(ProcessorJsonSchemaValidator.TryValidate(ExpanderInputSchema(), envelope, out var b),
                    string.Join("; ", b));
    }

    [Fact]
    public async Task APlainFileSurvivesBothHops()
    {
        var envelope = await Fetch("orders.csv", Encoding.UTF8.GetBytes("id,name"), AnyFile);

        var document = await Expand(envelope, """{"MaxDepth":1}""");
        var node = JsonSerializer.Deserialize<FileNode>(document, FileDocument.Options)!;

        // THE ROOT NODE KEEPS ITS IDENTITY, and that is the whole reason the envelope exists rather
        // than raw bytes. A downstream step reading the filename off this metadata is why.
        Assert.Equal("orders.csv", node.Metadata.Name);
        Assert.Equal(".csv", node.Metadata.Extension);
        Assert.Equal(7, node.Metadata.SizeBytes);
        Assert.NotNull(node.Metadata.ModifiedUtc);

        var bytes = Assert.IsType<FileContent.Bytes>(node.Content);
        Assert.Equal("id,name", Encoding.UTF8.GetString(bytes.Value));
    }

    [Fact]
    public async Task AnArchiveSurvivesBothHopsAndTheDocumentValidates()
    {
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);

        var document = await Expand(envelope, """{"MaxDepth":1}""");

        var outputSchema = File.ReadAllText(
            Path.Combine(AppContext.BaseDirectory, "schema", "output.json"));
        var node = JsonSerializer.Deserialize<FileNode>(document, FileDocument.Options)!;

        Assert.Equal("orders.zip", node.Metadata.Name);
        Assert.Equal(2, node.Metadata.EntryCount);
        var entries = Assert.IsType<FileContent.Entries>(node.Content);
        Assert.Equal(["a.csv", "b.csv"], entries.Value.Select(e => e.Metadata.Name).Order());

        // The output contract is unchanged by the split, and this is the assertion of that.
        Assert.True(ProcessorJsonSchemaValidator.TryValidate(outputSchema, document, out var errors),
                    string.Join("; ", errors));
    }

    [Fact]
    public async Task AnExtensionlessFileSurvivesBothHops()
    {
        // Admitted only under "*.*", carries "" as its extension, and must not trip the expander's
        // declared-extension cross-check.
        var envelope = await Fetch("README", Encoding.UTF8.GetBytes("hello"), AnyFile);

        var document = await Expand(envelope, """{"MaxDepth":1}""");
        var node = JsonSerializer.Deserialize<FileNode>(document, FileDocument.Options)!;

        Assert.Equal("README", node.Metadata.Name);
        Assert.Equal("", node.Metadata.Extension);
    }

    [Fact]
    public async Task AFileNamedZipThatIsNotOneStillFailsAsCorrupt()
    {
        // The cross-check survived the split. Its claim used to be ExpectedExtension matching; it is
        // now the fetcher's whitelist admitting the file, and the extension reaches the expander in
        // the envelope either way.
        var envelope = await Fetch("broken.zip", Encoding.UTF8.GetBytes("not a zip at all"), AnyFile);

        var ex = await Assert.ThrowsAsync<BaseProcessor.Core.Processing.FailedException>(
            () => Expand(envelope, """{"MaxDepth":1}"""));

        Assert.StartsWith("extracting broken.zip failed: ", ex.Message, StringComparison.Ordinal);
        Assert.Contains("treating it as corrupt", ex.Message, StringComparison.Ordinal);
    }
}

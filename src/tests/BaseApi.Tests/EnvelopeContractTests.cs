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
// Aliased rather than a blanket `using Processor.ArchiveCollapser;`: that namespace declares its
// own FileNode/FileContent/FileDocument -- a deliberate duplicate of ArchiveExpander's, per both
// types' doc comments -- and a blanket import would make every existing unqualified use of those
// names in this file ambiguous. Only the two types Collapse() needs are pulled in.
using ArchiveBuilder = Processor.ArchiveCollapser.ArchiveBuilder;
using ArchiveCollapserProcessor = Processor.ArchiveCollapser.ArchiveCollapserProcessor;
using Processor.ArchiveCollapser.Writers;

namespace BaseApi.Tests;

/// <summary>
/// THE CONTRACT ACROSS THE SPLIT, and the one thing neither pod can verify alone.
/// <para>
/// The envelope is described in three places that nothing keeps in sync: FileFetcher's
/// <c>FetchedFile</c> (all fields required), ArchiveExpander's <c>FetchedFile</c> (all fields
/// optional), and the registered envelope schema. Each half's own tests pass happily while the
/// halves disagree. This class runs both real processors back to back and validates the bytes in
/// between against the real, registered schema, so a divergence fails here rather than in the
/// cluster.
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

    private static string EnvelopeSchema()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "envelope.json"));

    private static string TreeSchema()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "tree.json"));

    /// <summary>Runs the real fetcher and returns the single branch it sent.</summary>
    /// <param name="createdUtc">
    /// When given, stamped onto the temp file before the fetcher inspects it, so a test can pin
    /// <c>CreatedUtc</c> to a known value rather than merely asserting it is non-null.
    /// </param>
    /// <param name="modifiedUtc">The <paramref name="createdUtc"/> counterpart for <c>ModifiedUtc</c>.</param>
    private async Task<byte[]> Fetch(
        string name, byte[] content, string payload,
        DateTime? createdUtc = null, DateTime? modifiedUtc = null)
    {
        var path = Path.Combine(_dir, name);
        await File.WriteAllBytesAsync(path, content);

        if (createdUtc is { } created)
        {
            File.SetCreationTimeUtc(path, created);
        }

        if (modifiedUtc is { } modified)
        {
            File.SetLastWriteTimeUtc(path, modified);
        }

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

    /// <summary>Runs the real collapser over a document and returns the envelope it sent.</summary>
    private static async Task<byte[]> Collapse(byte[] document)
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var collapser = new ArchiveCollapserProcessor(
            new RecordingLogger<ArchiveCollapserProcessor>(),
            new ArchiveBuilder(
            [
                new ZipWriter(),
                new TarWriter(),
            ]));
        collapser.BeginDispatch(new BaseProcessor.Core.Processing.DispatchState(sender, C, W, S, P));

        // The payload is empty and that is not an oversight: this processor reads none.
        await collapser.ExecuteAsync(document, string.Empty, E, CancellationToken.None);

        return Assert.Single(sends).Data;
    }

    /// <summary>The bytes inside an envelope's base64 `content`.</summary>
    private static byte[] ContentOf(byte[] envelope)
        => JsonDocument.Parse(envelope).RootElement.GetProperty("content").GetBytesFromBase64();

    /// <summary>A zip holding one zip, built by the collapser so tier 2 starts from our own output.</summary>
    private static byte[] NestedZip()
        => new ZipWriter().Write(
        [
            new ArchiveEntry(
                "inner.zip",
                new ZipWriter().Write(
                [
                    new ArchiveEntry(
                        "a.csv", Encoding.UTF8.GetBytes("id"), new DateTime(2026, 3, 4, 5, 6, 8, DateTimeKind.Utc)),
                ]),
                new DateTime(2026, 3, 4, 5, 6, 10, DateTimeKind.Utc)),
            new ArchiveEntry(
                "b.csv", Encoding.UTF8.GetBytes("id,name"), new DateTime(2026, 3, 4, 5, 6, 12, DateTimeKind.Utc)),
        ]);

    [Fact]
    public async Task WhatTheFetcherSendsSatisfiesTheEnvelopeSchema()
    {
        var envelope = await Fetch("orders.csv", Encoding.UTF8.GetBytes("id,name"), AnyFile);

        Assert.True(
            ProcessorJsonSchemaValidator.TryValidate(EnvelopeSchema(), envelope, out var errors),
            string.Join("; ", errors));
    }

    [Fact]
    public async Task APlainFileSurvivesBothHops()
    {
        // DISTINCT values, deliberately, and that is the whole point of the assertion below. Two
        // NotNull checks would pass just as happily if a reader TRANSPOSED CreatedUtc and
        // ModifiedUtc — mapped each into the other's field — because null-ness alone cannot see a
        // swap. Pinning each to its OWN known value is what catches a transposition, a drop, or a
        // rename anywhere between the fetcher's FetchedFile, the expander's FetchedFile, and the two
        // schema files. Do not collapse these into one shared constant: that would silently reopen
        // exactly the hole this exists to close.
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var modified = new DateTime(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

        var envelope = await Fetch(
            "orders.csv", Encoding.UTF8.GetBytes("id,name"), AnyFile, created, modified);

        var document = await Expand(envelope, """{"MaxDepth":1}""");
        var node = JsonSerializer.Deserialize<FileNode>(document, FileDocument.Options)!;

        // THE ROOT NODE KEEPS ITS IDENTITY, and that is the whole reason the envelope exists rather
        // than raw bytes. A downstream step reading the filename off this metadata is why.
        Assert.Equal("orders.csv", node.Metadata.Name);
        Assert.Equal(".csv", node.Metadata.Extension);
        Assert.Equal(7, node.Metadata.SizeBytes);
        Assert.Equal(created, node.Metadata.CreatedUtc);
        Assert.Equal(modified, node.Metadata.ModifiedUtc);

        var bytes = Assert.IsType<FileContent.Bytes>(node.Content);
        Assert.Equal("id,name", Encoding.UTF8.GetString(bytes.Value));
    }

    [Fact]
    public async Task AnArchiveSurvivesBothHopsAndTheDocumentValidates()
    {
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);

        var document = await Expand(envelope, """{"MaxDepth":1}""");

        var outputSchema = TreeSchema();
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

    [Fact]
    public async Task TIER1_APlainFileRoundTripsToAByteIdenticalEnvelope()
    {
        // THE PRIMARY ASSERTION, at its simplest: ArchiveExpander's INPUT data equals
        // ArchiveCollapser's OUTPUT data, byte for byte, every field.
        //
        // Distinct timestamps on purpose -- see APlainFileSurvivesBothHops for why two NotNull
        // checks cannot see a transposition. Do not collapse these into one constant.
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        var modified = new DateTime(2026, 6, 7, 8, 9, 10, DateTimeKind.Utc);

        var envelope = await Fetch(
            "orders.csv", Encoding.UTF8.GetBytes("id,name"), AnyFile, created, modified);

        var collapsed = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));

        Assert.Equal(envelope, collapsed);
    }

    [Fact]
    public async Task TIER2_ANestedArchiveWeBuiltRoundTripsToAByteIdenticalEnvelope()
    {
        // THE REAL PROOF, at depth 2. Starting from an archive THIS SYSTEM produced, the loop is
        // byte-exact: same writer, same Optimal level, same entry order (the document's array
        // preserves it and ZipArchive.Entries enumerates in write order), timestamps already
        // clamped so the second pass moves nothing.
        //
        // This is also the case that exercises the recursive descent on both sides -- the expander's
        // walk down, the collapser's walk back up, and FileNodeConverter in both directions.
        var envelope = await Fetch("orders.zip", NestedZip(), AnyFile);

        var collapsed = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));

        Assert.Equal(envelope, collapsed);
    }

    [Fact]
    public async Task TIER2_TheLoopIsAFixedPointAcrossASecondPass()
    {
        // Collapse, expand, collapse: the second envelope equals the first. This is what makes
        // "consistent with ArchiveExpander" an assertion instead of a claim -- timestamps, ordering
        // and compression all stop moving after the first hop.
        var envelope = await Fetch("orders.zip", NestedZip(), AnyFile);

        var once = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));
        var twice = await Collapse(await Expand(once, """{"MaxDepth":2}"""));

        Assert.Equal(once, twice);
    }

    [Fact]
    public async Task TIER3_AForeignArchiveKeepsWhatTheDocumentRecordsButNotItsBytes()
    {
        // A zip built by the TEST's own helper rather than by ZipWriter -- a stand-in for 7-Zip,
        // zip(1) or Python. Re-encoding cannot reproduce another implementation's deflate stream,
        // its extra fields, its per-entry compression method or its directory entries.
        //
        // THIS IS A PROPERTY OF ROUND-TRIPPING THROUGH A LOSSY INTERMEDIATE, NOT A DEFECT. It is
        // asserted so that nobody reads tier 2 passing and files a bug that tier 3 does not have.
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);

        var document = await Expand(envelope, """{"MaxDepth":2}""");
        var collapsed = await Collapse(document);

        // Everything the document records survives.
        var e = JsonDocument.Parse(collapsed).RootElement;
        Assert.Equal("orders.zip", e.GetProperty("fileName").GetString());
        Assert.Equal(".zip", e.GetProperty("extension").GetString());

        using var stream = new MemoryStream(ContentOf(collapsed), writable: false);
        var entries = new ZipExtractor().Extract(stream);
        Assert.Equal(["a.csv", "b.csv"], entries.Select(x => x.Name).Order().ToArray());
        Assert.Equal("id,name", Encoding.UTF8.GetString(entries.Single(x => x.Name == "b.csv").Content));

        // And the bytes do not. Asserted rather than merely omitted, so the boundary is documented
        // by a test instead of by a comment somebody can delete.
        Assert.NotEqual(envelope, collapsed);
    }

    [Fact]
    public async Task TIER3_ButTheSECONDPassIsAFixedPoint()
    {
        // Once a foreign archive has been through the loop once, it is OUR archive -- so from the
        // second pass onward tier 2's byte identity applies. This is the bridge between the tiers.
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);

        var once = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));
        var twice = await Collapse(await Expand(once, """{"MaxDepth":2}"""));

        Assert.Equal(once, twice);
    }

    [Fact]
    public async Task LOSS_DirectoriesAreFlattenedAndThatIsExpected()
    {
        // ArchiveExpander records entry.Name, never FullName, so the document has never carried
        // directory structure. Pinned as an expected fact rather than left to surprise someone.
        var envelope = await Fetch("orders.zip", Zip(("sub/a.csv", "id")), AnyFile);

        var collapsed = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));

        using var stream = new MemoryStream(ContentOf(collapsed), writable: false);
        Assert.Equal("a.csv", Assert.Single(new ZipExtractor().Extract(stream)).Name);
    }

    [Fact]
    public async Task LOSS_NestedNodesCarryNoCreationTimeSoNoneIsWrittenBack()
    {
        // Archives record no creation time; only a modification time, and not in every format. The
        // ROOT's createdUtc survives because it rides the envelope, not the archive.
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);

        var envelope = await Fetch("orders.zip", NestedZip(), AnyFile, created);
        var collapsed = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));

        Assert.Equal(
            created,
            JsonDocument.Parse(collapsed).RootElement.GetProperty("createdUtc").GetDateTime());
    }
}

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
// Aliased for the reason the collapser's types are: Processor.SKNormalizer declares its own
// FileNode/FileContent/FileDocument -- a deliberate duplicate -- and a blanket import would make
// every existing unqualified use of those names in this file ambiguous.
using SKNormalizerProcessor = Processor.SKNormalizer.SKNormalizerProcessor;
using ProviderHandlerRegistry = Processor.SKNormalizer.ProviderHandlerRegistry;
using SampleHandler = Processor.SKNormalizer.SampleHandler;
using NormalizationPipeline = Processor.SKNormalizer.NormalizationPipeline;
using TreeAssembler = Processor.SKNormalizer.TreeAssembler;
using XmlMetadataRenderer = Processor.SKNormalizer.XmlMetadataRenderer;

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
                // Rar is registered alongside zip because one test below drives a rar-sourced
                // document through the whole chain; every other test's fixture is a zip, which
                // matches nothing in the rar extractor and is unaffected.
                [new ZipExtractor(), new RarExtractor()],
                Options.Create(new ArchiveExpanderOptions())));
        expander.BeginDispatch(new BaseProcessor.Core.Processing.DispatchState(sender, C, W, S, P));

        await expander.ExecuteAsync(envelope, payload, E, CancellationToken.None);

        return Assert.Single(sends).Data;
    }

    /// <summary>
    /// The third hop. Runs the real processor with the identity handler -- the one that returns the
    /// input tree unchanged -- so what this adds to the chain is a pass-through, and any difference
    /// it introduces is a defect rather than a design choice.
    /// </summary>
    private static async Task<byte[]> Normalize(byte[] document)
    {
        var sender = Substitute.For<IQueueSender>();
        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());

        var normalizer = new SKNormalizerProcessor(
            new RecordingLogger<SKNormalizerProcessor>(),
            new ProviderHandlerRegistry([new SampleHandler()]),
            // Exploding, not a substitute: IAudioTranscoder is internal and cannot be proxied by
            // NSubstitute, and it must never be called here -- SampleHandler's ProfileFor returns
            // null for every item, which is what makes it identity. If this throws, it stopped being
            // one.
            new NormalizationPipeline(
                new TreeAssembler(), new XmlMetadataRenderer(), new ExplodingTranscoder()));

        normalizer.BeginDispatch(new BaseProcessor.Core.Processing.DispatchState(sender, C, W, S, P));

        await normalizer.ExecuteAsync(
            document, """{"handler":"Sample"}""", E, CancellationToken.None);

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
        //
        // THIS CANNOT GO RED ON ITS OWN, and that is fine, not an oversight. Given TIER2's byte
        // identity holding, `once` IS `envelope`, so re-running the same deterministic pipeline on
        // the same bytes (once -> twice) cannot diverge while TIER2 is green -- no production change
        // reddens THIS test without TIER2 already having failed first. Its value is diagnostic: when
        // the loop DOES break, this isolates whether the break is in the first hop (TIER2 fails,
        // this may still pass) or is itself unstable across repetition (both fail). Kept for that
        // triage value, not for independent coverage -- do not read it as the fixed-point proof.
        // TIER3_ButTheSECONDPassIsAFixedPoint is NOT implied by this one and carries the real weight:
        // it starts from timestamps and structure a FOREIGN zip produced, not from NestedZip()'s own
        // already-ZipWriter-clamped values, so it is where the fixed-point property is actually
        // exercised rather than merely re-confirmed on data already known to be stable.
        var envelope = await Fetch("orders.zip", NestedZip(), AnyFile);

        var once = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));
        var twice = await Collapse(await Expand(once, """{"MaxDepth":2}"""));

        Assert.Equal(once, twice);
    }

    /// <summary>
    /// A zip that TRULY cannot have been written by <see cref="ZipWriter"/> -- not merely a second
    /// call through the same BCL writer. <see cref="Zip"/> above is
    /// <c>System.IO.Compression.ZipArchive</c> at the same default <c>Optimal</c> level
    /// <c>ZipWriter</c> uses, writing the same names in the same order: both sides are the same
    /// writer, so a tier-3 test built on it alone would prove nothing about re-encoding a genuinely
    /// foreign archive -- it would pass for a reason the comment could not honestly explain.
    /// <para>
    /// This adds two things <c>ZipWriter</c>'s own output never has: a DIRECTORY ENTRY (the
    /// expander reads <c>entry.Name</c> and drops any entry whose full path ends in <c>/</c>;
    /// <c>ZipWriter</c> never emits one) and one entry stored with
    /// <see cref="CompressionLevel.NoCompression"/> -- a genuinely different per-entry compression
    /// method than <c>ZipWriter</c> ever chooses (it always takes the <c>CreateEntry</c> default,
    /// <c>Optimal</c>).
    /// </para>
    /// <para>
    /// <b>What this still does NOT exercise</b>: a real third-party deflate stream -- 7-Zip's,
    /// <c>zip(1)</c>'s or Python's own encoder. That needs a checked-in byte blob from an actual
    /// external tool, not bytes any code in this repository generated. That is the honest limit of
    /// this fixture, and it is stated here rather than implied by a comment at the call site that
    /// nobody checks against what the helper actually does.
    /// </para>
    /// </summary>
    private static byte[] ForeignZip(params (string Name, string Text)[] entries)
    {
        using var buffer = new MemoryStream();
        using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            // A directory entry. ZipExtractor drops it (entry.FullName.EndsWith('/')), so it must
            // never appear in the document -- and re-packing a document that never carried it can
            // never reproduce it either, which is one honest half of why tier 3 is not byte-identical.
            archive.CreateEntry("sub/");

            foreach (var (name, text) in entries)
            {
                // NoCompression, not Optimal: ZipWriter always takes CreateEntry's default, so this
                // is a per-entry compression method ZipWriter provably never chooses.
                using var writer = new StreamWriter(archive.CreateEntry(name, CompressionLevel.NoCompression).Open());
                writer.Write(text);
            }
        }

        return buffer.ToArray();
    }

    [Fact]
    public async Task TIER3_AForeignArchiveKeepsWhatTheDocumentRecordsButNotItsBytes()
    {
        // ForeignZip, not Zip: see ForeignZip's doc comment for exactly what makes this archive
        // genuinely unlike anything ZipWriter produces -- a directory entry and a per-entry
        // compression method ZipWriter never chooses. What is NOT exercised, and is not claimed to
        // be: a real third-party deflate stream, which would need a checked-in byte blob from an
        // actual external tool rather than bytes this repository's own code generated.
        //
        // THIS IS A PROPERTY OF ROUND-TRIPPING THROUGH A LOSSY INTERMEDIATE, NOT A DEFECT. It is
        // asserted so that nobody reads tier 2 passing and files a bug that tier 3 does not have.
        var envelope = await Fetch("orders.zip", ForeignZip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);

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

        // And the bytes do not -- now for a reason this test can name: the directory entry
        // ForeignZip writes and ZipWriter never does, and ForeignZip's NoCompression entries against
        // ZipWriter's Optimal. Asserted rather than merely omitted, so the boundary is documented by
        // a test instead of by a comment somebody can delete.
        Assert.NotEqual(envelope, collapsed);

        // Not byte-identical to the fetcher's own envelope, so TIER1/TIER2's equality assertion
        // cannot see this envelope at all -- this is the one place a foreign archive's collapsed
        // output is checked against the real, registered envelope schema.
        Assert.True(ProcessorJsonSchemaValidator.TryValidate(EnvelopeSchema(), collapsed, out var errors),
                    string.Join("; ", errors));
    }

    [Fact]
    public async Task TIER3_ButTheSECONDPassIsAFixedPoint()
    {
        // Once a foreign archive has been through the loop once, it is OUR archive -- so from the
        // second pass onward tier 2's byte identity applies. This is the bridge between the tiers.
        // ForeignZip, matching TIER3 above, so `once` genuinely starts from a directory entry and a
        // compression method ZipWriter never produces on its own.
        var envelope = await Fetch("orders.zip", ForeignZip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);

        var once = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));
        var twice = await Collapse(await Expand(once, """{"MaxDepth":2}"""));

        Assert.Equal(once, twice);
    }

    [Fact]
    public async Task LOSS_DirectoriesAreFlattenedAndThatIsExpected()
    {
        // ArchiveExpander records entry.Name, never FullName, so the document has never carried
        // directory structure. Read back through ZipArchive directly and asserted on FullName, not
        // through ZipExtractor -- ZipExtractor's own ExtractedEntry exposes only Name (see
        // ZipExtractor.Extract), so an assertion against THAT would still read "a.csv" even if the
        // collapser somehow wrote "sub/a.csv" back into the archive; FullName is the property that
        // would actually show a resurrected path.
        var envelope = await Fetch("orders.zip", Zip(("sub/a.csv", "id")), AnyFile);

        var collapsed = await Collapse(await Expand(envelope, """{"MaxDepth":2}"""));

        using var stream = new MemoryStream(ContentOf(collapsed), writable: false);
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        Assert.Equal("a.csv", Assert.Single(archive.Entries).FullName);
    }

    [Fact]
    public async Task LOSS_NestedNodesCarryNoCreationTimeSoNoneIsWrittenBack()
    {
        // Archives record no creation time; only a modification time, and not in every format. The
        // ROOT's createdUtc survives because it rides the envelope, not the archive -- pinned below
        // by collapsing and checking the outbound envelope.
        //
        // The NESTED loss is pinned separately and directly, on the INTERMEDIATE DOCUMENT, because
        // neither the root check below nor TIER1/TIER2's envelope-to-envelope byte equality can see
        // it: a collapsed envelope carries no nested createdUtc field at all to compare, so nothing
        // else in this file would notice if FileContentBuilder ever started populating one instead
        // of passing createdUtc: null for every non-root node.
        var created = new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc);

        var envelope = await Fetch("orders.zip", NestedZip(), AnyFile, created);
        var document = await Expand(envelope, """{"MaxDepth":2}""");

        var root = JsonSerializer.Deserialize<FileNode>(document, FileDocument.Options)!;
        var nested = Assert.IsType<FileContent.Entries>(root.Content).Value[0];
        Assert.Null(nested.Metadata.CreatedUtc);

        var collapsed = await Collapse(document);
        Assert.Equal(
            created,
            JsonDocument.Parse(collapsed).RootElement.GetProperty("createdUtc").GetDateTime());

        // This collapsed envelope is never checked against the schema by TIER1/TIER2 -- neither
        // reaches a document whose nested node lost its createdUtc -- so this is the other place
        // that closes the gap Finding 3 named: nothing else in this file validates a collapsed
        // envelope built from a document with a null nested timestamp.
        Assert.True(ProcessorJsonSchemaValidator.TryValidate(EnvelopeSchema(), collapsed, out var errors),
                    string.Join("; ", errors));
    }

    [Fact]
    public async Task TheIdentityHandlerLeavesTheDocumentByteIdentical()
    {
        // THE NARROW CLAIM, checked before the wide one. If this fails, the chain test below fails
        // too and it is far harder to say why.
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);
        var document = await Expand(envelope, """{"MaxDepth":1}""");

        Assert.Equal(document, await Normalize(document));
    }

    [Fact]
    public async Task ANestedDocumentSurvivesTheMirror()
    {
        // Depth 2 exercises the mirror's recursion and the assembler's Folder path, which the flat
        // case never touches. NestedZip is the fixture this file already uses for nesting.
        var envelope = await Fetch("orders.zip", NestedZip(), AnyFile);
        var document = await Expand(envelope, """{"MaxDepth":2}""");

        Assert.Equal(document, await Normalize(document));
    }

    [Fact]
    public async Task TheChainStillRoundTripsWithTheNormalizerInserted()
    {
        // THE ACCEPTANCE TEST FOR THIS PROCESSOR. A schema asserts a document has the right shape;
        // identity asserts it round-tripped losslessly, which is the stronger statement -- and it is
        // what catches a TreeAssembler rule drifting away from ArchiveBuilder.
        //
        // The source is a .zip DELIBERATELY. A rar-sourced document cannot round-trip
        // byte-identically -- ArchiveExpander reads rar and ArchiveCollapser cannot write it, because
        // RarLab's unrar licence permits decompression only -- so using one would fail this test for
        // a reason that is not this processor's doing.
        //
        // COMPARED AGAINST COLLAPSE-WITHOUT, not against the original archive: the collapser rebuilds
        // the zip, so its bytes need not equal the input's. What must hold is that inserting this
        // processor changes nothing, and that is exactly what this compares.
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id"), ("b.csv", "id,name")), AnyFile);
        var document = await Expand(envelope, """{"MaxDepth":1}""");

        var withNormalizer = await Collapse(await Normalize(document));
        var without = await Collapse(document);

        Assert.Equal(ContentOf(without), ContentOf(withNormalizer));
    }

    [Fact]
    public async Task APlainFileSurvivesTheNormalizerByteIdentically()
    {
        // THE SHAPE THAT WAS SILENTLY EMPTIED. ArchiveExpander emits a BYTES root for any fetched
        // file it does not recognise as an archive, and the mirror handled only an entries root -- so
        // a CSV arrived here and left as a childless container, which the chain wrote out as an empty
        // 22-byte zip. A completed workflow, no failed step, no warning, and the file destroyed.
        //
        // Every other identity test in this file starts from a .zip, which is exactly why none of
        // them saw it.
        var envelope = await Fetch("report.csv", Encoding.UTF8.GetBytes("id,name,role"), AnyFile);
        var document = await Expand(envelope, """{"MaxDepth":1}""");

        Assert.Equal(document, await Normalize(document));
    }

    [Fact]
    public async Task ARarSourcedDocumentSurvivesTheChainAndArrivesAsAZip()
    {
        // NOT byte identity, and that is the format rather than a defect here: ArchiveExpander READS
        // rar and ArchiveCollapser cannot WRITE it -- RarLab's unrar licence permits decompression
        // only -- so the output is a different container holding the same entries. What must hold is
        // that the collapser ACCEPTS what this processor emits, which the mirror's faithful ".rar"
        // root would have made impossible without TreeAssembler's retargeting.
        var fixture = await File.ReadAllBytesAsync(
            Path.Combine(AppContext.BaseDirectory, "ArchiveExpander", "Fixtures", "three-entries.rar"),
            TestContext.Current.CancellationToken);

        var envelope = await Fetch("bundle.rar", fixture, AnyFile);
        var document = await Expand(envelope, """{"MaxDepth":1}""");

        var normalized = await Normalize(document);

        Assert.Equal(
            ".zip",
            JsonDocument.Parse(normalized).RootElement
                .GetProperty("metadata").GetProperty("extension").GetString());
        Assert.Equal(
            "bundle.zip",
            JsonDocument.Parse(normalized).RootElement
                .GetProperty("metadata").GetProperty("name").GetString());

        // The collapser accepting it is the whole point: an unretargeted .rar root is a refusal.
        var collapsed = await Collapse(normalized);

        Assert.True(ProcessorJsonSchemaValidator.TryValidate(EnvelopeSchema(), collapsed, out var errors),
                    string.Join("; ", errors));
        Assert.Equal(
            "bundle.zip",
            JsonDocument.Parse(collapsed).RootElement.GetProperty("fileName").GetString());
    }

    [Fact]
    public async Task WhatTheNormalizerSendsSatisfiesTheTreeSchema()
    {
        // Its output schema IS the tree row -- the same one the expander writes and the collapser
        // reads -- so this is the check that the reused row actually admits what this processor
        // emits. See the design's section 1.2.
        var envelope = await Fetch("orders.zip", Zip(("a.csv", "id")), AnyFile);
        var normalized = await Normalize(await Expand(envelope, """{"MaxDepth":1}"""));

        Assert.True(
            ProcessorJsonSchemaValidator.TryValidate(TreeSchema(), normalized, out var errors),
            string.Join("; ", errors));
    }
}

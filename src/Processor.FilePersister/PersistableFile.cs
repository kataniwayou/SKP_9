namespace Processor.FilePersister;

/// <summary>
/// What arrives on the wire: the envelope <c>FileFetcher</c> writes and <c>ArchiveCollapser</c>
/// writes back. This is the READER's copy.
/// <para>
/// <b>Every field is nullable, and that is the rule for a reader.</b> <c>FetchedFile</c> in
/// FileFetcher is the writer's view and its fields are non-nullable, because a writer cannot emit a
/// field it does not have. A reader can be handed anything — the registered input schema rejects
/// most of it one layer up, but this processor must diagnose a malformed record rather than throw a
/// framework exception at it. The same arrangement, for the same reason, as
/// <c>ArchiveExpander</c>'s copy of the same document.
/// </para>
/// <para>
/// <b>The two records describe one JSON document across assemblies that must not reference each
/// other</b>, and the registered <c>file-envelope</c> schema is what pins them together.
/// </para>
/// <para>
/// <b><c>SizeBytes</c> is read and never enforced.</b> It is the length the fetcher measured with
/// <c>FileInfo.Length</c> at the far end of the workflow. The bytes in <c>Content</c> ARE the file;
/// a disagreement between them would be a claim about a source this processor never saw, and
/// refusing to write over it would lose a file to settle a number nobody reads. It is carried for
/// the log line and nothing else.
/// </para>
/// </summary>
internal sealed record PersistableFile(
    string? FileName,
    string? Extension,
    long? SizeBytes,
    DateTime? CreatedUtc,
    DateTime? ModifiedUtc,
    byte[]? Content);

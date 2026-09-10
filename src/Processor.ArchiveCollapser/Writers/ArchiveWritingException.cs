namespace Processor.ArchiveCollapser.Writers;

/// <summary>
/// A document could not be packed. The writing seam's single declared fault type, and the only one
/// <c>ArchiveCollapserProcessor</c> converts into the <c>collapsing {FileName} failed:</c> failure.
/// <para>
/// <b>It exists because a catch list over library exception types is a seam that rots.</b> This is
/// the same lesson <c>ArchiveExtractionException</c> records: the expander's catch was written
/// against zip's BCL types, and when rar arrived it brought SharpCompress, whose whole hierarchy
/// descends from <c>SharpCompressException : System.Exception</c> and matched none of them. Each
/// writer wraps its own library's faults into this type, and the caller catches exactly this.
/// </para>
/// <para>
/// <b>Bare <see cref="Exception"/> is deliberately NOT caught at the call site.</b> A
/// <see cref="NullReferenceException"/> in the builder is a programming error, and reporting it to
/// an operator as a bad document buries a bug under a plausible business failure. Anything a writer
/// throws that is not this type escapes to the framework's general catch, which reports the same
/// failed step but logs the stack trace instead of flattening it into one line.
/// </para>
/// </summary>
/// <param name="message">
/// The reason, rendered for an operator. It becomes the <c>{Reason}</c> of
/// <c>collapsing {FileName} failed: {Reason}</c> verbatim, so it must read as a sentence about the
/// document and must never carry document content.
/// </param>
/// <param name="inner">The library fault this wraps, where there was one.</param>
public sealed class ArchiveWritingException(string message, Exception? inner = null)
    : Exception(message, inner);

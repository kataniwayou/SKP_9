namespace Processor.FileReader.Extractors;

/// <summary>
/// An archive could not be expanded. The extraction seam's single declared fault type, and the only
/// one <c>FileReaderProcessor</c> converts into the <c>extracting {FilePath} failed:</c> failure.
/// <para>
/// <b>It exists because a catch list over library exception types is a seam that rots.</b> The
/// processor's catch was originally written against zip's BCL types —
/// <see cref="InvalidDataException"/>, <see cref="IOException"/>, <see cref="NotSupportedException"/>,
/// <see cref="ArgumentException"/> — and when rar arrived it brought SharpCompress, whose whole
/// hierarchy descends from <c>SharpCompress.Common.SharpCompressException : System.Exception</c> and
/// therefore matched none of them. An ordinary corrupt rar still failed the step, but through the
/// framework's general catch: logged as "the transform faulted" at Warning with a stack trace and
/// <b>no file path anywhere</b> — and the path is the entire reason §9 puts these checks in
/// <c>ProcessAsync</c>. Nobody noticed, because nothing about adding a library forces a review of a
/// catch list in a different file.
/// </para>
/// <para>
/// <b>So each extractor wraps the faults its own library raises into this type, and the caller
/// catches exactly this.</b> That is the same shape <c>BaseExporter</c> already uses for
/// <c>ExportSinkException</c>: the adapter knows its library, the caller knows only the seam. It also
/// keeps the processor free of any SharpCompress reference — coupling it to a package only one
/// extractor uses is what created the seam in the first place.
/// </para>
/// <para>
/// <b>The alternative — catching bare <see cref="Exception"/> at the call site — is rejected</b> for
/// the reason <c>ImportSourceException</c> gives: a <see cref="NullReferenceException"/> in the
/// builder is a programming error, and reporting it to an operator as a corrupt file buries the bug
/// under a plausible-looking business failure. Anything an extractor throws that is not this type is
/// deliberately left to escape to the framework's general catch, which reports the same failed step
/// but logs the stack trace instead of flattening it into one line.
/// </para>
/// </summary>
/// <param name="message">
/// The reason, rendered for an operator. It becomes the <c>{Reason}</c> of
/// <c>extracting {FilePath} failed: {Reason}</c> verbatim, so it must read as a sentence about the
/// archive and must never carry archive content.
/// </param>
/// <param name="inner">The library fault this wraps, where there was one.</param>
public sealed class ArchiveExtractionException(string message, Exception? inner = null)
    : Exception(message, inner);

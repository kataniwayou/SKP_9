namespace Processor.SKNormalizer;

/// <summary>
/// The ONE business-failure type, thrown by handlers and by the shared services and translated to a
/// <c>FailedException</c> once, in the processor.
/// <para>
/// One type, not a list, for the reason <c>ArchiveExtractionException</c> and
/// <c>ArchiveWritingException</c> record: a caller catching a library's own hierarchy catches
/// whatever that library happens to throw this version, and misses the rest.
/// </para>
/// <para>
/// <b>Bare <see cref="Exception"/> is deliberately never caught.</b> A NullReferenceException in a
/// handler is a programming error, and reporting it to an operator as a bad provider document
/// buries a bug under a plausible business failure.
/// </para>
/// </summary>
public sealed class NormalizationException(string message) : Exception(message);

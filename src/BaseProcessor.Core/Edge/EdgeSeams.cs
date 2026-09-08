namespace BaseProcessor.Core.Edge;

/// <summary>
/// One item read from a source, on its way to becoming one branch.
/// <para>
/// <b>A record class, not a struct, and that is load-bearing.</b>
/// <see cref="IImportSource.Acknowledge"/> asks "is this the item you handed me", and the only
/// honest way to answer is reference identity — a struct would compare by value and let an
/// implementation acknowledge an equal item that is not the same one.
/// </para>
/// </summary>
/// <param name="Data">
/// The bytes the branch is sent with, verbatim. Bytes rather than a string because decoding here and
/// re-encoding on the way out is lossless only for valid UTF-8: anything else comes back as
/// replacement characters, silently, with the branch carrying data the source never held.
/// </param>
/// <param name="Origin">
/// Where this item came from, rendered for a human: <c>records [0] @4</c> for a topic,
/// <c>/mnt/in/a.txt</c> for a folder. It is the one thing every importer logs, so an operator has
/// the same question answered the same way whatever the source is. It never crosses back into the
/// implementation — <see cref="IImportSource.Acknowledge"/> takes the item itself and the
/// implementation recovers whatever it needs from its own state.
/// </param>
public sealed record ImportedItem(byte[] Data, string Origin);

/// <summary>
/// Everything <c>BaseImporter</c> knows about where items come from, which is four verbs. The
/// narrowness is the point: it is what lets every terminal, ordering and cache rule be tested
/// against a fake, with no broker and no filesystem anywhere in the hermetic suite.
/// <para>
/// <b>Every failure is an <see cref="ImportSourceException"/>.</b> An implementation that lets its
/// client's own exception type through has only half a seam: the loop cannot catch
/// <c>KafkaException</c> without knowing about Kafka, and it must not catch bare
/// <see cref="Exception"/>, because <c>PostSendException</c> has to reach the framework untouched.
/// </para>
/// </summary>
public interface IImportSource : IDisposable
{
    /// <summary>
    /// Makes the source ready to read, and blocks up to <paramref name="timeout"/> doing it.
    /// <para>
    /// Called on <b>every</b> dispatch, including one that reuses a cached source, because readiness
    /// is not a property a source keeps: a consumer can lose its assignment between dispatches. An
    /// implementation with one-time setup does that setup on the first call and re-checks readiness
    /// on the rest.
    /// </para>
    /// <para>
    /// <b>This exists to stop a source that is not ready being read as a source with nothing in
    /// it.</b> Those two look identical from <see cref="Read"/> — both return nothing — and telling
    /// them apart is the difference between reporting an empty folder and reporting a broker nobody
    /// could reach.
    /// </para>
    /// </summary>
    /// <returns>True when the source is ready to read. False fails the step.</returns>
    bool Open(TimeSpan timeout);

    /// <summary>Null when nothing arrived within <paramref name="timeout"/>: the source is drained.</summary>
    ImportedItem? Read(TimeSpan timeout);

    /// <summary>
    /// Marks <paramref name="item"/> consumed. The ACK, and it runs after the branch is sent.
    /// <para>
    /// <b>The contract, binding on every implementation:</b> <paramref name="item"/> is the item the
    /// most recent <see cref="Read"/> returned, and acknowledgements may not be batched — each item
    /// is acknowledged before the next is read. A batched acknowledgement would have a redelivered
    /// dispatch re-read and re-send everything since the last one, and an importer is a source step,
    /// which has no input key to guard the replay: the acknowledgement is the only replay guard
    /// there is.
    /// </para>
    /// </summary>
    void Acknowledge(ImportedItem item);

    /// <summary>Releases the source deliberately, rather than by whatever timeout the far side keeps.</summary>
    void Close();
}

/// <summary>
/// Everything <c>BaseExporter</c> knows about where data goes, which is one verb.
/// <para>
/// <b>Every failure is an <see cref="ExportSinkException"/></b>, for the reason
/// <see cref="IImportSource"/> gives.
/// </para>
/// </summary>
public interface IExportSink : IDisposable
{
    /// <summary>
    /// Writes <paramref name="data"/> to <paramref name="destination"/> and does not return until
    /// the far side has acknowledged it.
    /// <para>
    /// <b>The wait is the whole contract.</b> A fire-and-forget write returns before the data exists
    /// anywhere durable, so a step that reported Complete on that would be reporting the enqueue
    /// rather than the export. Returning normally means it was stored; anything else — a rejection, a
    /// timeout, an acknowledgement that admits it might not have stored it — throws. There is no
    /// third answer, because the step above has only two outcomes to report.
    /// </para>
    /// </summary>
    /// <returns>Where it landed, rendered for the log line: an offset, a path, a key.</returns>
    Task<string> WriteAsync(string destination, byte[] data, CancellationToken ct);
}

/// <summary>
/// A source failed. The seam's declared fault type, and the only one <c>BaseImporter</c> converts:
/// it becomes a <c>FailedException</c> before the source is open and a <c>StopReason.Faulted</c>
/// terminal after reading has started.
/// <para>
/// Anything else an implementation throws is a programming error and is deliberately left to escape
/// to the framework's general catch, which reports the same failed step but logs at Warning
/// <b>with the stack trace</b> instead of flattening it into one line.
/// </para>
/// </summary>
public sealed class ImportSourceException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// A sink failed. The mirror of <see cref="ImportSourceException"/>, and it has only one
/// disposition: <c>BaseExporter</c> converts it to a <c>FailedException</c> wherever it arises,
/// because a sink has one thing to place and either placed it or did not.
/// </summary>
public sealed class ExportSinkException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// Why an importer's loop stopped. It exists because a bare <c>12/100</c> has three causes and an
/// operator cannot tell them apart: the batch finished, the source ran dry, or the thirteenth item
/// faulted.
/// <para>
/// In the framework rather than in one importer so that every importer reports the same three words
/// and one dashboard covers all of them.
/// </para>
/// </summary>
public enum StopReason
{
    /// <summary>Imported the full <c>MessageCount</c>. Every item acknowledged.</summary>
    Completed,

    /// <summary>
    /// The source is empty. What "empty" means is the source's own business — for a subscribed
    /// consumer it is a drained <i>assignment</i>, which is the same thing as a drained topic only
    /// while the topic has one partition and the deployment one replica.
    /// </summary>
    Drained,

    /// <summary>
    /// A fault after reading had started. Everything already sent is kept and acknowledged, and
    /// nothing beyond it is, so the next dispatch resumes there. Not a business failure: the step
    /// succeeds with a partial count, and a fault that is genuinely permanent surfaces on the next
    /// dispatch's <see cref="IImportSource.Open"/>, where it does fail the step.
    /// </summary>
    Faulted,
}

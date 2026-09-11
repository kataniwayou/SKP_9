using System.Text;
using BaseApi.Tests.Support;
using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Edge;
using BaseProcessor.Core.Processing;
using Messaging.Contracts;
using Messaging.Transport;
using Microsoft.Extensions.Logging;
using NSubstitute;
using Xunit;

namespace BaseApi.Tests.Processor;

/// <summary>
/// The edge base classes with no Kafka anywhere, which is the claim they exist to make: a second
/// importer supplies a config record, an adapter and a cache key, and inherits every rule.
/// <para>
/// The Kafka suites already drive these classes end to end. What is here is what those cannot reach
/// — the defaults a Kafka processor overrides, and the fault-type rule that keeps
/// <c>PostSendException</c> reaching the framework.
/// </para>
/// </summary>
public sealed class EdgeProcessorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    // ---- The smallest importer that can exist ----------------------------------------------

    private sealed record FolderConfig(string Path, int MessageCount, int IdleTimeoutSeconds)
        : ImporterConfig(MessageCount, IdleTimeoutSeconds);

    /// <summary>
    /// Items are queued up front; a fault is scheduled by position. It throws
    /// <see cref="ImportSourceException"/>, which is what the seam demands of every implementation.
    /// </summary>
    private sealed class FakeSource : IImportSource
    {
        private readonly Queue<ImportedItem> _items = new();
        private int _reads;
        private ImportedItem? _last;

        public List<string> Acknowledged { get; } = new();
        public bool Closed { get; private set; }
        public bool Disposed { get; private set; }
        public bool Ready { get; set; } = true;
        public int Opens { get; private set; }

        /// <summary>1-based index of the Read that throws; null means none does.</summary>
        public int? ReadThrowsOnCall { get; set; }

        /// <summary>Throws a bare exception rather than the seam's type, to prove the base does not catch it.</summary>
        public bool ReadThrowsSomethingElse { get; set; }

        public FakeSource With(params string[] values)
        {
            foreach (var v in values)
            {
                _items.Enqueue(new ImportedItem(Encoding.UTF8.GetBytes(v), $"/mnt/in/{v}.txt"));
            }

            return this;
        }

        public bool Open(TimeSpan timeout)
        {
            Opens++;
            return Ready;
        }

        public ImportedItem? Read(TimeSpan timeout)
        {
            _reads++;
            if (_reads == ReadThrowsOnCall)
            {
                throw ReadThrowsSomethingElse
                    ? new InvalidOperationException("a bug in the adapter")
                    : new ImportSourceException("the folder went away");
            }

            if (_items.Count == 0)
            {
                return null;
            }

            _last = _items.Dequeue();
            return _last;
        }

        /// <summary>
        /// The acknowledge call that throws the seam's declared fault, 1-based, or 0 for none. A
        /// separate knob from <see cref="ReadThrowsOnCall"/> because the two faults have different
        /// consequences: a read that fails yields no item, while an acknowledge that fails leaves an
        /// item whose branch has ALREADY been sent.
        /// </summary>
        public int AcknowledgeThrowsOnCall { get; init; }

        public void Acknowledge(ImportedItem item)
        {
            Assert.Same(_last, item);

            if (Acknowledged.Count + 1 == AcknowledgeThrowsOnCall)
            {
                throw new ImportSourceException("the folder stopped accepting acknowledgements");
            }

            Acknowledged.Add(item.Origin);
        }

        public void Close() => Closed = true;

        public void Dispose() => Disposed = true;
    }

    private sealed class FolderImporter(FakeSource source, RecordingLogger<FolderImporter> log)
        : BaseImporter<FolderConfig>(log)
    {
        public int SourcesCreated { get; private set; }

        protected override string RequiredPayload => "path, messageCount and idleTimeoutSeconds";

        protected override string CacheKey(FolderConfig config) => config.Path;

        protected override string SourceName(FolderConfig config) => config.Path;

        protected override IImportSource CreateSource(FolderConfig config)
        {
            SourcesCreated++;
            return source;
        }
    }

    private static (FolderImporter Importer, IQueueSender Sender, RecordingLogger<FolderImporter> Log)
        BuildImporter(FakeSource source)
    {
        var log = new RecordingLogger<FolderImporter>();
        var sender = Substitute.For<IQueueSender>();
        var importer = new FolderImporter(source, log);
        importer.BeginDispatch(new DispatchState(sender, C, W, S, P));
        return (importer, sender, log);
    }

    private static string ImporterPayload(int messageCount = 10) =>
        $$"""{"path":"/mnt/in","messageCount":{{messageCount}},"idleTimeoutSeconds":1}""";

    // ---- What a subclass inherits ----------------------------------------------------------

    /// <summary>
    /// A config record, an adapter, a cache key and a name — and the terminals, the ordering, the
    /// lineage per item and the summary line all arrive for free. This is the whole bargain.
    /// </summary>
    [Fact]
    public async Task AnImporterThatSuppliesOnlyItsAdapterGetsEveryRule()
    {
        var source = new FakeSource().With("a", "b", "c");
        var (importer, sender, log) = BuildImporter(source);

        var sends = new List<ProcessedData>();
        await sender.SendAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Do<ProcessedData>(sends.Add),
                               Arg.Any<CancellationToken>(), Arg.Any<string?>());
        await importer.ExecuteAsync([], ImporterPayload(), Guid.Empty, CancellationToken.None);

        Assert.Equal(["a", "b", "c"], sends.Select(s => Encoding.UTF8.GetString(s.Data)));
        Assert.Equal(3, sends.Select(s => s.ExecutionId).Distinct().Count());
        Assert.Equal(["/mnt/in/a.txt", "/mnt/in/b.txt", "/mnt/in/c.txt"], source.Acknowledged);
        Assert.Contains("consumed 3/10 records; stopped because Drained",
                        log.Records.Single(r => r.Message.Contains("stopped because")).Message);
    }

    /// <summary>
    /// <b>The default <c>Describe</c> logs the origin and NOT the payload</b>, which is the safe
    /// answer and the reverse of what <c>KafkaImporterProcessor</c> chooses. An origin is an
    /// identifier the operator already knows; a payload is arbitrary data that would land in
    /// Elasticsearch in the clear and untruncated. An importer whose items ARE their identifiers — a
    /// folder reader, whose origin is the path — needs no override, and this is that importer.
    /// </summary>
    [Fact]
    public async Task LogsTheOriginRatherThanThePayloadWhenDescribeIsNotOverridden()
    {
        var source = new FakeSource().With("account-4711");
        var (importer, sender, log) = BuildImporter(source);

        await importer.ExecuteAsync([], ImporterPayload(), Guid.Empty, CancellationToken.None);

        var line = log.Records.Single(r => r.Message.Contains("imported item")).Message;
        Assert.Contains("/mnt/in/account-4711.txt", line);
        Assert.DoesNotContain(log.Records, r => r.Message.Contains("imported record"));
    }

    /// <summary>
    /// Readiness is asked on EVERY dispatch, including one that reuses the cached source, because it
    /// is not a property a source keeps: a consumer can lose its assignment between dispatches, and a
    /// source that is not ready reads exactly like one with nothing in it.
    /// </summary>
    [Fact]
    public async Task OpensTheCachedSourceAgainOnEveryDispatch()
    {
        var source = new FakeSource().With("a", "b");
        var (importer, _, _) = BuildImporter(source);

        await importer.ExecuteAsync([], ImporterPayload(1), Guid.Empty, CancellationToken.None);
        await importer.ExecuteAsync([], ImporterPayload(1), Guid.Empty, CancellationToken.None);

        Assert.Equal(1, importer.SourcesCreated);
        Assert.Equal(2, source.Opens);
    }

    /// <summary>
    /// <b>The fault-type rule, and it is what keeps <c>PostSendException</c> working.</b> The loop
    /// converts the seam's declared type into a terminal and leaves everything else alone. If it
    /// caught broadly instead, a <c>PostSendException</c> the framework would requeue would be
    /// swallowed into a Faulted terminal and the branch lost silently.
    /// </summary>
    [Fact]
    public async Task ConvertsTheSeamsFaultToATerminalAndLetsEverythingElseEscape()
    {
        var declared = new FakeSource { ReadThrowsOnCall = 2 }.With("a", "b");
        var (importer, _, log) = BuildImporter(declared);
        await importer.ExecuteAsync([], ImporterPayload(), Guid.Empty, CancellationToken.None);
        Assert.Contains("consumed 1/10 records; stopped because Faulted",
                        log.Records.Single(r => r.Message.Contains("stopped because")).Message);

        var bug = new FakeSource { ReadThrowsOnCall = 1, ReadThrowsSomethingElse = true }.With("a");
        var (second, _, _) = BuildImporter(bug);
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            second.ExecuteAsync([], ImporterPayload(), Guid.Empty, CancellationToken.None));
    }

    /// <summary>
    /// <b>The fault's own message survives, and the summary that reports it is findable by severity.</b>
    /// Until 2026-09-11 the catch did not bind the exception at all: a source that broke mid-batch
    /// left the word Faulted inside a parameter on an Information line and nothing else, so nothing
    /// anywhere said what had broken and no severity filter could find that anything had.
    /// </summary>
    [Fact]
    public async Task AReadFaultIsNamedAndTheSummaryIsRaised()
    {
        var source = new FakeSource { ReadThrowsOnCall = 2 }.With("a", "b");
        var (importer, _, log) = BuildImporter(source);

        await importer.ExecuteAsync([], ImporterPayload(), Guid.Empty, CancellationToken.None);

        var fault = log.Records.Single(r => r.Message.Contains("reading from", StringComparison.Ordinal));
        Assert.Equal(LogLevel.Warning, fault.Level);
        Assert.Contains("after 1 item(s)", fault.Message, StringComparison.Ordinal);

        // The exception rides the record rather than being interpolated: the message a source raises
        // is arbitrary text, and a body carrying it could only be found by a wildcard.
        Assert.Equal("the folder went away", Assert.IsType<ImportSourceException>(fault.Exception).Message);

        Assert.Equal(
            LogLevel.Warning,
            log.Records.Single(r => r.Message.Contains("stopped because", StringComparison.Ordinal)).Level);
    }

    /// <summary>
    /// An acknowledge fault says what a read fault cannot: this item's branch is already downstream,
    /// and the item itself will be read again. That duplicate is the recoverable outcome the ordering
    /// was chosen for, and it is only recoverable by someone who can see it happened.
    /// </summary>
    [Fact]
    public async Task AnAcknowledgeFaultSaysTheBranchWasAlreadySent()
    {
        var source = new FakeSource { AcknowledgeThrowsOnCall = 2 }.With("a", "b", "c");
        var (importer, sender, log) = BuildImporter(source);

        await importer.ExecuteAsync([], ImporterPayload(), Guid.Empty, CancellationToken.None);

        var fault = log.Records.Single(r => r.Message.Contains("acknowledging", StringComparison.Ordinal));
        Assert.Equal(LogLevel.Warning, fault.Level);
        Assert.Contains("its branch has already been sent", fault.Message, StringComparison.Ordinal);

        // Two branches sent, one acknowledgement taken: the claim in the message, asserted rather
        // than trusted.
        Assert.Single(source.Acknowledged);
        await sender.Received(2).SendAsync(
            Arg.Any<string>(), Arg.Any<string>(), Arg.Any<object>(), Arg.Any<CancellationToken>());
    }

    /// <summary>
    /// The half that keeps a healthy importer quiet: draining a source is an ordinary end to a batch,
    /// and a fire that logs a warning for it would make the level worthless on the only line every
    /// dispatch writes.
    /// </summary>
    [Fact]
    public async Task ADrainedSourceStaysAtInformation()
    {
        var source = new FakeSource().With("a", "b");
        var (importer, _, log) = BuildImporter(source);

        await importer.ExecuteAsync([], ImporterPayload(), Guid.Empty, CancellationToken.None);

        Assert.Equal(
            LogLevel.Information,
            log.Records.Single(r => r.Message.Contains("stopped because", StringComparison.Ordinal)).Level);

        Assert.DoesNotContain(log.Records, r => r.Level == LogLevel.Warning);
    }

    /// <summary>
    /// A source that is not ready fails the step rather than reporting a drained one, and the source
    /// is discarded so the next dispatch builds a fresh one instead of inheriting whatever state left
    /// it unready.
    /// </summary>
    [Fact]
    public async Task FailsTheStepAndDiscardsTheSourceWhenItIsNotReady()
    {
        var source = new FakeSource { Ready = false }.With("a");
        var (importer, _, _) = BuildImporter(source);

        await Assert.ThrowsAsync<FailedException>(() =>
            importer.ExecuteAsync([], ImporterPayload(), Guid.Empty, CancellationToken.None));

        Assert.True(source.Closed);
        Assert.True(source.Disposed);
    }

    // ---- The smallest exporter that can exist ----------------------------------------------

    private sealed record FileConfig(string Folder, int DeliveryTimeoutSeconds)
        : ExporterConfig(DeliveryTimeoutSeconds);

    private sealed class FakeSink : IExportSink
    {
        public List<(string Destination, byte[] Data)> Written { get; } = new();
        public bool Disposed { get; private set; }

        public Task<string> WriteAsync(string destination, byte[] data, CancellationToken ct)
        {
            Written.Add((destination, data));
            return Task.FromResult($"{destination}/0001");
        }

        public void Dispose() => Disposed = true;
    }

    private sealed class FileExporter(FakeSink sink, RecordingLogger<FileExporter> log)
        : BaseExporter<FileConfig>(log)
    {
        protected override string RequiredPayload => "folder and deliveryTimeoutSeconds";

        protected override string CacheKey(FileConfig config) => config.Folder;

        protected override string Destination(FileConfig config) => config.Folder;

        protected override IExportSink CreateSink(FileConfig config) => sink;
    }

    private static (FileExporter Exporter, RecordingLogger<FileExporter> Log) BuildExporter(FakeSink sink)
    {
        var log = new RecordingLogger<FileExporter>();
        var exporter = new FileExporter(sink, log);
        exporter.BeginDispatch(new DispatchState(Substitute.For<IQueueSender>(), C, W, S, P));
        return (exporter, log);
    }

    private static string ExporterPayload(int deliveryTimeoutSeconds = 30) =>
        $$"""{"folder":"/mnt/out","deliveryTimeoutSeconds":{{deliveryTimeoutSeconds}}}""";

    /// <summary>
    /// The destination the subclass names is what reaches the sink and what appears on the log line,
    /// and the branch ends here: no <c>SendToPostAsync</c>, so returning ends the lineage.
    /// </summary>
    [Fact]
    public async Task AnExporterThatSuppliesOnlyItsAdapterGetsEveryRule()
    {
        var sink = new FakeSink();
        var (exporter, log) = BuildExporter(sink);

        await exporter.ExecuteAsync(Encoding.UTF8.GetBytes("payload"), ExporterPayload(), E,
                                    CancellationToken.None);

        var (destination, data) = Assert.Single(sink.Written);
        Assert.Equal("/mnt/out", destination);
        Assert.Equal("payload", Encoding.UTF8.GetString(data));

        var line = log.Records.Single(r => r.Message.Contains("exported")).Message;
        Assert.Contains(E.ToString(), line);
        Assert.Contains("/mnt/out/0001", line);
    }

    /// <summary>
    /// <b>The default floor is one second</b>, the smallest value that is still a timeout, and a
    /// concrete exporter raises it when the client underneath needs more — which is what
    /// <c>KafkaExporterProcessor</c> does. Zero is refused here with no override in sight, because a
    /// timeout of zero is read by some clients as "no timeout" and would hold the replica's only lane
    /// until the far side answered or the pod died.
    /// </summary>
    [Fact]
    public async Task RefusesAZeroDeliveryTimeoutOnTheFrameworkFloorAlone()
    {
        var (exporter, _) = BuildExporter(new FakeSink());

        await Assert.ThrowsAsync<FailedException>(() =>
            exporter.ExecuteAsync(Encoding.UTF8.GetBytes("payload"), ExporterPayload(0), E,
                                  CancellationToken.None));

        await exporter.ExecuteAsync(Encoding.UTF8.GetBytes("payload"), ExporterPayload(1), E,
                                    CancellationToken.None);
    }
}

using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Observability;
using Messaging.Contracts;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Logs;
using Orchestrator.Election;
using Orchestrator.Observability;
using Xunit;

namespace BaseApi.Tests.Observability;

/// <summary>
/// The two log-record enrichers, which put on every record what a scope can only put on records
/// emitted inside one.
/// <para>
/// Both are driven through a real OpenTelemetry logger provider rather than by calling
/// <c>OnEnd</c> directly: the enricher runs as a pipeline stage, and a downstream capturing
/// processor observes what the stage actually produced. Calling <c>OnEnd</c> by hand would prove
/// the method mutates a record, not that the record reaching an exporter carries the attribute.
/// </para>
/// </summary>
public sealed class LogEnricherTests
{
    /// <summary>Sits downstream of the enricher and keeps the attributes of the last finished record.</summary>
    private sealed class CapturingProcessor : BaseProcessor<LogRecord>
    {
        public List<KeyValuePair<string, object?>> Last { get; } = [];

        public override void OnEnd(LogRecord record)
        {
            Last.Clear();
            if (record.Attributes is not null)
            {
                Last.AddRange(record.Attributes);
            }
        }
    }

    /// <summary>
    /// A provider with the enricher first and the capture second, plus a logger on it. Disposed by
    /// the caller; the returned logger stops working once it is.
    /// </summary>
    private static (ILogger Logger, CapturingProcessor Capture, ILoggerFactory Factory) Pipeline(
        BaseProcessor<LogRecord> enricher)
    {
        var capture = new CapturingProcessor();
        var factory = LoggerFactory.Create(b => b.AddOpenTelemetry(o =>
        {
            o.AddProcessor(enricher);
            o.AddProcessor(capture);
        }));

        return (factory.CreateLogger("test"), capture, factory);
    }

    private static string? Value(CapturingProcessor c, string key) =>
        c.Last.FirstOrDefault(kv => kv.Key == key).Value?.ToString();

    [Fact]
    public void AFollowerTagsEveryRecordAsFollower()
    {
        // Not "absent until it wins": a replica is a follower from construction, so the tag is on
        // every record from the first one and role=follower means a follower rather than a value
        // that had not resolved yet.
        var state = new LeaderState();
        var (log, capture, factory) = Pipeline(new OrchestratorRoleLogEnricher(state));
        using (factory)
        {
            log.LogInformation("anything");
            Assert.Equal("follower", Value(capture, OrchestratorRoleLogEnricher.Role));
        }
    }

    [Fact]
    public void APromotionShowsUpOnTheVeryNextRecordFromTheSameEnricher()
    {
        // THE POINT OF THE ENRICHER. The value is read live per record rather than captured at
        // construction, so a failover flip is visible on the next line instead of at the next
        // restart. An enricher that cached would pass the two static tests above and fail here --
        // and in production would mislabel every record a demoted replica wrote.
        var state = new LeaderState();
        var (log, capture, factory) = Pipeline(new OrchestratorRoleLogEnricher(state));
        using (factory)
        {
            log.LogInformation("while following");
            Assert.Equal("follower", Value(capture, OrchestratorRoleLogEnricher.Role));

            state.BecomeLeader();
            log.LogInformation("after winning the lease");
            Assert.Equal("leader", Value(capture, OrchestratorRoleLogEnricher.Role));

            // And back. The self-demotion fence is the half that matters: a tag that only ever went
            // up would label a demoted replica's records as the leader's for the rest of its life.
            state.BecomeFollower();
            log.LogInformation("after losing it");
            Assert.Equal("follower", Value(capture, OrchestratorRoleLogEnricher.Role));
        }
    }

    private sealed class Context : IProcessorContext
    {
        public ProcessorIdentity? Identity { get; set; }
        public bool IsHealthy => throw new NotSupportedException();
        public void SetIdentity(ProcessorIdentityFound identity) => throw new NotSupportedException();
        public void SetDefinition(Guid schemaId, string definition) => throw new NotSupportedException();
        public void MarkHealthy() => throw new NotSupportedException();
    }

    [Fact]
    public void TheProcessorEnricherAddsNothingBeforeIdentityResolves()
    {
        // Deliberately not Guid.Empty: a zero id reads as a real processor that does not exist, and
        // these are exactly the records -- the startup loops -- emitted while identity is still
        // unresolved. Absent is honest; zero is a lie that queries would match.
        var (log, capture, factory) = Pipeline(new ProcessorIdLogEnricher(new Context { Identity = null }));
        using (factory)
        {
            log.LogInformation("still resolving");

            Assert.Null(Value(capture, ExecutionLogScope.ProcessorId));
            Assert.Null(Value(capture, ProcessorIdLogEnricher.IdentityName));
        }
    }

    [Fact]
    public void TheProcessorEnricherStampsIdentityOnRecordsWithNoMessageScope()
    {
        // The gap this closes: inside a dispatch ExecutionLogScope already supplies ProcessorId, so
        // the enricher would add nothing there. Outside one -- the startup loops and the liveness
        // heartbeat, which are what an operator reads when a processor will not become ready --
        // nothing supplied it at all. This test logs with no scope open, which is that case.
        var id = Guid.NewGuid();
        var context = new Context
        {
            Identity = new ProcessorIdentity(id, null, null, null, "sample-proc", "1.5.0", null, null, null),
        };

        var (log, capture, factory) = Pipeline(new ProcessorIdLogEnricher(context));
        using (factory)
        {
            log.LogInformation("no scope around this one");

            Assert.Equal(id.ToString("D"), Value(capture, ExecutionLogScope.ProcessorId));
            Assert.Equal("sample-proc_1.5.0", Value(capture, ProcessorIdLogEnricher.IdentityName));
        }
    }
}

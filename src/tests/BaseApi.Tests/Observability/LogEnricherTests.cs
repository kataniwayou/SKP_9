using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Logs;
using Orchestrator.Election;
using Orchestrator.Observability;
using Xunit;

namespace BaseApi.Tests.Observability;

/// <summary>
/// The orchestrator's role enricher, which puts on every record what a scope can only put on
/// records emitted inside one.
/// <para>
/// There is no processor-side counterpart, deliberately: <c>ProcessorIdLogEnricher</c> stays
/// unregistered because <c>ProcessorId</c> is already a resource attribute and <c>IdentityName</c>
/// is already <c>service.name</c> plus <c>service.version</c>. See that type's own remarks.
/// </para>
/// <para>
/// Driven through a real OpenTelemetry logger provider rather than by calling <c>OnEnd</c>
/// directly: the enricher runs as a pipeline stage, and a downstream capturing processor observes
/// what the stage actually produced. Calling <c>OnEnd</c> by hand would prove
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
}

using System.Diagnostics;
using Confluent.Kafka;
using Processor.KafkaImporter.Kafka;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// The adapter, against a real broker. Everything else in the KafkaImporter suite runs through
/// <c>FakeRecordConsumer</c>, which is what keeps the hermetic run broker-free — but it also means
/// <see cref="KafkaRecordConsumer"/> itself, and every assumption it makes about how librdkafka
/// behaves, has no test above it. This file is that test, and it is the only place those assumptions
/// are checked against the thing they describe.
/// <para>
/// Needs <c>tools/kafka-dev-broker.ps1 -Up</c> and <c>SKP_REALSTACK=1</c>. It STOPS AND STARTS the
/// broker container, so it cannot share a run with anything else that needs Kafka — hence its own
/// collection.
/// </para>
/// </summary>
[Trait("Category", RealStack.Category)]
[Collection("kafka-broker")]
public sealed class KafkaImporterLiveTests
{
    /// <summary>
    /// The assignment a consumer reports is LOCAL STATE, and local state survives the broker going
    /// away. That matters because <c>WaitForAssignment</c> is part one of the dispatch: it decides
    /// between failing the step and entering the loop, and a loop entered without a reachable broker
    /// reads an empty topic and reports a healthy 0/N Drained.
    /// <para>
    /// Measured before this was fixed: with session.timeout.ms at its 45s default a warm consumer
    /// answered "assigned" for two full dispatches after the broker stopped, and at 10s for one. The
    /// timeout shortens the window; it does not close it, because clearing a local assignment also
    /// waits on coordinator reconnects that no timeout here governs.
    /// </para>
    /// </summary>
    [Fact]
    public void DoesNotClaimAnAssignmentWhileTheBrokerIsUnreachable()
    {
        RealStack.SkipUnlessEnabled();

        using var consumer = new KafkaRecordConsumer(RealStack.KafkaBrokers, $"live-assign-{Guid.NewGuid():N}");
        consumer.Subscribe(RealStack.KafkaTopic);

        Assert.True(
            consumer.WaitForAssignment(TimeSpan.FromSeconds(30)),
            "the broker is up and the topic exists, so the consumer should have been assigned a partition");

        // Drain the record the wait buffered, because a dispatch always does. WaitForAssignment polls
        // to get assigned and a poll can return a record, which it keeps rather than drops; the loop
        // then takes it as its first record. Leaving it here would have the second wait below answer
        // from that buffer instead of from the assignment, testing the wrong branch -- which is
        // exactly what the first version of this test did.
        consumer.Consume(TimeSpan.FromSeconds(5));

        Docker("stop");
        try
        {
            // The window this closes is the one a cached assignment opens. Five seconds is far shorter
            // than the 10s session timeout on purpose: if this passes only because the session timeout
            // expired, the fix is not the one being tested.
            var claimed = ClaimsAssignment(consumer, TimeSpan.FromSeconds(5));

            Assert.False(claimed,
                "the broker is stopped, so the consumer must not report an assignment it cannot act on "
                + "-- a dispatch entering the loop here reads nothing and reports Drained, which is "
                + "indistinguishable from an empty topic");
        }
        finally
        {
            Docker("start");
        }
    }

    /// <summary>
    /// Either answer is acceptable and they mean the same thing to part one, which converts a throw
    /// into the same failed step a false return produces. Collapsing them here keeps the test about
    /// the behaviour rather than about which of the two librdkafka happens to pick.
    /// </summary>
    private static bool ClaimsAssignment(KafkaRecordConsumer consumer, TimeSpan timeout)
    {
        try
        {
            return consumer.WaitForAssignment(timeout);
        }
        catch (KafkaException)
        {
            return false;
        }
    }

    private static void Docker(string verb)
    {
        using var process = Process.Start(new ProcessStartInfo("docker")
        {
            ArgumentList = { verb, RealStack.KafkaContainer },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        }) ?? throw new InvalidOperationException("could not start docker");

        process.WaitForExit(milliseconds: 60_000);

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"docker {verb} {RealStack.KafkaContainer} exited {process.ExitCode}: {process.StandardError.ReadToEnd()}");
        }
    }
}

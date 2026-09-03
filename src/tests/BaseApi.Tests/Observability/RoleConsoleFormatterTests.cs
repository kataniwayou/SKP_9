using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Orchestrator.Election;
using Orchestrator.Observability;
using Xunit;

namespace BaseApi.Tests.Observability;

/// <summary>
/// The orchestrator's console formatter, which puts on <c>kubectl logs</c> what
/// <see cref="OrchestratorRoleLogEnricher"/> only ever put on the OTLP path.
/// <para>
/// A sibling of <see cref="LogEnricherTests"/> rather than a case inside it, because the two cover
/// different sinks: that one drives a real OpenTelemetry logger provider, this one calls the
/// formatter the way <c>ConsoleLogger</c> does — synchronously, on the calling thread, into a
/// writer. Nothing here goes through <c>ILoggerFactory</c>: a console provider writes to the real
/// stdout, so a test that used one would assert against the test runner's own output stream.
/// </para>
/// </summary>
public sealed class RoleConsoleFormatterTests
{
    /// <summary>
    /// One line through the formatter, exactly as <c>ConsoleLogger.Log</c> invokes it. The state is
    /// a string and the formatter delegate ignores it, which is what a
    /// <c>LoggerMessage.Define</c> call site reduces to by the time it reaches here.
    /// </summary>
    private static string Render(
        OrchestratorRoleConsoleFormatter formatter,
        string message = "the message",
        LogLevel level = LogLevel.Information,
        string category = "Orchestrator.Messaging.StepOutcomeHandler",
        int eventId = 0,
        Exception? exception = null)
    {
        var writer = new StringWriter();
        formatter.Write(
            new LogEntry<string>(level, category, new EventId(eventId), "state", exception,
                (_, _) => message),
            scopeProvider: null,
            writer);

        return writer.ToString();
    }

    [Fact]
    public void AFollowerTagsEveryLineAsFollower()
    {
        // Not "absent until it wins", for the reason LeaderState.Role gives: a replica is a follower
        // from construction, so role=follower on the first line means a follower rather than a value
        // that had not resolved yet.
        var formatter = new OrchestratorRoleConsoleFormatter(new LeaderState());

        Assert.Contains("role=follower", Render(formatter), StringComparison.Ordinal);
    }

    [Fact]
    public void APromotionShowsUpOnTheVeryNextLine()
    {
        // THE POINT OF THE FORMATTER, and the case that fails a formatter which read the role once
        // in its constructor -- which would pass the test above and then mislabel every line a
        // demoted replica wrote for the rest of its life.
        var state = new LeaderState();
        var formatter = new OrchestratorRoleConsoleFormatter(state);

        Assert.Contains("role=follower", Render(formatter, "while following"), StringComparison.Ordinal);

        state.BecomeLeader();
        Assert.Contains("role=leader", Render(formatter, "after winning the lease"), StringComparison.Ordinal);

        // And back. The self-demotion fence is the half that matters here too.
        state.BecomeFollower();
        Assert.Contains("role=follower", Render(formatter, "after losing it"), StringComparison.Ordinal);
    }

    [Fact]
    public void TheHeaderStillCarriesLevelCategoryAndEventId()
    {
        // A custom formatter replaces the default rendering wholesale, so what it does NOT drop is
        // as much of the contract as what it adds. The message keeps its own line, indented, because
        // that is the shape every other pod in the namespace already prints.
        var formatter = new OrchestratorRoleConsoleFormatter(new LeaderState());

        var lines = Render(formatter, "advanced 1 successor(s) in 16ms", eventId: 7)
            .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries);

        Assert.Equal(
            "info: Orchestrator.Messaging.StepOutcomeHandler[7] role=follower", lines[0]);
        Assert.Equal("      advanced 1 successor(s) in 16ms", lines[1]);
    }

    [Theory]
    [InlineData(LogLevel.Trace, "trce")]
    [InlineData(LogLevel.Debug, "dbug")]
    [InlineData(LogLevel.Information, "info")]
    [InlineData(LogLevel.Warning, "warn")]
    [InlineData(LogLevel.Error, "fail")]
    [InlineData(LogLevel.Critical, "crit")]
    public void TheLevelAbbreviationsMatchTheDefaultFormatters(LogLevel level, string expected)
    {
        // Deliberately the same six strings SimpleConsoleFormatter prints. An operator greps `fail:`
        // across every pod in the namespace; this host answering differently would quietly exclude
        // itself from that search.
        var formatter = new OrchestratorRoleConsoleFormatter(new LeaderState());

        Assert.StartsWith(expected + ": ", Render(formatter, level: level), StringComparison.Ordinal);
    }

    [Fact]
    public void AnExceptionStillReachesTheOutput()
    {
        var formatter = new OrchestratorRoleConsoleFormatter(new LeaderState());
        var thrown = new InvalidOperationException("the broker went away");

        var rendered = Render(formatter, "dispatch failed", LogLevel.Error, exception: thrown);

        Assert.Contains("dispatch failed", rendered, StringComparison.Ordinal);
        Assert.Contains("the broker went away", rendered, StringComparison.Ordinal);
        Assert.Contains(nameof(InvalidOperationException), rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ARecordWithNeitherMessageNorExceptionPrintsNothing()
    {
        // What the default formatter does with one, and the reason to match it: a bare header line
        // carrying a role and no content is noise an operator has to learn to skip.
        var formatter = new OrchestratorRoleConsoleFormatter(new LeaderState());

        Assert.Equal(string.Empty, Render(formatter, message: string.Empty));
    }
}

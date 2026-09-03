using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging.Console;
using Orchestrator.Election;

namespace Orchestrator.Observability;

/// <summary>
/// Puts <c>role</c> — <c>leader</c> or <c>follower</c> — on every line this replica writes to
/// stdout, which is to say on every line <c>kubectl logs</c> shows.
/// <para>
/// <b>The console twin of <see cref="OrchestratorRoleLogEnricher"/>, and a separate type because
/// they are two sinks rather than one.</b> That enricher is a <c>LogRecord</c> processor, so it
/// reaches records on their way to the OTLP exporter and nothing else. Pod stdout comes from
/// <c>ConsoleLoggerProvider</c>, which never sees a <c>LogRecord</c> at all — which is why the role
/// was on the Elasticsearch documents and on the metric attributes and absent from the one surface
/// an operator actually reads while a failover is happening.
/// </para>
/// <para>
/// <b>A formatter rather than a scope.</b> A scope tags only the call sites that push it, and the
/// lines that matter mid-failover come from <c>Microsoft.Hosting.Lifetime</c>, Quartz and
/// <c>HealthProbeLog</c> — none of which this codebase calls. A formatter is the only hook every
/// line bound for the console provider passes through, whoever logged it.
/// </para>
/// <para>
/// <b>The value is read live, on every line.</b> Nothing is captured in the constructor, for the
/// reason <see cref="OrchestratorRoleLogEnricher"/> gives: the question this answers is "was this
/// replica leading when it wrote that", and an answer that lags a failover is worse than none.
/// </para>
/// <para>
/// <b>And there is no skew from the console's writer queue.</b> <c>ConsoleLogger.Log</c> invokes
/// this formatter on the CALLING thread and enqueues the finished string, so the
/// <see cref="LeaderState.Role"/> read happens at the moment of the log call rather than at the
/// moment of the flush. A formatter that ran on the background writer could print
/// <c>role=leader</c> against a line written while following, during exactly the burst that makes
/// the queue deep enough to matter.
/// </para>
/// <para>
/// <b>Off-cluster every line reads <c>follower</c>.</b> The election is registered only when
/// <c>KUBERNETES_SERVICE_HOST</c> is set, so a local <c>dotnet run</c> never wins anything — which
/// is the same thing this host's dispatch gate and metric attributes already say, and it is
/// accurate: that process dispatches nothing.
/// </para>
/// </summary>
public sealed class OrchestratorRoleConsoleFormatter(LeaderState state)
    : ConsoleFormatter(FormatterName)
{
    /// <summary>
    /// The name <c>ConsoleLoggerOptions.FormatterName</c> selects this formatter by. A constant
    /// rather than a literal at the registration site, because a typo there does not fail — the
    /// console provider falls back to <c>simple</c> and the role silently stops appearing.
    /// </summary>
    public const string FormatterName = "orchestrator-role";

    /// <summary>
    /// The <c>SimpleConsoleFormatter</c> shape an operator already reads, with one field appended to
    /// the header line. Appended rather than inserted so that <c>grep role=leader</c> needs no
    /// anchoring and the category still comes first for eyes that scan for it.
    /// </summary>
    /// <remarks>
    /// The three parameters keep the base class's names rather than shorter ones: this overrides a
    /// public framework contract, and a named argument at a call site binds to the override's names,
    /// not the abstract's.
    /// </remarks>
    public override void Write<TState>(
        in LogEntry<TState> logEntry, IExternalScopeProvider? scopeProvider, TextWriter textWriter)
    {
        var message = logEntry.Formatter(logEntry.State, logEntry.Exception);

        // What the default formatter does with a record that carries neither: nothing at all. A
        // blank header line would be worse than a dropped one.
        if (string.IsNullOrEmpty(message) && logEntry.Exception is null)
        {
            return;
        }

        textWriter.Write(Level(logEntry.LogLevel));
        textWriter.Write(": ");
        textWriter.Write(logEntry.Category);
        textWriter.Write('[');
        textWriter.Write(logEntry.EventId.Id);
        textWriter.Write("] role=");
        textWriter.WriteLine(state.Role);

        if (!string.IsNullOrEmpty(message))
        {
            textWriter.Write(MessagePadding);
            textWriter.WriteLine(message);
        }

        if (logEntry.Exception is not null)
        {
            textWriter.Write(MessagePadding);
            textWriter.WriteLine(logEntry.Exception.ToString());
        }
    }

    /// <summary>Six spaces, which is what <c>SimpleConsoleFormatter</c> indents a message by.</summary>
    private const string MessagePadding = "      ";

    /// <summary>
    /// The four-character level abbreviations the default console formatter uses, restated here
    /// because they are internal to it. Deliberately the same strings: an operator greps
    /// <c>fail:</c> across every pod in the namespace, and this host answering differently would
    /// exclude it from that search without anyone noticing.
    /// </summary>
    private static string Level(LogLevel level) => level switch
    {
        LogLevel.Trace       => "trce",
        LogLevel.Debug       => "dbug",
        LogLevel.Information => "info",
        LogLevel.Warning     => "warn",
        LogLevel.Error       => "fail",
        LogLevel.Critical    => "crit",
        _                    => "none",
    };
}

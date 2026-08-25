namespace Messaging.Contracts;

/// <summary>
/// The execution ids as AMQP headers: stamped by the sender, readable by anything holding the
/// delivery, and still attached to the message once it is sitting in a dead-letter queue.
/// <para>
/// <b>Why the body was not enough.</b> Every id already rides the JSON, and every handler opens a
/// log scope over them — but that scope is opened INSIDE <c>HandleAsync</c>, so an exception unwinds
/// and disposes it before the consumer's catch block runs. The park record is therefore written with
/// no ids on it at all. Measured on the live stack: four outcomes parked in one second produced four
/// byte-identical log lines, against four distinct bodies differing by execution and entry id, and
/// nothing could pair a line to a message. Attribution took reading <c>x-death</c> headers off the
/// bodies by hand.
/// </para>
/// <para>
/// <b>A header rather than a second parse, and that is the point of doing it here.</b> The consumer
/// already has the header table in hand before the gate check — it reads the clock headers from it —
/// so the ids cost nothing to reach and are available even when the body is the thing that would not
/// deserialize, which is precisely the case a park exists for. They also survive into the
/// dead-letter queue, where the management UI shows them beside the body: the same ids on the log
/// line and on the parked message, which is what makes the pairing direct rather than a join on
/// timestamps.
/// </para>
/// <para>
/// <b>Rendering matches the log scopes exactly, and that is load-bearing.</b> The execution ids
/// render <c>"D"</c>, as <see cref="ExecutionLogScope"/> renders them, so a value lifted off a header
/// pastes into an L2 key lookup unchanged. The correlation id renders through
/// <see cref="CorrelationKeys.Render"/> — 32 lowercase hex, no dashes — because it crosses the HTTP
/// boundary and the middleware echoes that spelling to clients. Two spellings of one id on a single
/// Elasticsearch field is a query that silently matches nothing.
/// </para>
/// </summary>
public static class MessageIdHeaders
{
    /// <summary>
    /// The <c>x-skp-</c> prefix matches the clock headers already on every message. Dashed lowercase
    /// rather than the PascalCase the log scopes use: these are AMQP field-table keys read by
    /// operators in the broker UI, not structured-logging property names.
    /// </summary>
    public const string CorrelationId = "x-skp-correlation-id";

    public const string ExecutionId = "x-skp-execution-id";
    public const string WorkflowId  = "x-skp-workflow-id";
    public const string StepId      = "x-skp-step-id";
    public const string ProcessorId = "x-skp-processor-id";
    public const string EntryId     = "x-skp-entry-id";

    /// <summary>
    /// Writes whatever <paramref name="body"/> can say about itself onto an outgoing header table.
    /// Accepts any payload and stamps nothing for one that implements neither interface, so the
    /// sender stays generic and a query or a reply is unaffected.
    /// <para>
    /// <b>Empty ids are omitted rather than written as zeros</b>, matching
    /// <see cref="ExecutionLogScope.BuildScope(Guid,Guid,Guid,Guid,Guid)"/>. An entry dispatch has no
    /// execution id and a source step has no entry id; a header of all-zeros would make "this id does
    /// not apply here" indistinguishable from "this id is the zero guid" to whoever reads it off a
    /// parked message.
    /// </para>
    /// </summary>
    public static void Stamp<T>(IDictionary<string, object?> headers, T body)
    {
        ArgumentNullException.ThrowIfNull(headers);

        // The narrow interface first, so a control-plane message that implements only that one still
        // carries the single id it has. IExecutionMessage extends it, so the second block adds the
        // rest for a pipeline hop.
        if (body is IWorkflowScopedMessage w)
        {
            Put(headers, WorkflowId, w.WorkflowId);
        }

        if (body is IExecutionMessage m)
        {
            Put(headers, ExecutionId, m.ExecutionId);
            Put(headers, StepId, m.StepId);
            Put(headers, ProcessorId, m.ProcessorId);
            Put(headers, EntryId, m.EntryId);

            if (m.CorrelationId != Guid.Empty)
            {
                headers[CorrelationId] = CorrelationKeys.Render(m.CorrelationId);
            }
        }
    }

    private static void Put(IDictionary<string, object?> headers, string key, Guid value)
    {
        if (value != Guid.Empty)
        {
            headers[key] = value.ToString("D");
        }
    }

    /// <summary>
    /// Rebuilds a log scope from a delivery's header table, keyed so every id lands on the SAME
    /// <c>attributes.&lt;Key&gt;</c> field a handler-scoped record would put it on — the log-scope
    /// constants, not the header names. A record written from the consumer's catch block is then
    /// queryable beside the handler's own records rather than beside nothing.
    /// <para>
    /// <b>Never throws, and returns an empty dictionary rather than null.</b> This runs on the park
    /// path, where the message has already failed once; a reader that threw would replace a
    /// recoverable park with an unhandled exception inside a catch block. A header that is absent or
    /// the wrong shape is simply left out — the same reason the transport's clock-header reader is
    /// written that way. (Named in prose rather than by <c>cref</c>: it lives in Messaging.Transport,
    /// which this project deliberately cannot reference.)
    /// </para>
    /// </summary>
    public static Dictionary<string, object> ReadScope(IDictionary<string, object?>? headers)
    {
        var scope = new Dictionary<string, object>(6);
        if (headers is null)
        {
            return scope;
        }

        Lift(headers, WorkflowId, ExecutionLogScope.WorkflowId, scope);
        Lift(headers, ExecutionId, ExecutionLogScope.ExecutionId, scope);
        Lift(headers, StepId, ExecutionLogScope.StepId, scope);
        Lift(headers, ProcessorId, ExecutionLogScope.ProcessorId, scope);
        Lift(headers, EntryId, ExecutionLogScope.EntryId, scope);
        Lift(headers, CorrelationId, CorrelationKeys.LogScope, scope);

        return scope;
    }

    /// <summary>
    /// Copies one header across under its log-scope name.
    /// <para>
    /// <b>A string written to an AMQP field table comes back as <c>byte[]</c>,</b> because the
    /// protocol's longstr carries no encoding — the client hands back the bytes rather than guessing.
    /// Reading it as a string would silently miss every header on every message, so the byte case is
    /// the one that actually fires in production and the string case is the in-process test path.
    /// </para>
    /// </summary>
    private static void Lift(
        IDictionary<string, object?> headers, string header, string scopeKey,
        Dictionary<string, object> scope)
    {
        if (!headers.TryGetValue(header, out var raw))
        {
            return;
        }

        var value = raw switch
        {
            byte[] b => System.Text.Encoding.UTF8.GetString(b),
            string s => s,
            _ => null,
        };

        if (!string.IsNullOrEmpty(value))
        {
            scope[scopeKey] = value;
        }
    }
}

using System.Text;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Transport;

/// <summary>
/// The read half of the header contract: turning a delivery's header table back into a log scope.
/// <para>
/// Asserted separately from the stamp side because the two run in different processes and the wire
/// between them changes the value's TYPE — a string written to an AMQP field table comes back as
/// <c>byte[]</c>. A round-trip test that passed the stamped dictionary straight to the reader would
/// exercise only the string path and miss the one that actually fires.
/// </para>
/// </summary>
public sealed class MessageIdHeadersTests
{
    private const string Wf   = "33333333-3333-4333-8333-333333333333";
    private const string Corr = "11111111111141118111111111111111";

    [Fact]
    public void ReadsHeadersThatArrivedAsBytes()
    {
        // THE CASE THAT ACTUALLY FIRES. AMQP's longstr carries no encoding, so the client hands back
        // raw bytes rather than guessing; a reader written only for string would find nothing on
        // every real message and the park record would stay exactly as anonymous as before.
        var headers = new Dictionary<string, object?>
        {
            [MessageIdHeaders.WorkflowId]    = Encoding.UTF8.GetBytes(Wf),
            [MessageIdHeaders.CorrelationId] = Encoding.UTF8.GetBytes(Corr),
        };

        var scope = MessageIdHeaders.ReadScope(headers);

        Assert.Equal(Wf, scope[ExecutionLogScope.WorkflowId]);
        Assert.Equal(Corr, scope[CorrelationKeys.LogScope]);
    }

    [Fact]
    public void KeysTheScopeToTheLogFieldsNotTheHeaderNames()
    {
        // The whole point of the exercise: a park record has to land on the SAME
        // attributes.<Key> fields a handler-scoped record uses, or it is queryable beside nothing.
        var scope = MessageIdHeaders.ReadScope(new Dictionary<string, object?>
        {
            [MessageIdHeaders.WorkflowId] = Wf,
        });

        Assert.True(scope.ContainsKey(ExecutionLogScope.WorkflowId));
        Assert.False(scope.ContainsKey(MessageIdHeaders.WorkflowId));
    }

    [Fact]
    public void SurvivesAnAbsentOrMalformedTableRatherThanThrowing()
    {
        // This runs inside a catch block, on a message that has already failed once. A reader that
        // threw would turn a recoverable park into an unhandled exception on the delivery path.
        Assert.Empty(MessageIdHeaders.ReadScope(null));
        Assert.Empty(MessageIdHeaders.ReadScope(new Dictionary<string, object?>()));

        var junk = MessageIdHeaders.ReadScope(new Dictionary<string, object?>
        {
            [MessageIdHeaders.WorkflowId] = 42,
            [MessageIdHeaders.StepId]     = null,
        });

        Assert.Empty(junk);
    }

    [Fact]
    public void CarriesEveryIdAMessageActuallyHadEndToEnd()
    {
        // Stamp, cross the wire as bytes, read back — the full path a parked message takes.
        var outcome = new StepOutcome(
            Guid.Parse("11111111-1111-4111-8111-111111111111"),
            Guid.Parse("22222222-2222-4222-8222-222222222222"),
            Guid.Parse(Wf),
            Guid.Parse("44444444-4444-4444-8444-444444444444"),
            Guid.Parse("55555555-5555-4555-8555-555555555555"),
            Guid.Parse("66666666-6666-4666-8666-666666666666"),
            StepResult.Completed);

        var stamped = new Dictionary<string, object?>();
        MessageIdHeaders.Stamp(stamped, outcome);

        // What the broker does to it on the way through.
        var onTheWire = stamped.ToDictionary(
            e => e.Key, e => (object?)Encoding.UTF8.GetBytes((string)e.Value!));

        var scope = MessageIdHeaders.ReadScope(onTheWire);

        Assert.Equal(6, scope.Count);
        Assert.Equal("22222222-2222-4222-8222-222222222222", scope[ExecutionLogScope.ExecutionId]);
        Assert.Equal(Wf, scope[ExecutionLogScope.WorkflowId]);
        Assert.Equal("44444444-4444-4444-8444-444444444444", scope[ExecutionLogScope.StepId]);
        Assert.Equal("55555555-5555-4555-8555-555555555555", scope[ExecutionLogScope.ProcessorId]);
        Assert.Equal("66666666-6666-4666-8666-666666666666", scope[ExecutionLogScope.EntryId]);
        Assert.Equal(Corr, scope[CorrelationKeys.LogScope]);
    }

    [Fact]
    public void AControlMessageCarriesItsWorkflowAndNothingItDoesNotHave()
    {
        // orchestrator-control and the per-replica fanout queues both have dead-letter exchanges, so
        // a start or a stop can park too — and the workflow id is the only id it has to offer.
        var stamped = new Dictionary<string, object?>();
        MessageIdHeaders.Stamp(stamped, new OrchestrationStopped(Guid.Parse(Wf)));

        Assert.Equal(Wf, stamped[MessageIdHeaders.WorkflowId]);
        Assert.False(stamped.ContainsKey(MessageIdHeaders.ExecutionId));
    }

    [Fact]
    public void StartOrchestrationForwardsTheIdFromTheGraphItCarries()
    {
        // It is the one record satisfying the interface with a computed property rather than a
        // positional parameter, because the id it reports is nested inside the definition.
        var start = new StartOrchestration(
            new WorkflowL1(Guid.Parse(Wf), [], null, []));

        var stamped = new Dictionary<string, object?>();
        MessageIdHeaders.Stamp(stamped, start);

        Assert.Equal(Wf, stamped[MessageIdHeaders.WorkflowId]);
    }

    [Fact]
    public void StartOrchestrationsBodyDidNotChangeShapeToSatisfyTheInterface()
    {
        // THE ONE PLACE THIS COULD HAVE CHANGED THE WIRE. Every other record implements the interface
        // through a positional parameter it already had, so its JSON is untouched by construction.
        // This one adds a public computed property, and System.Text.Json serializes public
        // properties -- without [JsonIgnore] the body grows a second workflowId beside the one nested
        // in workflow, on a message whose producer and consumer are rolled out separately.
        var json = System.Text.Json.JsonSerializer.Serialize(
            new StartOrchestration(new WorkflowL1(Guid.Parse(Wf), [], null, [])),
            MessagingJson.Options);

        // Counted, not absent: the NESTED WorkflowL1 serializes a workflowId of its own and always
        // did. What must not appear is a SECOND one, hoisted to the envelope by the new property.
        var occurrences = json.Split("\"WorkflowId\"").Length - 1;
        Assert.Equal(1, occurrences);
        Assert.Contains("\"Workflow\":", json);
    }
}

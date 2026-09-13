using BaseApi.Service.Features.Orchestration;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// What a refused start leaves behind for an operator, as opposed to what it returns to the caller.
/// <para>
/// <b>The two are not the same, and that was the defect.</b> The 422 body carries the gate, the
/// offending ids and a correlation id; the log line carried a status and a title. So a refusal could
/// be proven to have happened and nothing more — and the obvious query, filtered by the workflow
/// someone just failed to start, matched nothing at all, because no `WorkflowId` was on the line.
/// A refusal was indistinguishable from a request that never arrived.
/// </para>
/// <para>
/// <b><c>Exception.Data</c> is the channel, and it has to be.</b> The refusal line is written by the
/// problem-details customizer in <c>BaseApi.Core</c>, which cannot see this exception type —
/// BaseApi.Core must not reference BaseApi.Service, or a worker would drag the web stack in.
/// <c>Data</c> is what crosses, and it is already the mechanism the transport faults use for
/// <c>redisOp</c> and <c>brokerOp</c>.
/// </para>
/// </summary>
public sealed class OrchestrationRefusalDiagnosticsTests
{
    public static TheoryData<string, OrchestrationValidationException> EveryGate() => new()
    {
        { "cycle", OrchestrationValidationException.Cycle([Guid.NewGuid(), Guid.NewGuid()]) },
        { "missingStep", OrchestrationValidationException.MissingStep(Guid.NewGuid(), Guid.NewGuid()) },
        { "schemaEdge", OrchestrationValidationException.SchemaEdge(Guid.NewGuid(), Guid.NewGuid()) },
        { "payloadConfigSchema", OrchestrationValidationException.PayloadConfigSchema(Guid.NewGuid(), ["/maxDepth: 0 should be at least 1"]) },
        { "processorLiveness", OrchestrationValidationException.ProcessorNotLive(Guid.NewGuid(), "unhealthy") },
    };

    [Theory]
    [MemberData(nameof(EveryGate))]
    public void EveryGateTagsItsNameOnTheException(string gate, OrchestrationValidationException ex)
    {
        // Tagged in the private constructor, so a gate added later cannot forget: there is one
        // constructor and every factory goes through it. That is the point of doing it there rather
        // than in each factory.
        Assert.Equal(gate, ex.Data["gate"]);

        // And still on the property the handler writes into the response, which is a different
        // consumer with a different lifetime. Both, not either.
        Assert.Equal(gate, ex.Gate);
    }

    [Fact]
    public void TheGateTagSurvivesBeingThrownAndCaught()
    {
        // Data travels with the exception instance, and the refusal log reads it from
        // ProblemDetailsContext.Exception -- several frames above where it was thrown.
        // Action, not the lambda-returning-throw form: a bare `() => throw` binds to the Func<Task>
        // overload, which xunit marks obsolete as an async-testing trap.
        var thrown = Assert.Throws<OrchestrationValidationException>(
            (Action)(() => throw OrchestrationValidationException.SchemaEdge(Guid.NewGuid(), Guid.NewGuid())));

        Assert.Equal("schemaEdge", thrown.Data["gate"]);
    }

    [Fact]
    public void AWorkflowIdCanBeTaggedOnTopWithoutDisturbingTheGate()
    {
        // What OrchestrationService does around its gates: the gates see a snapshot and know nothing
        // about which start request produced it, so the service is the only place that can say.
        var workflowId = Guid.NewGuid();
        var ex = OrchestrationValidationException.PayloadConfigSchema(Guid.NewGuid(), ["/maxDepth: 0"]);

        ex.Data["workflowId"] = workflowId;

        Assert.Equal(workflowId, ex.Data["workflowId"]);
        Assert.Equal("payloadConfigSchema", ex.Data["gate"]);
    }
}

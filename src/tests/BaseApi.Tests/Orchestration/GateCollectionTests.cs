using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// The collect mode of the three snapshot gates: every problem, in the gate's own traversal order,
/// so the first collected problem is exactly the one Validate throws. No unit tests existed for these
/// gates before; the cases are derived from their code.
/// </summary>
public sealed class GateCollectionTests
{
    private static readonly DateTime T = new(2026, 10, 5, 12, 0, 0, DateTimeKind.Utc);

    private sealed class Graph
    {
        public WorkflowGraphSnapshot Snapshot { get; } = new(NullLogger<WorkflowGraphSnapshot>.Instance);

        public Guid Workflow(params Guid[] entry)
        {
            var id = Guid.NewGuid();
            Snapshot.Workflows[id] = new WorkflowReadDto(id, "wf", "1.0.0", null, entry.ToList(), [], [], null, T, T, null, null);
            return id;
        }

        public Guid Processor(Guid? input = null, Guid? output = null, Guid? config = null)
        {
            var id = Guid.NewGuid();
            Snapshot.Processors[id] = new ProcessorReadDto(id, "p", "1.0.0", null, "hash", null, input, output, config, T, T, null, null);
            return id;
        }

        public Guid Step(Guid processor)
        {
            var id = Guid.NewGuid();
            Snapshot.Steps[id] = new StepReadDto(id, "s", "1.0.0", null, processor, [], StepEntryCondition.PreviousCompleted, T, T, null, null);
            return id;
        }

        public void Wire(Guid from, params Guid[] to) => Snapshot.Steps[from].NextStepIds!.AddRange(to);

        public Guid Schema(string definition)
        {
            var id = Guid.NewGuid();
            Snapshot.Schemas[id] = new SchemaReadDto(id, "schema", "1.0.0", null, definition, T, T, null, null);
            return id;
        }

        public Guid Assignment(Guid step, string payload)
        {
            var id = Guid.NewGuid();
            Snapshot.Assignments[id] = new AssignmentReadDto(id, "asg", "1.0.0", null, step, payload, T, T, null, null);
            return id;
        }
    }

    [Fact]
    public void TheCycleGateCollectsEveryCycleAndMissingStepInTraversalOrder()
    {
        var g = new Graph();
        var p = g.Processor();
        var (a, b, c) = (g.Step(p), g.Step(p), g.Step(p));
        var ghost = Guid.NewGuid();
        g.Wire(a, b, c);
        g.Wire(b, a, ghost);   // back-edge, then a dangling wire
        g.Wire(c, c);          // self-loop
        g.Workflow(a);

        var problems = new CycleDetector().Collect(g.Snapshot);

        Assert.Equal(["cycle", "missingStep", "cycle"], problems.Select(x => x.Gate));
        Assert.Equal([a, b, a], ((CycleOffending)problems[0].Offending).stepChain);
        Assert.Equal(new MissingStepOffending(b, ghost), problems[1].Offending);
        Assert.Equal([c, c], ((CycleOffending)problems[2].Offending).stepChain);
    }

    [Fact]
    public void ValidateStillThrowsTheFirstProblemOnly()
    {
        var g = new Graph();
        var p = g.Processor();
        var (a, b) = (g.Step(p), g.Step(p));
        g.Wire(a, b);
        g.Wire(b, a, Guid.NewGuid());
        g.Workflow(a);

        var ex = Assert.Throws<OrchestrationValidationException>(() => new CycleDetector().Validate(g.Snapshot));

        Assert.Equal("cycle", ex.Gate);
        Assert.Equal([a, b, a], ((CycleOffending)ex.Offending).stepChain);
    }

    [Fact]
    public void AMissingEntryStepIsReportedAndTheNextEntryIsStillWalked()
    {
        var g = new Graph();
        var p = g.Processor();
        var a = g.Step(p);
        g.Wire(a, a);
        var ghost = Guid.NewGuid();
        g.Workflow(ghost, a);

        var problems = new CycleDetector().Collect(g.Snapshot);

        Assert.Equal(["missingStep", "cycle"], problems.Select(x => x.Gate));
        Assert.Equal(new MissingStepOffending(Guid.Empty, ghost), problems[0].Offending);
    }

    [Fact]
    public void ACleanGraphHasNoProblemsAndValidatePasses()
    {
        var g = new Graph();
        var p = g.Processor();
        var (a, b, c, d) = (g.Step(p), g.Step(p), g.Step(p), g.Step(p));
        g.Wire(a, b, c);
        g.Wire(b, d);
        g.Wire(c, d);          // a diamond is legal
        g.Workflow(a);

        Assert.Empty(new CycleDetector().Collect(g.Snapshot));
        new CycleDetector().Validate(g.Snapshot);
    }

    [Fact]
    public void TheSchemaEdgeGateCollectsEveryMismatchedEdge()
    {
        var g = new Graph();
        var (s1, s2, s3) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var a = g.Step(g.Processor(output: s1));
        var b = g.Step(g.Processor(input: s2));
        var c = g.Step(g.Processor(input: s3));
        var d = g.Step(g.Processor(input: s1));
        g.Wire(a, b, c, d);
        g.Workflow(a);

        var problems = new SchemaEdgeValidator().Collect(g.Snapshot);

        Assert.Equal([new SchemaEdgeOffending(a, b), new SchemaEdgeOffending(a, c)], problems.Select(x => x.Offending));
        var ex = Assert.Throws<OrchestrationValidationException>(() => new SchemaEdgeValidator().Validate(g.Snapshot));
        Assert.Equal(new SchemaEdgeOffending(a, b), ex.Offending);
    }

    [Fact]
    public void ThePayloadGateCollectsEveryNonConformingAssignment()
    {
        var g = new Graph();
        var cfg = g.Schema("""{"type":"object","required":["url"]}""");
        var step = g.Step(g.Processor(config: cfg));
        g.Workflow(step);
        var missing = g.Assignment(step, "{}");
        var broken = g.Assignment(step, "{not json");
        g.Assignment(step, """{"url":"https://x"}""");

        var problems = new PayloadConfigSchemaValidator().Collect(g.Snapshot);

        Assert.Equal([missing, broken], problems.Select(x => ((PayloadConfigSchemaOffending)x.Offending).assignmentId));
        Assert.Equal(["Payload is not valid JSON."], ((PayloadConfigSchemaOffending)problems[1].Offending).errors);
    }

    [Fact]
    public void AnInvalidConfigSchemaIsReportedForEachAssignmentThatUsesIt()
    {
        var g = new Graph();
        var cfg = g.Schema("{not a schema");
        var step = g.Step(g.Processor(config: cfg));
        g.Workflow(step);
        g.Assignment(step, "{}");
        g.Assignment(step, "{}");

        var problems = new PayloadConfigSchemaValidator().Collect(g.Snapshot);

        Assert.Equal(2, problems.Count);
        Assert.All(problems, x => Assert.Contains("is not a valid JSON Schema", ((PayloadConfigSchemaOffending)x.Offending).errors[0]));
    }

    [Fact]
    public void AConfigSchemaWithAnExternalRefIsReportedAndDoesNotThrow()
    {
        var g = new Graph();
        var cfg = g.Schema("""{"$ref":"https://example.invalid/x.json"}""");
        var step = g.Step(g.Processor(config: cfg));
        g.Workflow(step);
        var asg = g.Assignment(step, "{}");

        var problems = new PayloadConfigSchemaValidator().Collect(g.Snapshot);

        var problem = Assert.Single(problems);
        var offending = (PayloadConfigSchemaOffending)problem.Offending;
        Assert.Equal(asg, offending.assignmentId);
        Assert.Contains($"Config schema '{cfg}' could not be evaluated", offending.errors[0]);
    }

    [Fact]
    public void ValidateThrowsTheFirstCollectedProblemWhenALaterAssignmentHasAnUnresolvableRef()
    {
        var g = new Graph();
        var strict = g.Schema("""{"type":"object","required":["url"]}""");
        var external = g.Schema("""{"$ref":"https://example.invalid/x.json"}""");
        var stepA = g.Step(g.Processor(config: strict));
        var stepB = g.Step(g.Processor(config: external));
        g.Workflow(stepA, stepB);
        var first = g.Assignment(stepA, "{}");
        g.Assignment(stepB, "{}");

        var ex = Assert.Throws<OrchestrationValidationException>(() => new PayloadConfigSchemaValidator().Validate(g.Snapshot));

        Assert.Equal(first, ((PayloadConfigSchemaOffending)ex.Offending).assignmentId);
    }
}

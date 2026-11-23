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

    private const string RequiresHandler = """{"type": "object", "required": ["handler"], "properties": {"handler": {"type": "string"}}}""";
    private const string RequiresNothing = """{"type": "object", "properties": {"maxDepth": {"type": "integer"}}}""";

    /// <summary>The workflow links these assignments (the snapshot's own Workflow() links none).</summary>
    private static void Link(Graph g, Guid wf, params Guid[] assignments) => g.Snapshot.Workflows[wf].AssignmentIds!.AddRange(assignments);

    [Fact]
    public void AReachedStepWithoutTheRequiredPayloadIsAProblemOfItsWorkflow()
    {
        // the user, 2026-11-23: an orchestration rule, checked at Start only (Save takes the design as drawn)
        var g = new Graph();
        var (a, b) = (g.Step(g.Processor()), g.Step(g.Processor(config: g.Schema(RequiresHandler))));
        g.Wire(a, b);
        var wf = g.Workflow(a);

        var problems = new PayloadConfigSchemaValidator().Collect(g.Snapshot);

        var p = Assert.Single(problems);
        Assert.Equal("missingPayload", p.Gate);
        var off = Assert.IsType<MissingPayloadOffending>(p.Offending);
        Assert.Equal((wf, b), (off.workflowId, off.stepId));
        Assert.Equal(["handler"], off.required);
        Assert.Contains(b.ToString(), p.Message);
        Assert.Contains("handler", p.Message);
    }

    [Fact]
    public void ALinkedPayloadOrASchemaRequiringNothingNeedsNoProblem()
    {
        var g = new Graph();
        var linked = g.Step(g.Processor(config: g.Schema(RequiresHandler)));
        var free = g.Step(g.Processor(config: g.Schema(RequiresNothing)));
        var none = g.Step(g.Processor());
        g.Wire(linked, free, none);
        var wf = g.Workflow(linked);
        Link(g, wf, g.Assignment(linked, """{"handler": "Acme"}"""));

        Assert.Empty(new PayloadConfigSchemaValidator().Collect(g.Snapshot));
    }

    [Fact]
    public void AStepWhoseSchemaRefusesAnEmptyPayloadOtherwiseThanByTopLevelRequiredStillNeedsOne()
    {
        // final review: a schema can demand a payload through allOf (or if/then, minProperties): an empty payload is what counts
        var g = new Graph();
        var s = g.Step(g.Processor(config: g.Schema("""{"type": "object", "allOf": [{"required": ["handler"]}]}""")));
        g.Workflow(s);

        var p = Assert.Single(new PayloadConfigSchemaValidator().Collect(g.Snapshot));
        Assert.Equal("missingPayload", p.Gate);
    }

    [Fact]
    public void AStepSharedByTwoWorkflowsIsCheckedPerWorkflow()
    {
        var g = new Graph();
        var s = g.Step(g.Processor(config: g.Schema(RequiresHandler)));
        var a = g.Workflow(s);
        var b = g.Workflow(s);
        Link(g, a, g.Assignment(s, """{"handler": "Acme"}"""));

        var p = Assert.Single(new PayloadConfigSchemaValidator().Collect(g.Snapshot));
        Assert.Equal(b, ((MissingPayloadOffending)p.Offending).workflowId);
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
        var wf = g.Workflow(step);
        var missing = g.Assignment(step, "{}");
        var broken = g.Assignment(step, "{not json");
        var ok = g.Assignment(step, """{"url":"https://x"}""");
        Link(g, wf, missing, broken, ok); // a stored workflow links its payloads

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

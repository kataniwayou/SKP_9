using BaseApi.Service.Features.Workflow.Design;
using Microsoft.EntityFrameworkCore;
using Xunit;
using static BaseApi.Tests.WorkflowGraph.DesignBody;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// Workspace › New workflow (2026-10-10): a workflow that exists only in the studio is created by its first design save,
/// as the create stage before every other stage; its fields are the workflow CRUD's, its name is no other workflow's, and
/// the workflow stage then holds it to the CRUD's rules (at least one entry step). A retry of a committed creation is an
/// ordinary save; an id another workflow holds is refused.
/// </summary>
public sealed class DesignNewWorkflowTests
{
    private static string[] Lines(DesignOutcomeDto o) => o.Log!.Select(l => $"{l.Level} {l.Stage}: {l.Message}").ToArray();

    private static DesignNewWorkflowDto New(string name, string version = "1.0.0") =>
        new(F($$"""{"name":"{{name}}","version":"{{version}}","description":null,"cronExpression":null}"""));

    private static Dictionary<string, System.Text.Json.JsonElement> StepFields(string name) =>
        F($$"""{"name":"{{name}}","version":"1.0.0","description":null,"entryCondition":1}""");

    /// <summary>A new workflow with one new step as its entry step: what the studio sends after a paste into a blank document.</summary>
    private static DesignSaveRequest Created(Guid step, Guid proc, string name = "fresh") => Of(
        workflow: new DesignWorkflowDto(null, null, [step], null),
        newSteps: [new DesignNewStepDto(step, null, proc, StepFields("s"), null)],
        newWorkflow: New(name),
        layout: "{\"v\":1,\"steps\":{\"" + step + "\":{\"x\":320,\"y\":96}}}");

    [Fact]
    public async Task ANewWorkflowIsCreatedFirstWithItsLayoutThenItsStepsAndItsEntryList()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        Guid wf = Guid.NewGuid(), s = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Created(s, proc), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        var made = await h.Db.Workflows.SingleAsync(w => w.Id == wf, h.Ct);
        Assert.Equal(("fresh", "1.0.0", null), (made.Name, made.Version, made.Design));
        Assert.Contains(s.ToString(), made.Layout);
        Assert.Equal([s], await h.Db.WorkflowEntrySteps.Where(j => j.WorkflowId == wf).Select(j => j.StepId).ToListAsync(h.Ct));
        Assert.Equal(proc, (await h.Db.Steps.SingleAsync(x => x.Id == s, h.Ct)).ProcessorId);
        var lines = Lines(outcome);
        Assert.Equal("info store: a new workflow: nothing is stored until the create stage makes it", lines[0]);
        Assert.Contains("info create: create: 1 workflow to create", lines);
        Assert.Contains("info create: workflow 'fresh' created (its entry steps, caches and assignments are set in the workflow stage)", lines);
        Assert.Contains("info create: create: 1 created", lines);
        // the create stage comes before every other stage
        Assert.True(Array.IndexOf(lines, "info create: create: 1 workflow to create") < Array.FindIndex(lines, l => l.Contains("schemas:")));
    }

    [Fact]
    public async Task ATakenOrEmptyNameIsRefusedOnTheWorkflowAndTheRestStillReportsItself()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        await h.WorkflowAsync("taken", [await h.StepAsync(proc, "a")]);

        var wf = Guid.NewGuid();
        var outcome = await h.Syncer().SaveAsync(wf, Created(Guid.NewGuid(), proc, "taken"), h.Ct);
        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field, e.Message) == ("workflow", wf, "create", "name", "Not created: a workflow named 'taken' already exists."));
        // the workflow stage has nothing to update: no second error about a missing workflow
        Assert.DoesNotContain(outcome.Errors, e => e.Stage == "workflow");
        Assert.Contains("error outcome: rolled back: the workflow was not created and no entity was changed; nothing is stored", Lines(outcome));

        var empty = Guid.NewGuid();
        var none = await h.Syncer().SaveAsync(empty, Created(Guid.NewGuid(), proc, ""), h.Ct);
        Assert.False(none.Applied);
        Assert.Contains(none.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("workflow", empty, "create", "name"));
    }

    [Fact]
    public async Task ABlankNewWorkflowIsRefusedByTheWorkflowCrudsOwnRuleOfAtLeastOneEntryStep()
    {
        await using var h = new GraphHarness();
        var wf = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(newWorkflow: New("blank")), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("workflow", wf, "workflow", "entryStepIds"));
    }

    [Fact]
    public async Task ARetryOfACommittedCreationIsAnOrdinarySaveAndADifferentWorkflowWithTheIdIsRefused()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        Guid wf = Guid.NewGuid(), s = Guid.NewGuid();
        Assert.True((await h.Syncer().SaveAsync(wf, Created(s, proc), h.Ct)).Applied);
        h.Forget();

        // the same request again (its answer was lost): already created, every part of it already there
        var again = await h.Syncer().SaveAsync(wf, Created(s, proc), h.Ct);
        Assert.True(again.Applied, Describe(again));
        Assert.Contains("info store: the new workflow was already created by an earlier try of this save; design stored on it", Lines(again));
        h.Forget();
        Assert.Equal(1, await h.Db.Workflows.CountAsync(w => w.Id == wf, h.Ct));

        // another workflow's id: refused before anything is stored
        var other = await h.WorkflowAsync("other", [await h.StepAsync(proc, "o")]);
        var taken = await h.Syncer().SaveAsync(other, Created(Guid.NewGuid(), proc, "mine"), h.Ct);
        Assert.False(taken.Applied);
        Assert.Equal([("workflow", other, "create", "Not created: a different workflow with this id already exists.")],
            taken.Errors.Select(e => (e.Kind, e.Id, e.Stage, e.Message)));
        h.Forget();
        var kept = await h.Db.Workflows.SingleAsync(w => w.Id == other, h.Ct);
        Assert.Equal(("other", null), (kept.Name, kept.Design));
    }

    [Fact]
    public async Task ALaterStageThatFailsFailsTheCreationToo()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        Guid wf = Guid.NewGuid(), s = Guid.NewGuid();
        var body = Created(s, proc) with
        {
            NewSteps = [new DesignNewStepDto(s, null, null, StepFields("s"), null)],
        };

        var outcome = await h.Syncer().SaveAsync(wf, body, h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Field) == ("step", s, "steps", "processorId"));
        Assert.Contains("error outcome: rolled back: the workflow was not created and no entity was changed; nothing is stored", Lines(outcome));
    }
}

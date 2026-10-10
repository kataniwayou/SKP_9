using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Design;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Xunit;
using static BaseApi.Tests.WorkflowGraph.DesignBody;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// The studio's copy, paste and delete (2026-10-10): the design save creates steps and caches with the studio's ids (a
/// pasted step runs its original's processor; its assignment is a new row copied from the original's), and deletes
/// steps and caches last, refusing one another workflow still uses. Refusals roll back like every other error.
/// </summary>
public sealed class DesignCreateDeleteTests
{
    private static string[] Lines(DesignOutcomeDto o) => o.Log!.Select(l => $"{l.Level} {l.Stage}: {l.Message}").ToArray();

    private static Dictionary<string, System.Text.Json.JsonElement> StepFields(string name, int condition = 1) =>
        F($$"""{"name":"{{name}}","version":"1.0.0","description":null,"entryCondition":{{condition}}}""");

    private static async Task<List<Guid>> NextOf(GraphHarness h, Guid step)
    {
        h.Forget();
        return await h.Db.StepNextSteps.Where(j => j.StepId == step).Select(j => j.NextStepId).ToListAsync(h.Ct);
    }

    [Fact]
    public async Task APastedStepIsCreatedWithItsOriginalsProcessorItsNextStepsAndACopiedAssignment()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var asg = await h.AssignmentAsync(a, """{"k":7}""");
        var wf = await h.WorkflowAsync("wf", [a], [asg]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        Guid a2 = Guid.NewGuid(), b2 = Guid.NewGuid(), asg2 = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, [a, a2], null),
            newSteps:
            [
                new DesignNewStepDto(a2, a, proc, StepFields("a"), [b2]),
                new DesignNewStepDto(b2, b, proc, StepFields("b", 2), null),
            ],
            assignments: [new DesignAssignmentDto("create", asg2, a2, null, F("""{"payload":"{\"k\":7}"}"""), CopyOf: asg)]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        var made = await h.Db.Steps.SingleAsync(s => s.Id == a2, h.Ct);
        Assert.Equal(("a", "1.0.0", proc), (made.Name, made.Version, made.ProcessorId));
        Assert.Equal(2, (int)(await h.Db.Steps.SingleAsync(s => s.Id == b2, h.Ct)).EntryCondition);
        Assert.Equal([b2], await NextOf(h, a2));
        Assert.Equal([b], await NextOf(h, a));
        var copied = await h.Db.Assignments.SingleAsync(x => x.Id == asg2, h.Ct);
        Assert.Equal(("asg", "1.0.0", a2, """{"k":7}"""), (copied.Name, copied.Version, copied.StepId, copied.Payload));
        Assert.Equal(2, await h.Db.Assignments.CountAsync(h.Ct));
        Assert.Contains(asg2, await h.Db.WorkflowAssignments.Where(j => j.WorkflowId == wf).Select(j => j.AssignmentId).ToListAsync(h.Ct));
        Assert.Contains(a2, await h.Db.WorkflowEntrySteps.Where(j => j.WorkflowId == wf).Select(j => j.StepId).ToListAsync(h.Ct));

        var lines = Lines(outcome);
        Assert.Contains("info steps: steps: 2 steps to create", lines);
        Assert.Contains("info steps: step 'a' created (copy of 'a')", lines);
        Assert.Contains("info steps: step 'b' created (copy of 'b')", lines);
        Assert.Contains("info steps: steps: 2 created", lines);
        Assert.Contains("info wires: step 'a': next steps a→b added", lines);
        Assert.Contains("info assignments: assignment 'asg' on step 'a': created (linked to the workflow in the workflow stage)", lines);
    }

    [Fact]
    public async Task ANewIdThatIsAlreadyTakenIsRefusedAndNothingDependingOnItIsWritten()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var wf = await h.WorkflowAsync("wf", [a]);
        var asg2 = Guid.NewGuid();

        // the new step's id is a's own: a conflict, so its next steps and its assignment are refused too
        var outcome = await h.Syncer().SaveAsync(wf, Of(
            newSteps: [new DesignNewStepDto(a, null, proc, StepFields("again"), [a])],
            assignments: [new DesignAssignmentDto("create", asg2, a, null, F("""{"name":"x","version":"1.0.0","payload":"{}"}"""))]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Message) == ("step", a, "steps", "Not created: a different step with this id already exists."));
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage) == ("step", a, "wires"));
        Assert.Contains(outcome.Errors, e => (e.Kind, e.Id, e.Stage, e.Message) == ("assignment", asg2, "assignments", "Not created: its step was not created."));
        h.Forget();
        Assert.Equal("a", (await h.Db.Steps.SingleAsync(s => s.Id == a, h.Ct)).Name);
    }

    [Fact]
    public async Task ANewStepIsJudgedByTheStepCrudsRulesAndNeedsItsProcessor()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc, "a")]);
        Guid bad = Guid.NewGuid(), orphan = Guid.NewGuid(), noCondition = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(newSteps:
        [
            new DesignNewStepDto(bad, null, proc, F("""{"name":"x","version":"abc","entryCondition":1}"""), null),
            new DesignNewStepDto(orphan, null, Guid.NewGuid(), StepFields("y"), null),
            new DesignNewStepDto(noCondition, null, proc, F("""{"name":"z","version":"1.0.0"}"""), null),
        ]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Id, e.Stage, e.Field) == (bad, "steps", "version"));
        Assert.Contains(outcome.Errors, e => (e.Id, e.Stage, e.Field, e.Message) == (orphan, "steps", "processorId", "Not created: its processor no longer exists."));
        Assert.Contains(outcome.Errors, e => (e.Id, e.Stage, e.Field) == (noCondition, "steps", "entryCondition"));
    }

    [Fact]
    public async Task APastedCacheIsCreatedAndLinkedByTheWorkflowsCacheList()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var cache = await h.CacheAsync("root-a");
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc, "a")]);
        h.Db.Add(new WorkflowCaches { WorkflowId = wf, CacheId = cache });
        await h.Db.SaveChangesAsync(h.Ct);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        var copy = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, null, [cache, copy]),
            newCaches: [new DesignNewCacheDto(copy, cache, F("""{"name":"cache","version":"1.0.0","description":null,"root":"root-a-copy","items":"{}"}"""))]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        var made = await h.Db.Caches.SingleAsync(c => c.Id == copy, h.Ct);
        Assert.Equal(("cache", "root-a-copy"), (made.Name, made.Root));
        Assert.NotEqual((await h.Db.Caches.SingleAsync(c => c.Id == cache, h.Ct)).Root, made.Root);
        Assert.Equal(2, await h.Db.WorkflowCaches.CountAsync(j => j.WorkflowId == wf, h.Ct));
        var lines = Lines(outcome);
        Assert.Contains("info caches: caches: 1 cache to create", lines);
        Assert.Contains("info caches: cache 'cache' created (copy of 'cache')", lines);
        Assert.Contains("info caches: caches: 1 created", lines);
    }

    [Fact]
    public async Task ADeletedStepGoesWithItsAssignmentOnceThisWorkflowNoLongerListsIt()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var c = await h.StepAsync(proc, "c");
        var b = await h.StepAsync(proc, "b", c);
        var a = await h.StepAsync(proc, "a", b);
        var asg = await h.AssignmentAsync(b);
        var wf = await h.WorkflowAsync("wf", [a], [asg]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var stamp = (Guid id) => loaded.Steps.Single(s => s.Id == id).UpdatedAt;
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, null, null),
            steps: [new DesignStepDto(a, stamp(a), null, [])],
            deletedSteps: [new DesignDeleteDto(b, stamp(b))]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        Assert.False(await h.Db.Steps.AnyAsync(s => s.Id == b, h.Ct));
        Assert.False(await h.Db.Assignments.AnyAsync(x => x.Id == asg, h.Ct));
        Assert.False(await h.Db.WorkflowAssignments.AnyAsync(j => j.AssignmentId == asg, h.Ct));
        Assert.False(await h.Db.StepNextSteps.AnyAsync(j => j.StepId == b || j.NextStepId == b, h.Ct));
        Assert.True(await h.Db.Steps.AnyAsync(s => s.Id == c, h.Ct), "only the picked step goes");
        var lines = Lines(outcome);
        Assert.Contains("info deletes: deletes: 1 step to delete", lines);
        Assert.Contains("info deletes: step 'b' deleted, with its assignment 'asg'", lines);
        Assert.Contains("info deletes: deletes: 1 deleted", lines);
    }

    [Fact]
    public async Task AStepAnotherWorkflowStillUsesIsRefusedInRedAndTheSaveRollsBack()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var shared = await h.StepAsync(proc, "shared");
        var feeder = await h.StepAsync(proc, "feeder", shared);
        var a = await h.StepAsync(proc, "a");
        var wf = await h.WorkflowAsync("wf", [a, shared]);
        await h.WorkflowAsync("other", [shared]);
        await h.WorkflowAsync("third", [feeder]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, [a], null),
            deletedSteps: [new DesignDeleteDto(shared, loaded.Steps.Single(s => s.Id == shared).UpdatedAt)]), h.Ct);

        Assert.False(outcome.Applied);
        var error = Assert.Single(outcome.Errors);
        Assert.Equal(("step", shared, "deletes", (string?)null), (error.Kind, error.Id, error.Stage, error.Field));
        Assert.Equal("Not deleted: still used by workflow 'other' (an entry step there); still used: step 'feeder' lists it as a next step.", error.Message);
        Assert.Contains($"error deletes: step 'shared': {error.Message}", Lines(outcome));
        Assert.Contains("error deletes: deletes: 1 refused", Lines(outcome));
        Assert.Equal("error outcome: rolled back: no entity was changed; the design stays stored on the workflow", Lines(outcome)[^1]);
        h.Forget();
        Assert.True(await h.Db.Steps.AnyAsync(s => s.Id == shared, h.Ct));
    }

    [Fact]
    public async Task AStepWithAnAssignmentOfAnotherWorkflowIsRefused()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var b = await h.StepAsync(proc, "b");
        var theirs = await h.AssignmentAsync(b);
        var wf = await h.WorkflowAsync("wf", [a, b]);
        await h.WorkflowAsync("other", [a], [theirs]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, [a], null),
            deletedSteps: [new DesignDeleteDto(b, loaded.Steps.Single(s => s.Id == b).UpdatedAt)]), h.Ct);

        Assert.Equal("Not deleted: still used by workflow 'other' (its assignment for this step).", Assert.Single(outcome.Errors).Message);
    }

    [Fact]
    public async Task AStepThisWorkflowStillListsIsRefusedAndAStaleOneConflicts()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var c = await h.StepAsync(proc, "c");
        var wf = await h.WorkflowAsync("wf", [a, c]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var stampC = loaded.Steps.Single(s => s.Id == c).UpdatedAt;
        h.Tick();
        var row = await h.Db.Steps.SingleAsync(s => s.Id == c, h.Ct);
        row.Description = "someone else";
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(deletedSteps:
        [
            new DesignDeleteDto(b, loaded.Steps.Single(s => s.Id == b).UpdatedAt),
            new DesignDeleteDto(c, stampC),
        ]), h.Ct);

        Assert.Contains(outcome.Errors, e => (e.Id, e.Message) == (b, "Not deleted: still used: step 'a' lists it as a next step."));
        Assert.Contains(outcome.Errors, e => (e.Id, e.Message) == (c, DesignRun.Conflict));
    }

    [Fact]
    public async Task StepsDeletedTogetherDoNotHoldEachOtherAndOneAlreadyGoneIsWhatWasAsked()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var c = await h.StepAsync(proc, "c");
        var b = await h.StepAsync(proc, "b", c);
        var wf = await h.WorkflowAsync("wf", [a, b]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var stamp = (Guid id) => loaded.Steps.Single(s => s.Id == id).UpdatedAt;
        h.Forget();

        // c first: b still lists it, but b goes too
        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, [a], null),
            deletedSteps: [new DesignDeleteDto(c, stamp(c)), new DesignDeleteDto(b, stamp(b)), new DesignDeleteDto(Guid.NewGuid(), DateTime.UtcNow)]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        Assert.Equal([a], await h.Db.Steps.Select(s => s.Id).ToListAsync(h.Ct));
        Assert.Contains("info deletes: deletes: 2 deleted, 1 unchanged", Lines(outcome));
    }

    [Fact]
    public async Task ACacheIsDeletedOnlyWhenNoWorkflowListsIt()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var mine = await h.CacheAsync("root-mine");
        var shared = await h.CacheAsync("root-shared");
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc, "a")]);
        var other = await h.WorkflowAsync("other", [await h.StepAsync(proc, "x")]);
        h.Db.AddRange(new WorkflowCaches { WorkflowId = wf, CacheId = mine }, new WorkflowCaches { WorkflowId = wf, CacheId = shared },
            new WorkflowCaches { WorkflowId = other, CacheId = shared });
        await h.Db.SaveChangesAsync(h.Ct);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var refused = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, null, []),
            deletedCaches: [new DesignDeleteDto(mine, null), new DesignDeleteDto(shared, null)]), h.Ct);

        Assert.False(refused.Applied);
        var error = Assert.Single(refused.Errors);
        Assert.Equal(("cache", shared, "deletes", "Not deleted: still used by workflow 'other'."), (error.Kind, error.Id, error.Stage, error.Message));
        Assert.Contains("info deletes: cache 'cache' deleted", Lines(refused));
    }

    [Fact]
    public async Task CreatesComeInTheirStagesAndDeletesLastInOneSave()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var cache = await h.CacheAsync("root");
        var b = await h.StepAsync(proc, "b");
        var a = await h.StepAsync(proc, "a", b);
        var wf = await h.WorkflowAsync("wf", [a]);
        h.Db.Add(new WorkflowCaches { WorkflowId = wf, CacheId = cache });
        await h.Db.SaveChangesAsync(h.Ct);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        var stamp = (Guid id) => loaded.Steps.Single(s => s.Id == id).UpdatedAt;
        h.Forget();
        Guid n = Guid.NewGuid(), nc = Guid.NewGuid();

        // b is replaced by its copy n: a now leads to n, b goes; the cache by its copy nc
        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, null, [nc]),
            steps: [new DesignStepDto(a, stamp(a), null, [n])],
            newSteps: [new DesignNewStepDto(n, b, proc, StepFields("b"), null)],
            newCaches: [new DesignNewCacheDto(nc, cache, F("""{"name":"cache","version":"1.0.0","root":"root-copy","items":"{}"}"""))],
            deletedSteps: [new DesignDeleteDto(b, stamp(b))],
            deletedCaches: [new DesignDeleteDto(cache, null)]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        var lines = Lines(outcome);
        string[] order =
        [
            "info caches: cache 'cache' created (copy of 'cache')",
            "info steps: step 'b' created (copy of 'b')",
            "info wires: step 'a': next steps a→b added, a→b removed",
            "info workflow: workflow 'wf': caches cache added, cache removed",
            "info deletes: deletes: 2 steps and caches to delete",
            "info deletes: step 'b' deleted",
            "info deletes: cache 'cache' deleted",
            "info outcome: dry run passed: 6 changes, no errors",
        ];
        var at = order.Select(l => Array.IndexOf(lines, l)).ToArray();
        Assert.DoesNotContain(-1, at);
        Assert.Equal(at.OrderBy(i => i), at);
        h.Forget();
        Assert.Equal([n], await NextOf(h, a));
        Assert.False(await h.Db.Steps.AnyAsync(s => s.Id == b, h.Ct));
        Assert.False(await h.Db.Caches.AnyAsync(c => c.Id == cache, h.Ct));
    }

    [Fact]
    public async Task ARootAnotherCacheUsesIsRefusedClearlyOnCreateAndOnUpdate()
    {
        // uq_cache_root: InMemory does not enforce it, so the stage says so itself (WorkflowDesignLiveTests checks Postgres)
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var cache = await h.CacheAsync("root-a");
        var other = await h.CacheAsync("root-b");
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc, "a")]);
        var copy = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            caches: [new DesignCacheDto(other, F("""{"root":"root-a"}"""))],
            newCaches: [new DesignNewCacheDto(copy, cache, F("""{"name":"cache","version":"1.0.0","root":"root-a","items":"{}"}"""))]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Id, e.Stage, e.Field, e.Message) == (copy, "caches", "root", "Root 'root-a' is already used by cache 'cache'."));
        Assert.Contains(outcome.Errors, e => (e.Id, e.Stage, e.Field, e.Message) == (other, "caches", "root", "Root 'root-a' is already used by cache 'cache'."));
    }

    [Fact]
    public async Task ACreateSentAgainAfterALostAnswerFindsItsOwnRowsAndAppliesAsUnchanged()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        Guid n = Guid.NewGuid(), nc = Guid.NewGuid(), na = Guid.NewGuid();
        DesignSaveRequest Body(DateTime stamp) => Of(
            workflow: new DesignWorkflowDto(stamp, null, null, [nc]),
            newSteps: [new DesignNewStepDto(n, a, proc, StepFields("a"), null)],
            newCaches: [new DesignNewCacheDto(nc, null, F("""{"name":"c","version":"1.0.0","root":"r-copy","items":"{}"}"""))],
            assignments: [new DesignAssignmentDto("create", na, n, null, F("""{"name":"x","version":"1.0.0","payload":"{}"}"""))]);

        Assert.True((await h.Syncer().SaveAsync(wf, Body(loaded.Workflow.UpdatedAt), h.Ct)).Applied);
        h.Forget();
        var again = await h.Syncer().SaveAsync(wf, Body((await h.Db.Workflows.SingleAsync(w => w.Id == wf, h.Ct)).UpdatedAt), h.Ct);

        Assert.True(again.Applied, Describe(again));
        Assert.Contains("info steps: steps: 1 unchanged", Lines(again));
        Assert.Contains("info caches: caches: 1 unchanged", Lines(again));
        Assert.Contains("info assignments: assignments: 1 unchanged", Lines(again));
        h.Forget();
        Assert.Equal(2, await h.Db.Steps.CountAsync(h.Ct));
    }

    [Fact]
    public async Task ACreateSentAgainIsRefusedWhenItsRowsWereTakenUpElsewhereMeanwhile()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        Guid n = Guid.NewGuid(), m = Guid.NewGuid(), k = Guid.NewGuid(), na = Guid.NewGuid();
        DesignSaveRequest Body(DateTime stamp) => Of(
            workflow: new DesignWorkflowDto(stamp, null, null, null),
            newSteps: [new DesignNewStepDto(n, a, proc, StepFields("n"), null), new DesignNewStepDto(m, a, proc, StepFields("m"), null),
                new DesignNewStepDto(k, a, proc, StepFields("k"), null)],
            assignments: [new DesignAssignmentDto("create", na, k, null, F("""{"name":"x","version":"1.0.0","payload":"{}"}"""))]);
        Assert.True((await h.Syncer().SaveAsync(wf, Body(loaded.Workflow.UpdatedAt), h.Ct)).Applied);

        // meanwhile: a stranger's step leads to n, another workflow lists m as an entry step and links the assignment
        var stranger = await h.StepAsync(proc, "stranger", n);
        await h.WorkflowAsync("other", [m], [na]);
        h.Forget();
        var again = await h.Syncer().SaveAsync(wf, Body((await h.Db.Workflows.SingleAsync(w => w.Id == wf, h.Ct)).UpdatedAt), h.Ct);

        Assert.False(again.Applied);
        Assert.Contains(again.Errors, e => (e.Id, e.Message) == (n, "Not created: a different step with this id already exists."));
        Assert.Contains(again.Errors, e => (e.Id, e.Message) == (m, "Not created: a different step with this id already exists."));
        Assert.Contains(again.Errors, e => (e.Id, e.Message) == (na, "Not created: a different assignment with this id already exists."));
        Assert.NotEqual(Guid.Empty, stranger);
    }

    [Fact]
    public async Task APastedAssignmentCarriesItsOwnFieldsSoItSavesWhenItsOriginalIsGone()
    {
        // cut and paste across workflows: the original row was deleted before the copy is saved
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var wf = await h.WorkflowAsync("wf", [await h.StepAsync(proc, "a")]);
        Guid n = Guid.NewGuid(), na = Guid.NewGuid(), gone = Guid.NewGuid();
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, null, null),
            newSteps: [new DesignNewStepDto(n, null, proc, StepFields("cut"), null)],
            assignments: [new DesignAssignmentDto("create", na, n, null,
                F("""{"name":"asg","version":"2.0.0","description":"kept","payload":"{\"k\":1}"}"""), CopyOf: gone)]), h.Ct);

        Assert.True(outcome.Applied, Describe(outcome));
        h.Forget();
        var made = await h.Db.Assignments.SingleAsync(x => x.Id == na, h.Ct);
        Assert.Equal(("asg", "2.0.0", "kept", n), (made.Name, made.Version, made.Description, made.StepId));
    }

    [Fact]
    public async Task OnlyTheWorkflowsOwnStepsAndCachesAreDeletedAndARefusedDeleteStaysItsOwn()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var parked = await h.StepAsync(proc, "parked");
        var stranger = await h.StepAsync(proc, "stranger");
        var foreign = await h.CacheAsync("foreign");
        var wf = await h.WorkflowAsync("wf", [a], layout: $$"""{"v":2,"parked":["{{parked}}"]}""");
        var other = await h.WorkflowAsync("other", [parked]);
        h.Forget();
        var stamp = (Guid id) => h.Db.Steps.AsNoTracking().Single(s => s.Id == id).UpdatedAt;

        // the parked step is this workflow's (its layout places it) but another workflow uses it: refused for that
        var outcome = await h.Syncer().SaveAsync(wf, Of(
            deletedSteps: [new DesignDeleteDto(stranger, stamp(stranger)), new DesignDeleteDto(parked, stamp(parked))],
            deletedCaches: [new DesignDeleteDto(foreign, null)]), h.Ct);

        Assert.Contains(outcome.Errors, e => (e.Id, e.Message) == (stranger, "Not deleted: not a step of this workflow."));
        Assert.Contains(outcome.Errors, e => (e.Id, e.Message) == (foreign, "Not deleted: not a cache of this workflow."));
        Assert.Contains(outcome.Errors, e => (e.Id, e.Message) == (parked, "Not deleted: still used by workflow 'other' (an entry step there)."));

        // the stored layout no longer places it, but the stored design's delete keeps it this workflow's own
        h.Db.RemoveRange(h.Db.WorkflowEntrySteps.Where(j => j.WorkflowId == other));
        await h.Db.SaveChangesAsync(h.Ct);
        h.Forget();
        var next = await h.Syncer().SaveAsync(wf, Of(deletedSteps: [new DesignDeleteDto(parked, stamp(parked))]), h.Ct);
        Assert.True(next.Applied, Describe(next));
        h.Forget();
        Assert.False(await h.Db.Steps.AnyAsync(s => s.Id == parked, h.Ct));
    }

    [Fact]
    public void AnIdCreatedAndDeletedOrChangedInOneDesignIsMalformed()
    {
        var id = Guid.NewGuid();
        var proc = Guid.NewGuid();
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Of(
            newSteps: [new DesignNewStepDto(id, null, proc, null, null)], deletedSteps: [new DesignDeleteDto(id, null)])));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Of(
            newSteps: [new DesignNewStepDto(id, null, proc, null, null)], steps: [new DesignStepDto(id, null, null, null)])));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Of(
            newCaches: [new DesignNewCacheDto(id, null, null)], deletedCaches: [new DesignDeleteDto(id, null)])));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Of(
            newSteps: [new DesignNewStepDto(Guid.Empty, null, proc, null, null)])));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Of(
            newCaches: [new DesignNewCacheDto(Guid.Empty, null, null)])));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Of(
            newSteps: [new DesignNewStepDto(id, Guid.Empty, proc, null, null)])));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Of(
            assignments: [new DesignAssignmentDto("create", id, proc, null, null, Guid.Empty)])));
        Assert.Null(Record.Exception(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Of(
            newSteps: [new DesignNewStepDto(id, null, proc, null, null)], deletedSteps: [new DesignDeleteDto(Guid.NewGuid(), null)]))));
    }

    [Fact]
    public void AnOlderStudiosBodyWithoutTheNewListsStillReads()
    {
        var body = System.Text.Json.JsonSerializer.Deserialize<DesignSaveRequest>(
            """{"workflow":null,"steps":[],"layout":{"v":1},"assignments":[{"op":"create","id":"5b1f6f0e-0000-4000-8000-000000000001","stepId":"5b1f6f0e-0000-4000-8000-000000000002","updatedAt":null,"fields":null}]}""",
            new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;
        Assert.Null(body.NewSteps);
        Assert.Null(body.DeletedCaches);
        Assert.Null(body.Assignments![0].CopyOf);
    }

    // ---- a step with its processor removed in the design (2026-10-10): the steps stage refuses it, the dry run fails ----

    [Fact]
    public void ANewStepWithNoProcessorIsNotAMalformedBody()
    {
        Assert.Null(Record.Exception(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Of(
            newSteps: [new DesignNewStepDto(Guid.NewGuid(), null, null, null, null), new DesignNewStepDto(Guid.NewGuid(), null, Guid.Empty, null, null)]))));
    }

    [Fact]
    public async Task ANewStepWithNoProcessorIsRefusedOnItsProcessorAndNothingIsWritten()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();
        Guid none = Guid.NewGuid(), empty = Guid.NewGuid();

        var outcome = await h.Syncer().SaveAsync(wf, Of(
            workflow: new DesignWorkflowDto(loaded.Workflow.UpdatedAt, null, [a, none, empty], null),
            newSteps:
            [
                new DesignNewStepDto(none, a, null, StepFields("n"), null),
                new DesignNewStepDto(empty, a, Guid.Empty, StepFields("e"), null),
            ]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Id, e.Stage, e.Field, e.Message) == (none, "steps", "processorId", DesignFields.NoProcessor));
        Assert.Contains(outcome.Errors, e => (e.Id, e.Stage, e.Field, e.Message) == (empty, "steps", "processorId", DesignFields.NoProcessor));
        h.Forget();
        Assert.Equal(1, await h.Db.Steps.CountAsync(h.Ct));
    }

    [Fact]
    public async Task AStepWhoseProcessorTheDesignRemovedIsRefusedAndKeepsItsRow()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var a = await h.StepAsync(proc, "a");
        var wf = await h.WorkflowAsync("wf", [a]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        h.Forget();

        var outcome = await h.Syncer().SaveAsync(wf, Of(steps:
            [new DesignStepDto(a, loaded.Steps.Single(s => s.Id == a).UpdatedAt, F("""{"processorId":null,"description":"d"}"""), null)]), h.Ct);

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Errors, e => (e.Id, e.Stage, e.Field, e.Message) == (a, "steps", "processorId", DesignFields.NoProcessor));
        h.Forget();
        var row = await h.Db.Steps.SingleAsync(s => s.Id == a, h.Ct);
        Assert.Equal((proc, (string?)null), (row.ProcessorId, row.Description));
    }

    [Fact]
    public async Task AStepsProcessorFieldNamesAnExistingProcessorOrIsRefused()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var other = await h.ProcessorAsync("other");
        var a = await h.StepAsync(proc, "a");
        var b = await h.StepAsync(proc, "b");
        var c = await h.StepAsync(proc, "c");
        var wf = await h.WorkflowAsync("wf", [a, b, c]);
        var loaded = await h.Reader.ReadAsync(wf, h.Ct);
        DateTime? Stamp(Guid id) => loaded.Steps.Single(s => s.Id == id).UpdatedAt;
        h.Forget();

        var refused = await h.Syncer().SaveAsync(wf, Of(steps:
        [
            new DesignStepDto(b, Stamp(b), F($$"""{"processorId":"{{Guid.NewGuid()}}"}"""), null),
            new DesignStepDto(c, Stamp(c), F("""{"processorId":7}"""), null),
        ]), h.Ct);
        Assert.False(refused.Applied);
        Assert.Contains(refused.Errors, e => (e.Id, e.Field, e.Message) == (b, "processorId", "Its processor no longer exists."));
        Assert.Contains(refused.Errors, e => (e.Id, e.Field) == (c, "processorId"));
        h.Forget();

        var moved = await h.Syncer().SaveAsync(wf, Of(steps: [new DesignStepDto(a, Stamp(a), F($$"""{"processorId":"{{other}}"}"""), null)]), h.Ct);
        Assert.True(moved.Applied, Describe(moved));
        h.Forget();
        Assert.Equal(other, (await h.Db.Steps.SingleAsync(s => s.Id == a, h.Ct)).ProcessorId);
        Assert.Contains("info steps: step 'a': processor changed", Lines(moved));
    }
}

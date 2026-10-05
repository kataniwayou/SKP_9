using BaseApi.Service;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>
/// The junction sync shared by the CRUD services and the graph saver. One implementation, so a
/// graph save and a plain PUT can never disagree about what "replace the wires" means.
/// </summary>
public sealed class JunctionHelperTests
{
    private static AppDbContext NewContext() =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"junctions-{Guid.NewGuid():N}")
            .Options);

    [Fact]
    public async Task ReplacingNextStepsRemovesTheOldWiresAndAddsTheNew()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var db = NewContext();
        var step = Guid.NewGuid();
        var (a, b, c) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        db.AddRange(new StepNextSteps { StepId = step, NextStepId = a }, new StepNextSteps { StepId = step, NextStepId = b });
        await db.SaveChangesAsync(ct);

        await StepJunctions.SyncNextStepsAsync(db, step, [b, c], replaceExisting: true, ct);
        await db.SaveChangesAsync(ct);

        var now = await db.StepNextSteps.Where(j => j.StepId == step).Select(j => j.NextStepId).ToListAsync(ct);
        Assert.Equal(new[] { b, c }.OrderBy(x => x), now.OrderBy(x => x));
    }

    [Fact]
    public async Task WithoutReplaceTheExistingWiresAreLeftAlone()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var db = NewContext();
        var step = Guid.NewGuid();
        var (a, b) = (Guid.NewGuid(), Guid.NewGuid());
        db.Add(new StepNextSteps { StepId = step, NextStepId = a });
        await db.SaveChangesAsync(ct);

        await StepJunctions.SyncNextStepsAsync(db, step, [b], replaceExisting: false, ct);
        await db.SaveChangesAsync(ct);

        Assert.Equal(2, await db.StepNextSteps.CountAsync(j => j.StepId == step, ct));
    }

    [Fact]
    public async Task ReplacingTheWorkflowJunctionsReplacesAllThree()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var db = NewContext();
        var wf = Guid.NewGuid();
        var (oldEntry, newEntry, oldAsg, newCache) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        db.AddRange(
            new WorkflowEntrySteps { WorkflowId = wf, StepId = oldEntry },
            new WorkflowAssignments { WorkflowId = wf, AssignmentId = oldAsg });
        await db.SaveChangesAsync(ct);

        await WorkflowJunctions.SyncAsync(db, wf, [newEntry], assignmentIds: null, cacheIds: [newCache], replaceExisting: true, ct);
        await db.SaveChangesAsync(ct);

        Assert.Equal([newEntry], await db.WorkflowEntrySteps.Where(j => j.WorkflowId == wf).Select(j => j.StepId).ToListAsync(ct));
        Assert.Empty(await db.WorkflowAssignments.Where(j => j.WorkflowId == wf).ToListAsync(ct));
        Assert.Equal([newCache], await db.WorkflowCaches.Where(j => j.WorkflowId == wf).Select(j => j.CacheId).ToListAsync(ct));
    }
}

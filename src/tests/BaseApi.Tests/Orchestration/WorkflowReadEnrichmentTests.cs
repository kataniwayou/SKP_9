using BaseApi.Service;
using BaseApi.Service.Features.Workflow;
using BaseApi.Core.Persistence.Repositories;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// The read path must return both junction-backed collections. They live in
/// <c>workflow_entry_steps</c> and <c>workflow_assignments</c> rather than on the entity, so the
/// mapper cannot supply them and hard-codes null; without an enrichment step every read reports a
/// workflow as having no entry steps and no assignments, and a client that reads-then-writes
/// destroys the bindings it just failed to see.
/// </summary>
public sealed class WorkflowReadEnrichmentTests : IAsyncLifetime
{
    private AppDbContext _db = null!;
    private WorkflowService _service = null!;
    private readonly Guid _entryStep = Guid.NewGuid();
    private readonly Guid _otherEntryStep = Guid.NewGuid();
    private readonly Guid _assignmentA = Guid.NewGuid();
    private readonly Guid _assignmentB = Guid.NewGuid();
    private Guid _bound, _bare;

    public async ValueTask InitializeAsync()
    {
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"workflow-enrichment-{Guid.NewGuid():N}")
            .Options);

        _service = new WorkflowService(
            new WorkflowCreateDtoValidator(),
            new WorkflowUpdateDtoValidator(),
            new WorkflowEntityMapper(),
            new Repository<WorkflowEntity>(_db),
            _db);

        // Two entry steps and two assignments on the first workflow, so neither assertion can pass by
        // accident on a single-element list. The second has no assignments at all.
        _bound = await CreateAsync("wf-bound", [_entryStep, _otherEntryStep], [_assignmentA, _assignmentB]);
        _bare  = await CreateAsync("wf-bare", [_entryStep], null);
    }

    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    private async Task<Guid> CreateAsync(string name, List<Guid> entry, List<Guid>? assignments)
    {
        var dto = new WorkflowCreateDto(name, "1.0.0", null, entry, assignments, null);
        return (await _service.CreateAsync(dto, TestContext.Current.CancellationToken)).Id;
    }

    [Fact]
    public async Task GetByIdReturnsTheEntrySteps()
    {
        var read = await _service.GetByIdAsync(_bound, TestContext.Current.CancellationToken);

        Assert.NotNull(read.EntryStepIds);
        Assert.Equal(
            new[] { _entryStep, _otherEntryStep }.OrderBy(x => x),
            read.EntryStepIds!.OrderBy(x => x));
    }

    [Fact]
    public async Task GetByIdReturnsTheAssignments()
    {
        var read = await _service.GetByIdAsync(_bound, TestContext.Current.CancellationToken);

        Assert.NotNull(read.AssignmentIds);
        Assert.Equal(
            new[] { _assignmentA, _assignmentB }.OrderBy(x => x),
            read.AssignmentIds!.OrderBy(x => x));
    }

    [Fact]
    public async Task GetByIdReturnsAnEmptyListForAWorkflowWithNoAssignments()
    {
        // Empty, not null. Null previously meant "not populated"; now the field always means what it
        // says, so a caller can tell an unassigned workflow from an unread collection.
        var read = await _service.GetByIdAsync(_bare, TestContext.Current.CancellationToken);

        Assert.NotNull(read.AssignmentIds);
        Assert.Empty(read.AssignmentIds!);
        Assert.Equal([_entryStep], read.EntryStepIds!);
    }

    [Fact]
    public async Task ListReturnsBothCollectionsForEveryWorkflow()
    {
        var all = await _service.ListAsync(TestContext.Current.CancellationToken);

        Assert.Equal(2, all.Count);
        Assert.Equal(2, all.Single(w => w.Id == _bound).EntryStepIds!.Count);
        Assert.Equal(2, all.Single(w => w.Id == _bound).AssignmentIds!.Count);
        Assert.Single(all.Single(w => w.Id == _bare).EntryStepIds!);
        Assert.Empty(all.Single(w => w.Id == _bare).AssignmentIds!);
    }

    [Fact]
    public async Task CreateEchoesBackWhatWasPersisted()
    {
        // The response to a POST that supplied both collections must not report them as absent — that
        // reads as the input having been dropped, and invites a retry that duplicates the workflow,
        // which nothing in the schema prevents.
        var created = await _service.CreateAsync(
            new WorkflowCreateDto("wf-created", "1.0.0", null, [_entryStep], [_assignmentA], null),
            TestContext.Current.CancellationToken);

        Assert.Equal([_entryStep], created.EntryStepIds!);
        Assert.Equal([_assignmentA], created.AssignmentIds!);
    }

    [Fact]
    public async Task UpdateReflectsTheReplacedCollections()
    {
        // Update is remove-and-replace on both junctions, so the response has to show the new sets
        // rather than the old.
        var updated = await _service.UpdateAsync(
            _bound,
            new WorkflowUpdateDto("wf-bound", "1.0.0", null, [_otherEntryStep], [_assignmentB], null),
            TestContext.Current.CancellationToken);

        Assert.Equal([_otherEntryStep], updated.EntryStepIds!);
        Assert.Equal([_assignmentB], updated.AssignmentIds!);
    }

    [Fact]
    public async Task AReadFedStraightBackIntoAnUpdatePreservesTheBindings()
    {
        // The regression this whole change exists to prevent: read-modify-write. When the read said
        // null, echoing it into a PUT silently deleted every entry step and every assignment and
        // returned 200.
        var read = await _service.GetByIdAsync(_bound, TestContext.Current.CancellationToken);

        await _service.UpdateAsync(
            _bound,
            new WorkflowUpdateDto(read.Name, read.Version, read.Description,
                                  read.EntryStepIds!, read.AssignmentIds, read.CronExpression),
            TestContext.Current.CancellationToken);

        var after = await _service.GetByIdAsync(_bound, TestContext.Current.CancellationToken);
        Assert.Equal(2, after.EntryStepIds!.Count);
        Assert.Equal(2, after.AssignmentIds!.Count);
    }
}

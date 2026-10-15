using BaseApi.Core.Exceptions;
using BaseApi.Service.Features.Molecule;
using BaseApi.Service.Features.Workflow;
using BaseApi.Tests.WorkflowGraph;
using Xunit;

namespace BaseApi.Tests.Molecule;

/// <summary>
/// The molecule over InMemory rows. InMemory has no relational model (and names tables after the classes), so the
/// schema's description comes from a context configured for Npgsql, as <see cref="ModelRelationsTests"/> builds it;
/// the rows come from the harness. <see cref="ModelRelationsTests"/> pins the rules themselves, which were checked
/// against the live catalog (<c>pg_constraint</c>) when the endpoint was written.
/// </summary>
public sealed class MoleculeReaderTests
{
    private sealed class NpgsqlModelRelations : IModelRelationsSource
    {
        public ModelRelationsSnapshot Get()
        {
            using var db = ModelRelationsTests.NpgsqlModelContext();
            return ModelRelations.Describe(db.Model);
        }
    }

    private static MoleculeReader Reader(GraphHarness h) => new(h.Db, h.Loader, new NpgsqlModelRelations());

    private static async Task<Guid> LinkCacheAsync(GraphHarness h, Guid workflow, Guid cache)
    {
        h.Db.Add(new WorkflowCaches { WorkflowId = workflow, CacheId = cache });
        await h.Db.SaveChangesAsync(h.Ct);
        return cache;
    }

    [Fact]
    public async Task ReturnsTheWorkflowsRowsAndABondForEveryKeyBetweenThem()
    {
        await using var h = new GraphHarness();
        var input = await h.SchemaAsync("in");
        var config = await h.SchemaAsync("cfg");
        var proc = await h.ProcessorAsync("p", input: input, config: config);
        var tail = await h.StepAsync(proc, "tail");
        var head = await h.StepAsync(proc, "head", tail);
        var asg = await h.AssignmentAsync(head);
        var wf = await h.WorkflowAsync("wf", [head], [asg]);
        var cache = await LinkCacheAsync(h, wf, await h.CacheAsync("root"));

        var molecule = await Reader(h).ReadAsync(wf, h.Ct);

        Assert.Equal(wf, molecule.WorkflowId);
        Assert.Equal(
            new[] { ("assignments", asg), ("caches", cache), ("processors", proc), ("schemas", config), ("schemas", input), ("steps", head), ("steps", tail), ("workflows", wf) }
                .OrderBy(x => x.Item1, StringComparer.Ordinal).ThenBy(x => x.Item2),
            molecule.Atoms.Select(a => (a.Table, a.Id)).OrderBy(x => x.Item1, StringComparer.Ordinal).ThenBy(x => x.Item2));

        Assert.Equal(
            new[]
            {
                ("fk_assignment_step_id", asg, head),
                ("fk_processor_config_schema_id", proc, config),
                ("fk_processor_input_schema_id", proc, input),
                ("fk_step_processor_id", head, proc),
                ("fk_step_processor_id", tail, proc),
                ("step_next_steps", head, tail),
                ("workflow_assignments", wf, asg),
                ("workflow_caches", wf, cache),
                ("workflow_entry_steps", wf, head),
            }.OrderBy(x => x.Item1, StringComparer.Ordinal).ThenBy(x => x.Item2).ThenBy(x => x.Item3),
            molecule.Bonds.Select(b => (b.Constraint ?? b.Link!, b.From, b.To))
                .OrderBy(x => x.Item1, StringComparer.Ordinal).ThenBy(x => x.Item2).ThenBy(x => x.Item3));
    }

    [Fact]
    public async Task ALinkBondCarriesBothOfItsTablesConstraintsInFromToOrder()
    {
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var tail = await h.StepAsync(proc, "tail");
        var head = await h.StepAsync(proc, "head", tail);
        var wf = await h.WorkflowAsync("wf", [head]);

        var next = (await Reader(h).ReadAsync(wf, h.Ct)).Bonds.Single(b => b.Link == "step_next_steps");

        Assert.Null(next.Constraint);
        Assert.Equal(["fk_step_next_steps_step_id", "fk_step_next_steps_next_step_id"], next.Constraints);
    }

    [Fact]
    public async Task RowsOutsideTheWorkflowAndTheirBondsAreLeftOut()
    {
        // A step no entry reaches is not the workflow's. A shared cache is, but the other workflow using it is not:
        // its workflow_caches row stays out with it, so a molecule never spreads into another workflow.
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var head = await h.StepAsync(proc, "head");
        var parked = await h.StepAsync(proc, "parked");
        var wf = await h.WorkflowAsync("wf", [head]);
        var other = await h.WorkflowAsync("other", [await h.StepAsync(proc, "elsewhere")]);
        var cache = await h.CacheAsync("shared");
        await LinkCacheAsync(h, wf, cache);
        await LinkCacheAsync(h, other, cache);

        var molecule = await Reader(h).ReadAsync(wf, h.Ct);

        Assert.DoesNotContain(molecule.Atoms, a => a.Id == parked || a.Id == other);
        Assert.Single(molecule.Atoms, a => a.Table == "steps");
        Assert.DoesNotContain(molecule.Bonds, b => b.From == other || b.To == other || b.From == parked || b.To == parked);
        Assert.Single(molecule.Bonds, b => b.Link == "workflow_caches");
    }

    [Fact]
    public async Task EveryBondJoinsTwoAtomsEvenWhenARowPointsOutOfTheWorkflow()
    {
        // The workflow holds an assignment for a step no entry step reaches: the assignment is the workflow's, its
        // step is not, so the assignment's step_id names a row outside the molecule and draws no bond.
        await using var h = new GraphHarness();
        var proc = await h.ProcessorAsync();
        var head = await h.StepAsync(proc, "head");
        var parked = await h.StepAsync(proc, "parked");
        var stray = await h.AssignmentAsync(parked);
        var wf = await h.WorkflowAsync("wf", [head], [stray]);

        var molecule = await Reader(h).ReadAsync(wf, h.Ct);

        var ids = molecule.Atoms.Select(a => a.Id).ToHashSet();
        Assert.DoesNotContain(parked, ids);
        Assert.All(molecule.Bonds, b => Assert.True(ids.Contains(b.From) && ids.Contains(b.To), $"{b.Constraint ?? b.Link} {b.From} -> {b.To}"));
    }

    [Fact]
    public async Task AnAtomCarriesItsNameAndOwnColumnsButNotItsKeysOrLongValues()
    {
        await using var h = new GraphHarness();
        var longDefinition = $$"""{"type":"object","description":"{{new string('x', MoleculeReader.MaxValueLength)}}"}""";
        var schema = await h.SchemaAsync("big", definition: longDefinition);
        var proc = await h.ProcessorAsync("p", input: schema);
        var step = await h.StepAsync(proc, "only");
        var wf = await h.WorkflowAsync("wf", [step]);

        var atoms = (await Reader(h).ReadAsync(wf, h.Ct)).Atoms;

        var s = atoms.Single(a => a.Table == "steps");
        Assert.Equal("only", s.Label);
        Assert.Equal("PreviousCompleted", s.Columns["entry_condition"]); // an enum by its name
        Assert.Equal("1.0.0", s.Columns["version"]);
        Assert.False(s.Columns.ContainsKey("id"));
        Assert.False(s.Columns.ContainsKey("processor_id")); // a key column is a bond, not a column

        var big = atoms.Single(a => a.Table == "schemas");
        Assert.Equal(["definition"], big.Omitted);
        Assert.False(big.Columns.ContainsKey("definition"));
    }

    [Fact]
    public async Task AMissingWorkflowIsNotFound()
    {
        await using var h = new GraphHarness();
        await Assert.ThrowsAsync<NotFoundException>(() => Reader(h).ReadAsync(Guid.NewGuid(), h.Ct));
    }
}

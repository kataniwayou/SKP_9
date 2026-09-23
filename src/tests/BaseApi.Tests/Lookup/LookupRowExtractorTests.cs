using BaseApi.Service.Features.Lookup;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Lookup;

/// <summary>
/// What gets published at a start. The table must cover every id the workflow can go on to emit —
/// that is the whole invariant the design rests on — so a kind missing from this extraction is an
/// entity whose logs are unnameable for the life of the run, with nothing failing to say so.
/// </summary>
public sealed class LookupRowExtractorTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("44444444-4444-4444-4444-444444444444");

    private static WorkflowGraphSnapshot Snapshot()
    {
        var now = DateTime.UtcNow;
        var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
        snapshot.Workflows[W] = new WorkflowReadDto(
            W, "simple-abc", "1.0.0", null, [S], null, null, null, now, now, null, null);
        snapshot.Steps[S] = new StepReadDto(
            S, "simple-stepA", "2.1.0", null, P, null, default, now, now, null, null);
        snapshot.Processors[P] = new ProcessorReadDto(
            P, "sample-proc-v9", "1.5.0", null, "hash", null, null, null, null, now, now, null, null);
        return snapshot;
    }

    [Fact]
    public void Extracts_one_row_per_entity_across_all_three_kinds()
    {
        using var snapshot = Snapshot();

        var rows = LookupRowExtractor.From(snapshot);

        Assert.Equal(3, rows.Count);
        Assert.Contains(rows, r => r.Id == W && r.Name == "simple-abc"     && r.Version == "1.0.0" && r.Kind == "workflow");
        Assert.Contains(rows, r => r.Id == S && r.Name == "simple-stepA"   && r.Version == "2.1.0" && r.Kind == "step");
        Assert.Contains(rows, r => r.Id == P && r.Name == "sample-proc-v9" && r.Version == "1.5.0" && r.Kind == "processor");
    }
}

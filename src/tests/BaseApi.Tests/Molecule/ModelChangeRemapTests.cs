using System.Text.Json;
using BaseApi.Service;
using BaseApi.Service.Features.Molecule;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Molecule;

/// <summary>
/// One apply that creates a step under a client id and updates a workflow naming that id in both entryStepIds and as an
/// entryCrons key. The runner's text-replace remap must reach the dictionary key, or the cron is lost or refused.
/// (The runner itself needs a real transaction with savepoints, which the in-memory provider lacks; this drives the
/// remap the runner uses and then the same DTO through the validator and the junction write.)
/// </summary>
public sealed class ModelChangeRemapTests
{
    [Fact]
    public async Task AClientIdUsedAsAnEntryCronsKeyIsRemappedAndTheJunctionCarriesTheCron()
    {
        var ct = TestContext.Current.CancellationToken;
        var (client, given, other, wf) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var body = $$$"""
            {"name":"wf","version":"1.0.0","description":null,"entryStepIds":["{{{client:D}}}","{{{other:D}}}"],
             "assignmentIds":null,"cacheIds":null,"entryCrons":{"{{{client:D}}}":"*/10 * * * * *"}}
            """;
        using var doc = JsonDocument.Parse(body);

        var row = ModelChangeRunner.RemapClientIds(doc.RootElement, new Dictionary<Guid, Guid> { [client] = given });
        var dto = row.Deserialize<WorkflowUpdateDto>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

        Assert.Equal([given, other], dto.EntryStepIds);
        Assert.Equal("*/10 * * * * *", Assert.Single(dto.EntryCrons!, kv => kv.Key == given).Value);
        Assert.True(new WorkflowUpdateDtoValidator().Validate(dto).IsValid);

        await using var db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>().UseInMemoryDatabase($"remap-{Guid.NewGuid():N}").Options);
        await WorkflowJunctions.SyncAsync(db, wf, dto.EntryStepIds, dto.EntryCrons, assignmentIds: null, cacheIds: null, replaceExisting: true, ct);
        await db.SaveChangesAsync(ct);

        var rows = await db.WorkflowEntrySteps.Where(j => j.WorkflowId == wf).ToListAsync(ct);
        Assert.Equal("*/10 * * * * *", rows.Single(r => r.StepId == given).CronExpression);
        Assert.Null(rows.Single(r => r.StepId == other).CronExpression);
    }
}

using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Projection;

/// <summary>
/// The shared rule that turns a workflow cron plus per-entry-step overrides into groups of entry steps
/// that fire together.
/// </summary>
public sealed class EntryScheduleTests
{
    private static readonly Guid A = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid B = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    private static readonly Guid C = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");

    [Fact]
    public void AStepWithoutItsOwnCronUsesTheWorkflowCron()
    {
        Assert.Equal("*/30 * * * * *", EntrySchedule.EffectiveCron(A, "*/30 * * * * *", new Dictionary<Guid, string>()));
    }

    [Fact]
    public void AStepsOwnCronOverridesTheWorkflowCron()
    {
        var map = new Dictionary<Guid, string> { [B] = "*/10 * * * * *" };
        Assert.Equal("*/10 * * * * *", EntrySchedule.EffectiveCron(B, "*/30 * * * * *", map));
    }

    [Fact]
    public void NoCronAnywhereMeansUnscheduled()
    {
        Assert.Null(EntrySchedule.EffectiveCron(A, null, null));
        Assert.Empty(EntrySchedule.Groups([A, B], null, null));
    }

    [Fact]
    public void WhitespaceOnlyDifferencesShareAGroup()
    {
        var map = new Dictionary<Guid, string> { [B] = " */10  * * * * * " };
        var groups = EntrySchedule.Groups([A, B], "*/10 * * * * *", map);
        var g = Assert.Single(groups);
        Assert.Equal([A, B], g.StepIds);
    }

    [Fact]
    public void GroupsAreOrderedByFirstAppearanceWithStableIndexes()
    {
        var map = new Dictionary<Guid, string> { [B] = "*/10 * * * * *" };
        var groups = EntrySchedule.Groups([A, B, C], "*/30 * * * * *", map);
        Assert.Equal(2, groups.Count);
        Assert.Equal(0, groups[0].Index);
        Assert.Equal("*/30 * * * * *", groups[0].Cron);
        Assert.Equal([A, C], groups[0].StepIds);
        Assert.Equal(1, groups[1].Index);
        Assert.Equal("*/10 * * * * *", groups[1].Cron);
        Assert.Equal([B], groups[1].StepIds);
    }

    [Fact]
    public void AnOldProjectionWithoutEntryCronsDeserializesAsNull()
    {
        var back = JsonSerializer.Deserialize<WorkflowStoreProjection>(
            "{\"entryStepIds\":[],\"cron\":null,\"steps\":[]}", MessagingJson.Options)!;
        Assert.Null(back.EntryCrons);
    }
}

using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Projection;

/// <summary>
/// The shared rule that turns per-entry-step crons into groups of entry steps that fire together. A
/// workflow has no cron of its own: a step without an entry cron is unscheduled.
/// </summary>
public sealed class EntryScheduleTests
{
    private static readonly Guid A = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid B = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    private static readonly Guid C = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");

    [Fact]
    public void AStepsEntryCronIsItsSchedule()
    {
        var map = new Dictionary<Guid, string> { [B] = "*/10 * * * * *" };
        Assert.Equal("*/10 * * * * *", EntrySchedule.EffectiveCron(B, map));
    }

    [Fact]
    public void AStepWithoutAnEntryCronIsUnscheduled()
    {
        var map = new Dictionary<Guid, string> { [B] = "*/10 * * * * *" };
        Assert.Null(EntrySchedule.EffectiveCron(A, map));
        Assert.Null(EntrySchedule.EffectiveCron(A, new Dictionary<Guid, string> { [A] = "   " }));

        var g = Assert.Single(EntrySchedule.Groups([A, B], map));
        Assert.Equal([B], g.StepIds);
    }

    [Fact]
    public void NoEntryCronsMeansUnscheduled()
    {
        Assert.Null(EntrySchedule.EffectiveCron(A, null));
        Assert.Empty(EntrySchedule.Groups([A, B], null));
        Assert.Empty(EntrySchedule.Groups([A, B], new Dictionary<Guid, string>()));
    }

    [Fact]
    public void WhitespaceOnlyDifferencesShareAGroup()
    {
        var map = new Dictionary<Guid, string> { [A] = "*/10 * * * * *", [B] = " */10  * * * * * " };
        var groups = EntrySchedule.Groups([A, B], map);
        var g = Assert.Single(groups);
        Assert.Equal("*/10 * * * * *", g.Cron);
        Assert.Equal([A, B], g.StepIds);
    }

    [Fact]
    public void GroupsAreOrderedByFirstAppearanceWithStableIndexes()
    {
        var map = new Dictionary<Guid, string>
        {
            [A] = "*/30 * * * * *",
            [B] = "*/10 * * * * *",
            [C] = "*/30 * * * * *",
        };
        var groups = EntrySchedule.Groups([A, B, C], map);
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

using System.Text.Json;
using BaseApi.Service.Features.Board;
using Xunit;

namespace BaseApi.Tests.Board;

/// <summary>Pure tests of how missing board locations are derived from old workflow layouts.</summary>
public sealed class LocationFillTests
{
    private static readonly IReadOnlyDictionary<Guid, Guid[]> NoEntries = new Dictionary<Guid, Guid[]>();
    private static readonly IReadOnlySet<Guid> None = new HashSet<Guid>();

    private static string Layout(object? steps = null, object? caches = null, object? board = null)
    {
        var d = new Dictionary<string, object?> { ["steps"] = steps ?? new { }, ["caches"] = caches ?? new { } };
        if (board is not null) d["board"] = board;
        return JsonSerializer.Serialize(d);
    }

    private static Dictionary<string, object> At(Guid id, double x, double y) =>
        new() { [id.ToString()] = new { x, y } };

    [Fact]
    public void AStepTakesItsPositionFromTheNewestLayoutThatPlacesIt()
    {
        var s = Guid.NewGuid();
        var older = new LayoutSource(Guid.NewGuid(), new DateTime(2026, 1, 1), Layout(At(s, 10, 10), board: new { x = 0, y = -46, w = 1, h = 1 }));
        var newer = new LayoutSource(Guid.NewGuid(), new DateTime(2026, 6, 1), Layout(At(s, 99, 77), board: new { x = 0, y = -46, w = 1, h = 1 }));

        var plan = LocationFill.Compute([older, newer], new HashSet<Guid> { s }, None, None, NoEntries);

        Assert.Equal((99d, 77d), plan.Steps[s]);
    }

    [Fact]
    public void TheOldActoFrameOffsetIsAdded()
    {
        var s = Guid.NewGuid();
        var c = Guid.NewGuid();
        var w = new LayoutSource(Guid.NewGuid(), DateTime.UtcNow,
            Layout(At(s, 20, 30), At(c, 5, 6), new { x = 1000, y = 500, w = 900, h = 700 }));

        var plan = LocationFill.Compute([w], new HashSet<Guid> { s }, new HashSet<Guid> { c }, None, NoEntries);

        Assert.Equal((1020d, 576d), plan.Steps[s]);
        Assert.Equal((1005d, 552d), plan.Caches[c]);
    }

    [Fact]
    public void OnlyMissingLocationsAreFilled()
    {
        var placed = Guid.NewGuid();
        var missing = Guid.NewGuid();
        var steps = At(placed, 1, 1);
        steps[missing.ToString()] = new { x = 2, y = 2 };
        var w = new LayoutSource(Guid.NewGuid(), DateTime.UtcNow, Layout(steps));

        var plan = LocationFill.Compute([w], new HashSet<Guid> { missing }, None, None, NoEntries);

        Assert.DoesNotContain(placed, plan.Steps.Keys);
        Assert.Contains(missing, plan.Steps.Keys);
    }

    [Fact]
    public void ATriangleGoesLeftOfItsFirstEntryStep()
    {
        var entry = Guid.NewGuid();
        var wf = Guid.NewGuid();
        var w = new LayoutSource(wf, DateTime.UtcNow, Layout(At(entry, 400, 200), board: new { x = 0, y = -46, w = 1, h = 1 }));

        var plan = LocationFill.Compute([w], new HashSet<Guid> { entry }, None, new HashSet<Guid> { wf },
            new Dictionary<Guid, Guid[]> { [wf] = [entry] });

        Assert.Equal((240d, 200d), plan.Workflows[wf]);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{\"steps\":{\"a\":\"x\"}}")]
    [InlineData(null)]
    public void MalformedLayoutsAreIgnored(string? layout)
    {
        var s = Guid.NewGuid();
        var plan = LocationFill.Compute([new LayoutSource(Guid.NewGuid(), DateTime.UtcNow, layout)],
            new HashSet<Guid> { s }, None, None, NoEntries);

        Assert.Empty(plan.Steps);
        Assert.Empty(plan.Caches);
        Assert.Empty(plan.Workflows);
    }

    [Fact]
    public void WorkflowStudioLayoutsAreStackedBelowTheBoard()
    {
        // One Acto-placed layout (board offset) reaches y = 500 + 46 + 100 = 646.
        var placedStep = Guid.NewGuid();
        var acto = new LayoutSource(Guid.NewGuid(), new DateTime(2026, 5, 1),
            Layout(At(placedStep, 0, 100), board: new { x = 1000, y = 500, w = 1, h = 1 }), new DateTime(2026, 1, 1));

        // Two WorkflowStudio layouts (no board), both near the origin; a is created before b.
        var a1 = Guid.NewGuid(); var a2 = Guid.NewGuid();
        var b1 = Guid.NewGuid();
        var aSteps = At(a1, 0, 0); aSteps[a2.ToString()] = new { x = 300, y = 50 };
        var a = new LayoutSource(Guid.NewGuid(), new DateTime(2026, 5, 2), Layout(aSteps), new DateTime(2026, 2, 1));
        var b = new LayoutSource(Guid.NewGuid(), new DateTime(2026, 5, 3), Layout(At(b1, 10, 20)), new DateTime(2026, 3, 1));

        // b is listed first; stacking follows CreatedAt, not list order.
        var plan = LocationFill.Compute([b, a, acto], new HashSet<Guid> { a1, a2, b1, placedStep }, None, None, NoEntries);

        Assert.Equal((1000d, 646d), plan.Steps[placedStep]);
        // a: top (y=0) goes to 646 + 120 = 766; relative positions kept (a2 is 50 lower, 300 right).
        Assert.Equal((0d, 766d), plan.Steps[a1]);
        Assert.Equal((300d, 816d), plan.Steps[a2]);
        // b: group top y=20 goes to a's bottom (816) + 120 = 936.
        Assert.Equal((10d, 936d), plan.Steps[b1]);
    }

    [Fact]
    public void AStepAlreadyPlacedByANewerLayoutKeepsThatPositionWhenAnOlderOneIsStacked()
    {
        var s = Guid.NewGuid();
        var other = Guid.NewGuid();
        var newer = new LayoutSource(Guid.NewGuid(), new DateTime(2026, 6, 1),
            Layout(At(s, 5, 5), board: new { x = 100, y = 100, w = 1, h = 1 }), new DateTime(2026, 1, 1));
        var steps = At(s, 0, 0); steps[other.ToString()] = new { x = 0, y = 10 };
        var older = new LayoutSource(Guid.NewGuid(), new DateTime(2026, 1, 1), Layout(steps), new DateTime(2026, 2, 1));

        var plan = LocationFill.Compute([older, newer], new HashSet<Guid> { s, other }, None, None, NoEntries);

        Assert.Equal((105d, 151d), plan.Steps[s]);
        // The older group still moves as a whole: its top (y=0) sits 120 below 151, so other is at 281.
        Assert.Equal((0d, 281d), plan.Steps[other]);
    }
}

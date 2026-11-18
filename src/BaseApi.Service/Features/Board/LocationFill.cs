using System.Text.Json;

namespace BaseApi.Service.Features.Board;

/// <summary>One workflow's old canvas layout. <c>CreatedAt</c> orders the stacking of layouts that carry no board offset.</summary>
internal sealed record LayoutSource(Guid WorkflowId, DateTime UpdatedAt, string? Layout, DateTime CreatedAt = default);

/// <summary>The locations to write, keyed by row id. Only rows that had no location are present.</summary>
internal sealed record LocationPlan(
    IReadOnlyDictionary<Guid, (double X, double Y)> Steps,
    IReadOnlyDictionary<Guid, (double X, double Y)> Caches,
    IReadOnlyDictionary<Guid, (double X, double Y)> Workflows);

/// <summary>
/// Works out board locations for rows that have none from the workflows' old layouts.
/// <para>
/// A layout is <c>{ steps: {id:{x,y}}, caches: {id:{x,y}}, board: {x,y,w,h}? }</c>. When <c>board</c> exists
/// (Acto wrote it) a point is at <c>(board.x + x, board.y + HeaderHeight + y)</c>. When it does not
/// (WorkflowStudio wrote it) the points are in that canvas's own coordinates, all near the origin, so each
/// such layout is moved as a whole to sit below everything placed by an Acto layout and below the layouts
/// stacked before it, <see cref="StackGap"/> apart, in workflow creation order. The newest layout that
/// places a row wins. A workflow with no location goes <see cref="TriangleOffset"/> left of its first entry step.
/// </para>
/// </summary>
internal static class LocationFill
{
    /// <summary>Acto's old frame header height (<c>HEADER_H</c> in src/Acto/src/board/geometry.ts).</summary>
    public const double HeaderHeight = 46;
    public const double StackGap = 120;
    public const double TriangleOffset = 160;

    private sealed class Parsed
    {
        public required LayoutSource Source;
        public bool HasBoard;
        public Dictionary<Guid, (double X, double Y)> Steps = new();
        public Dictionary<Guid, (double X, double Y)> Caches = new();
        public double Dy;   // vertical shift applied to a layout without a board when stacking
    }

    public static LocationPlan Compute(
        IReadOnlyList<LayoutSource> workflows,
        IReadOnlySet<Guid> stepsWithoutLocation,
        IReadOnlySet<Guid> cachesWithoutLocation,
        IReadOnlySet<Guid> workflowsWithoutLocation,
        IReadOnlyDictionary<Guid, Guid[]> entryStepsOf)
    {
        var parsed = new List<Parsed>();
        foreach (var w in workflows)
        {
            var p = Parse(w);
            if (p is not null) parsed.Add(p);
        }

        // Layouts without a board offset are stacked below the board, oldest workflow first.
        double? cursor = null;
        foreach (var p in parsed.Where(p => p.HasBoard))
            foreach (var y in Ys(p)) cursor = cursor is null ? y : Math.Max(cursor.Value, y);

        foreach (var p in parsed.Where(p => !p.HasBoard && Ys(p).Any())
                                .OrderBy(p => p.Source.CreatedAt).ThenBy(p => p.Source.WorkflowId))
        {
            var top = Ys(p).Min();
            var bottom = Ys(p).Max();
            p.Dy = cursor is null ? 0 : cursor.Value + StackGap - top;
            cursor = bottom + p.Dy;
        }

        var steps = new Dictionary<Guid, (double, double)>();
        var caches = new Dictionary<Guid, (double, double)>();
        var allSteps = new Dictionary<Guid, (double X, double Y)>();   // every step any layout places, newest wins
        foreach (var p in parsed.OrderByDescending(p => p.Source.UpdatedAt))
        {
            foreach (var (id, pt) in p.Steps)
            {
                var at = (pt.X, pt.Y + p.Dy);
                allSteps.TryAdd(id, at);
                if (stepsWithoutLocation.Contains(id)) steps.TryAdd(id, at);
            }
            foreach (var (id, pt) in p.Caches)
                if (cachesWithoutLocation.Contains(id)) caches.TryAdd(id, (pt.X, pt.Y + p.Dy));
        }

        var wfs = new Dictionary<Guid, (double, double)>();
        foreach (var wf in workflowsWithoutLocation)
        {
            if (!entryStepsOf.TryGetValue(wf, out var entries)) continue;
            foreach (var e in entries)
            {
                if (!allSteps.TryGetValue(e, out var at)) continue;
                wfs[wf] = (at.X - TriangleOffset, at.Y);
                break;
            }
        }

        return new LocationPlan(steps, caches, wfs);
    }

    private static IEnumerable<double> Ys(Parsed p) =>
        p.Steps.Values.Select(v => v.Y + p.Dy).Concat(p.Caches.Values.Select(v => v.Y + p.Dy));

    private static Parsed? Parse(LayoutSource w)
    {
        if (string.IsNullOrWhiteSpace(w.Layout)) return null;
        try
        {
            using var doc = JsonDocument.Parse(w.Layout);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            var root = doc.RootElement;

            var p = new Parsed { Source = w };
            double bx = 0, by = 0;
            if (root.TryGetProperty("board", out var board) && board.ValueKind == JsonValueKind.Object
                && Point(board, out var b))
            {
                p.HasBoard = true;
                bx = b.X;
                by = b.Y + HeaderHeight;
            }
            Read(root, "steps", p.Steps);
            Read(root, "caches", p.Caches);
            // A board layout's offset is applied once, here. The shift for a layout without one is set when stacking.
            if (p.HasBoard) { Shift(p.Steps, bx, by); Shift(p.Caches, bx, by); }
            return p;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static void Shift(Dictionary<Guid, (double X, double Y)> d, double dx, double dy)
    {
        foreach (var k in d.Keys.ToList()) d[k] = (d[k].X + dx, d[k].Y + dy);
    }

    private static void Read(JsonElement root, string name, Dictionary<Guid, (double X, double Y)> into)
    {
        if (!root.TryGetProperty(name, out var obj) || obj.ValueKind != JsonValueKind.Object) return;
        foreach (var prop in obj.EnumerateObject())
            if (Guid.TryParse(prop.Name, out var id) && prop.Value.ValueKind == JsonValueKind.Object
                && Point(prop.Value, out var pt))
                into[id] = pt;
    }

    private static bool Point(JsonElement e, out (double X, double Y) pt)
    {
        pt = default;
        if (e.TryGetProperty("x", out var x) && x.ValueKind == JsonValueKind.Number && x.TryGetDouble(out var dx)
            && e.TryGetProperty("y", out var y) && y.ValueKind == JsonValueKind.Number && y.TryGetDouble(out var dy)
            && double.IsFinite(dx) && double.IsFinite(dy))
        {
            pt = (dx, dy);
            return true;
        }
        return false;
    }
}

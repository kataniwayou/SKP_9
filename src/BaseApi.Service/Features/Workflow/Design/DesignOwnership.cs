using System.Text.Json;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Step;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// The steps and caches a workflow holds before a design save (review 2026-10-10): a design deletes only these. Steps
/// belong to no workflow (spec §2), so a workflow's steps are those its entry steps reach, those its stored layout
/// places (its parked steps), and those its stored design already deletes (a delete refused once is still its own on
/// the next save); its caches are its cache list and those its stored design already deletes.
/// </summary>
internal static class DesignOwnership
{
    public static async Task<(HashSet<Guid> Steps, HashSet<Guid> Caches)> ReadAsync(BaseDbContext db, Guid workflowId, CancellationToken ct)
    {
        var steps = new HashSet<Guid>();
        var caches = new HashSet<Guid>();
        var row = await db.Set<WorkflowEntity>().AsNoTracking().Where(w => w.Id == workflowId)
            .Select(w => new { w.Layout, w.Design }).FirstOrDefaultAsync(ct);
        if (row is null) return (steps, caches);

        // what the entry steps reach, over the next-step links as they are now
        var frontier = await db.Set<WorkflowEntrySteps>().AsNoTracking().Where(j => j.WorkflowId == workflowId).Select(j => j.StepId).ToListAsync(ct);
        while (frontier.Count > 0)
        {
            var fresh = frontier.Where(steps.Add).ToList();
            frontier = fresh.Count == 0 ? [] : await db.Set<StepNextSteps>().AsNoTracking()
                .Where(j => fresh.Contains(j.StepId)).Select(j => j.NextStepId).ToListAsync(ct);
        }
        foreach (var id in LayoutSteps(row.Layout)) steps.Add(id);
        caches.UnionWith(await db.Set<WorkflowCaches>().AsNoTracking().Where(j => j.WorkflowId == workflowId).Select(j => j.CacheId).ToListAsync(ct));
        steps.UnionWith(StoredDeletes(row.Design, "deletedSteps"));
        caches.UnionWith(StoredDeletes(row.Design, "deletedCaches"));
        return (steps, caches);
    }

    /// <summary>The step ids a stored layout places: its <c>parked</c> list and the keys of its <c>steps</c>.</summary>
    internal static IEnumerable<Guid> LayoutSteps(string? layout)
    {
        if (Parse(layout) is not { } root) yield break;
        if (root.TryGetProperty("parked", out var parked) && parked.ValueKind == JsonValueKind.Array)
            foreach (var p in parked.EnumerateArray())
                if (p.ValueKind == JsonValueKind.String && Guid.TryParse(p.GetString(), out var id)) yield return id;
        if (root.TryGetProperty("steps", out var placed) && placed.ValueKind == JsonValueKind.Object)
            foreach (var p in placed.EnumerateObject())
                if (Guid.TryParse(p.Name, out var id)) yield return id;
    }

    /// <summary>The ids a stored design's <c>deletedSteps</c> or <c>deletedCaches</c> lists.</summary>
    private static IEnumerable<Guid> StoredDeletes(string? design, string list)
    {
        if (Parse(design) is not { } root || !root.TryGetProperty(list, out var items) || items.ValueKind != JsonValueKind.Array) yield break;
        foreach (var item in items.EnumerateArray())
            if (item.ValueKind == JsonValueKind.Object && item.TryGetProperty("id", out var v) && v.ValueKind == JsonValueKind.String && Guid.TryParse(v.GetString(), out var id))
                yield return id;
    }

    private static JsonElement? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            var root = JsonDocument.Parse(json).RootElement.Clone();
            return root.ValueKind == JsonValueKind.Object ? root : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

using BaseApi.Core.Health;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting;

namespace BaseApi.Service.Features.Board;

/// <summary>
/// Once the schema is migrated, gives every step, cache and workflow that has no board location one taken from
/// the workflows' old layouts (see <see cref="LocationFill"/>). It writes only the two location columns with
/// set-based updates, never touching <c>UpdatedAt</c>, so a fill cannot make Acto's next save look stale. It runs
/// once per start, logs how many rows it filled, and never lets a failure out: the board falls back to Acto's own
/// default placement for what stays empty.
/// </summary>
internal sealed class LocationFillService(
    IServiceScopeFactory scopes,
    IMigrationState migrations,
    ILogger<LocationFillService> logger) : BackgroundService
{
    private static readonly TimeSpan Poll = TimeSpan.FromSeconds(1);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try
        {
            // The migration runner is itself a hosted service that retries; wait for its flag.
            while (!migrations.Applied)
                await Task.Delay(Poll, ct).ConfigureAwait(false);

            await FillAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Board location fill failed; rows without a location keep none.");
        }
    }

    internal async Task FillAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var steps = await db.Steps.AsNoTracking().Where(s => s.BoardX == null || s.BoardY == null)
            .Select(s => s.Id).ToListAsync(ct).ConfigureAwait(false);
        var caches = await db.Caches.AsNoTracking().Where(c => c.BoardX == null || c.BoardY == null)
            .Select(c => c.Id).ToListAsync(ct).ConfigureAwait(false);
        var wfs = await db.Workflows.AsNoTracking().Where(w => w.BoardX == null || w.BoardY == null)
            .Select(w => w.Id).ToListAsync(ct).ConfigureAwait(false);
        if (steps.Count + caches.Count + wfs.Count == 0) return;

        var layouts = (await db.Workflows.AsNoTracking().Where(w => w.Layout != null)
                .Select(w => new { w.Id, w.UpdatedAt, w.CreatedAt, w.Layout }).ToListAsync(ct).ConfigureAwait(false))
            .Select(w => new LayoutSource(w.Id, w.UpdatedAt, w.Layout, w.CreatedAt)).ToList();
        var entries = (await db.WorkflowEntrySteps.AsNoTracking().ToListAsync(ct).ConfigureAwait(false))
            .GroupBy(e => e.WorkflowId).ToDictionary(g => g.Key, g => g.Select(e => e.StepId).ToArray());

        var plan = LocationFill.Compute(layouts, steps.ToHashSet(), caches.ToHashSet(), wfs.ToHashSet(), entries);

        // ExecuteUpdate: only the two columns, so UpdatedAt and the concurrency token are left alone. A column that
        // already holds a value keeps it (X and Y are independent).
        var filled = 0;
        foreach (var (id, (x, y)) in plan.Steps)
            filled += await db.Steps.Where(s => s.Id == id)
                .ExecuteUpdateAsync(u => u.SetProperty(s => s.BoardX, s => s.BoardX ?? x)
                                          .SetProperty(s => s.BoardY, s => s.BoardY ?? y), ct).ConfigureAwait(false);
        foreach (var (id, (x, y)) in plan.Caches)
            filled += await db.Caches.Where(c => c.Id == id)
                .ExecuteUpdateAsync(u => u.SetProperty(c => c.BoardX, c => c.BoardX ?? x)
                                          .SetProperty(c => c.BoardY, c => c.BoardY ?? y), ct).ConfigureAwait(false);
        foreach (var (id, (x, y)) in plan.Workflows)
            filled += await db.Workflows.Where(w => w.Id == id)
                .ExecuteUpdateAsync(u => u.SetProperty(w => w.BoardX, w => w.BoardX ?? x)
                                          .SetProperty(w => w.BoardY, w => w.BoardY ?? y), ct).ConfigureAwait(false);

        logger.LogInformation(
            "Board location fill: {Steps} steps, {Caches} caches, {Workflows} workflows placed from old layouts ({Rows} rows updated); {Left} rows still without one.",
            plan.Steps.Count, plan.Caches.Count, plan.Workflows.Count, filled,
            steps.Count + caches.Count + wfs.Count - plan.Steps.Count - plan.Caches.Count - plan.Workflows.Count);
    }
}

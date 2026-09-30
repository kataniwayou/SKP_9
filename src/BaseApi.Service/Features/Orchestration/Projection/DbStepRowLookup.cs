using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// <see cref="IStepRowLookup"/> over the application database: one query, ids only, no tracking.
/// </summary>
internal sealed class DbStepRowLookup : IStepRowLookup
{
    private readonly AppDbContext _db;

    public DbStepRowLookup(AppDbContext db) => _db = db ?? throw new ArgumentNullException(nameof(db));

    public async Task<IReadOnlySet<Guid>> ExistingAsync(IReadOnlyCollection<Guid> stepIds, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(stepIds);

        if (stepIds.Count == 0)
        {
            return new HashSet<Guid>();
        }

        var found = await _db.Steps.AsNoTracking()
            .Where(s => stepIds.Contains(s.Id))
            .Select(s => s.Id)
            .ToListAsync(ct)
            .ConfigureAwait(false);

        return found.ToHashSet();
    }
}

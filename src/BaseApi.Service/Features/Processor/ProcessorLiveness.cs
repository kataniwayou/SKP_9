using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Orchestration.Validation;
using Microsoft.EntityFrameworkCore;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Processor;

/// <summary>
/// One processor's liveness as the start gate judges it: live when any replica is present, healthy and
/// fresh. The counts classify every replica, so the studio can say why a processor is not live.
/// </summary>
public sealed record ProcessorLivenessDto(
    Guid ProcessorId, bool Live, int Replicas, int Healthy, int Absent, int Unhealthy, int Stale, int Malformed);

/// <summary>Every processor's liveness, read through BaseApi so the studio never reads Redis itself.</summary>
public interface IProcessorLivenessReader
{
    Task<IReadOnlyList<ProcessorLivenessDto>> ReadAllAsync(CancellationToken ct);
}

/// <summary>
/// Probes every processor row, in name order. Two Redis round trips per processor (see
/// <see cref="ProcessorLivenessProbe"/>); a workflow editor's processor count keeps that small.
/// </summary>
internal sealed class ProcessorLivenessReader : IProcessorLivenessReader
{
    private readonly BaseDbContext _db;
    private readonly ProcessorLivenessProbe _probe;

    public ProcessorLivenessReader(BaseDbContext db, ProcessorLivenessProbe probe)
    {
        _db = db ?? throw new ArgumentNullException(nameof(db));
        _probe = probe ?? throw new ArgumentNullException(nameof(probe));
    }

    public async Task<IReadOnlyList<ProcessorLivenessDto>> ReadAllAsync(CancellationToken ct)
    {
        var ids = await _db.Set<ProcessorEntity>().AsNoTracking()
            .OrderBy(p => p.Name).ThenBy(p => p.Id)
            .Select(p => p.Id)
            .ToListAsync(ct);

        var result = new List<ProcessorLivenessDto>(ids.Count);
        try
        {
            foreach (var id in ids)
            {
                var l = await _probe.ProbeAsync(id, ct);
                result.Add(new ProcessorLivenessDto(id, l.Live, l.Replicas, l.Healthy, l.Absent, l.Unhealthy, l.Stale, l.Malformed));
            }
        }
        catch (RedisException ex)
        {
            // Tagged so the 500 body names a stable operation; never answered as "not live".
            ex.Data["redisOp"] = "ProcessorLivenessRead";
            throw;
        }
        return result;
    }
}

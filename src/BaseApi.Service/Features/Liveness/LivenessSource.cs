using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Processor;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Liveness;

/// <summary>Reads what the hub reports: the running workflows and every processor's liveness.</summary>
public interface ILivenessSource
{
    /// <summary>One full reading. A Redis or database fault propagates; the monitor logs it and reads again next tick.</summary>
    Task<LivenessReading> ReadAsync(CancellationToken ct);
}

/// <summary>
/// The <c>skp:live</c> set (as <c>GET /orchestration/live</c> reads it) and every processor row probed by
/// <see cref="ProcessorLivenessProbe"/>, the start gate's own judge (as <c>GET /processors/liveness</c> reads it). The
/// probes run a bounded number at a time; each is two round trips however many replicas the processor has.
/// </summary>
internal sealed class RedisLivenessSource : ILivenessSource
{
    private readonly IServiceScopeFactory _scopes;
    private readonly L2LiveSet _live;
    private readonly ProcessorLivenessProbe _probe;
    private readonly int _parallelism;

    public RedisLivenessSource(IServiceScopeFactory scopes, IConnectionMultiplexer multiplexer, TimeProvider clock, IOptions<LivenessMonitorOptions> options)
    {
        _scopes = scopes ?? throw new ArgumentNullException(nameof(scopes));
        ArgumentNullException.ThrowIfNull(multiplexer);
        ArgumentNullException.ThrowIfNull(clock);
        _live = new L2LiveSet(multiplexer);
        _probe = new ProcessorLivenessProbe(multiplexer, clock);
        _parallelism = Math.Max(1, options?.Value.ProbeParallelism ?? 16);
    }

    public async Task<LivenessReading> ReadAsync(CancellationToken ct)
    {
        List<Guid> ids;
        // the context is scoped: one short scope per reading, never held across ticks
        await using (var scope = _scopes.CreateAsyncScope())
        {
            ids = await scope.ServiceProvider.GetRequiredService<BaseDbContext>().Set<ProcessorEntity>().AsNoTracking()
                .Select(p => p.Id)
                .ToListAsync(ct);
        }

        var running = (await _live.ListAsync(ct)).ToHashSet();

        var results = new ProcessorLivenessStateDto[ids.Count];
        await Parallel.ForEachAsync(
            Enumerable.Range(0, ids.Count),
            new ParallelOptions { MaxDegreeOfParallelism = _parallelism, CancellationToken = ct },
            async (i, token) =>
            {
                var l = await _probe.ProbeAsync(ids[i], token);
                results[i] = new ProcessorLivenessStateDto(l.ProcessorId, l.Live, l.Healthy, l.Replicas, l.Live ? null : l.Reason);
            });

        return new LivenessReading(running, results.ToDictionary(p => p.ProcessorId));
    }
}

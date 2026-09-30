using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// The set of running workflow ids. A start adds after its writes; a stop removes before it announces;
/// every orchestrator hydrates from it and guards start and stop announcements on it. Both operations
/// are idempotent, which is what lets a control message be redelivered freely.
/// </summary>
internal sealed class L2LiveSet
{
    private readonly IConnectionMultiplexer _multiplexer;

    public L2LiveSet(IConnectionMultiplexer multiplexer)
        => _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));

    public Task AddAsync(Guid workflowId) =>
        _multiplexer.GetDatabase().SetAddAsync(L2ProjectionKeys.Live(), workflowId.ToString("D"));

    public Task RemoveAsync(Guid workflowId) =>
        _multiplexer.GetDatabase().SetRemoveAsync(L2ProjectionKeys.Live(), workflowId.ToString("D"));
}

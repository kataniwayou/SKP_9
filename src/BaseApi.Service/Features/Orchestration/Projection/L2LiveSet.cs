using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseApi.Service.Features.Orchestration.Projection;

/// <summary>
/// The set of running workflow ids. A start adds after its writes; a stop removes before it announces;
/// every orchestrator hydrates from it and guards start and stop announcements on it. Both operations
/// are idempotent, which is what lets a control message be redelivered freely.
/// It also answers the read side for the studio's status (<see cref="ILiveWorkflowReader"/>).
/// </summary>
internal sealed class L2LiveSet : ILiveWorkflowReader
{
    private readonly IConnectionMultiplexer _multiplexer;

    public L2LiveSet(IConnectionMultiplexer multiplexer)
        => _multiplexer = multiplexer ?? throw new ArgumentNullException(nameof(multiplexer));

    public Task AddAsync(Guid workflowId) =>
        _multiplexer.GetDatabase().SetAddAsync(L2ProjectionKeys.Live(), workflowId.ToString("D"));

    public Task RemoveAsync(Guid workflowId) =>
        _multiplexer.GetDatabase().SetRemoveAsync(L2ProjectionKeys.Live(), workflowId.ToString("D"));

    public async Task<IReadOnlyList<Guid>> ListAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        RedisValue[] members;
        try
        {
            members = await _multiplexer.GetDatabase().SetMembersAsync(L2ProjectionKeys.Live());
        }
        catch (RedisException ex)
        {
            // Tagged so the 500 body names a stable operation rather than a transport message.
            ex.Data["redisOp"] = "ListLiveWorkflows";
            throw;
        }

        var ids = new List<Guid>(members.Length);
        foreach (var member in members)
        {
            // A member that is not a workflow id is skipped, not reported: it is whatever happens to be
            // in the store, and one unusable entry must not hide the rest.
            if (Guid.TryParseExact(member.ToString(), "D", out var id))
            {
                ids.Add(id);
            }
        }

        ids.Sort();
        return ids;
    }
}

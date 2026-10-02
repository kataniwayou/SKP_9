using Messaging.Contracts.Projections;
using StackExchange.Redis;

namespace BaseConsole.Core.Naming;

/// <summary>Reads <c>skp:wf:{w}:step:{s}</c>'s role field, the value BaseApi wrote at the workflow's last start.</summary>
public sealed class RedisStepRoleSource(IConnectionMultiplexer redis) : IStepRoleSource
{
    public async Task<string?> ReadRoleAsync(Guid workflowId, Guid stepId)
    {
        var value = await redis.GetDatabase()
            .HashGetAsync(L2ProjectionKeys.StepRole(workflowId, stepId), L2ProjectionKeys.RoleField)
            .ConfigureAwait(false);
        return value.IsNullOrEmpty ? null : value.ToString();
    }
}

using BaseProcessor.Core.Configuration;
using BaseProcessor.Core.Identity;
using BaseProcessor.Core.Liveness;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace BaseProcessor.Core.Shared;

/// <summary>
/// The L2 side of <see cref="IProcessorSharedState"/>. The refresh lives in
/// <see cref="ProcessorLivenessWriter"/>, beside the other keys the heartbeat keeps alive.
/// </summary>
public sealed class RedisProcessorSharedState : IProcessorSharedState
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IProcessorContext _context;
    private readonly ProcessorLivenessOptions _options;
    private readonly ILogger<RedisProcessorSharedState> _logger;

    public RedisProcessorSharedState(
        IConnectionMultiplexer redis,
        IProcessorContext context,
        IOptions<ProcessorLivenessOptions> options,
        ILogger<RedisProcessorSharedState> logger)
    {
        _redis   = redis ?? throw new ArgumentNullException(nameof(redis));
        _context = context ?? throw new ArgumentNullException(nameof(context));
        _options = options?.Value ?? throw new ArgumentNullException(nameof(options));
        _logger  = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public async Task<string?> GetAsync(string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);

        if (_context.Identity is not { } identity)
        {
            return null;
        }

        try
        {
            var value = await _redis.GetDatabase()
                .StringGetAsync(L2ProjectionKeys.ProcessorSharedEntry(identity.Id, name))
                .ConfigureAwait(false);

            return value.IsNull ? null : value.ToString();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "shared entry {Name} could not be read for {ProcessorId}; treating it as absent",
                name, identity.Id);
            return null;
        }
    }

    public async Task<bool> SetAsync(string name, string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(value);

        if (_context.Identity is not { } identity)
        {
            _logger.LogWarning("shared entry {Name} was not published: this replica has no identity yet", name);
            return false;
        }

        try
        {
            var db = _redis.GetDatabase();
            var ttl = TimeSpan.FromSeconds(ProcessorLivenessWriter.DeriveTtlSeconds(_options.IntervalSeconds));
            var index = L2ProjectionKeys.ProcessorShared(identity.Id);

            // The entry before its index line, so a name the heartbeat finds in the index always has a
            // value behind it. The reverse order would let a beat between the two calls find the name,
            // miss the value, and prune a line about to become valid.
            await db.StringSetAsync(
                L2ProjectionKeys.ProcessorSharedEntry(identity.Id, name),
                value,
                ttl,
                When.Always,
                CommandFlags.None).ConfigureAwait(false);

            await db.SetAddAsync(index, name).ConfigureAwait(false);
            await db.KeyExpireAsync(index, ttl, ExpireWhen.Always, CommandFlags.None).ConfigureAwait(false);

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "shared entry {Name} could not be published for {ProcessorId}",
                name, identity.Id);
            return false;
        }
    }
}

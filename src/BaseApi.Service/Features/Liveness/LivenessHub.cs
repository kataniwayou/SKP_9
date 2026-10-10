using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Liveness;

/// <summary>
/// Live push of workflow and processor liveness (2026-10-10). Clients receive <c>workflowLive</c>,
/// <c>processorLiveness</c> and <c>monitorStatus</c>, each with a sequence number one above the last, and call
/// <see cref="Snapshot"/> on connect, on reconnect and whenever they see a gap; <c>livenessSequence</c> (every 10 s)
/// says the last number, so a lost last broadcast shows as a gap too. The GET endpoints stay (the start gate,
/// and the studio's fallback while it is not connected).
/// <para>
/// <b>One replica, no backplane.</b> Every client is connected to the one BaseApi that runs the monitor. Scaling
/// BaseApi out needs a SignalR backplane (e.g. Redis) and one monitor (or one sequence) across replicas.
/// </para>
/// </summary>
public sealed class LivenessHub : Hub<ILivenessClient>
{
    /// <summary>How long a snapshot waits for the monitor's first reading when BaseApi has just started.</summary>
    internal static readonly TimeSpan FirstReadingWait = TimeSpan.FromSeconds(5);

    /// <summary>The path, under <c>/api/</c> like every BaseApi route, so the studio's proxies pass it through unchanged.</summary>
    public const string Path = "/api/hubs/liveness";

    private readonly LivenessState _state;

    public LivenessHub(LivenessState state) => _state = state ?? throw new ArgumentNullException(nameof(state));

    /// <summary>The whole state and the sequence number of the last change it includes.</summary>
    public async Task<LivenessSnapshotDto> Snapshot()
    {
        try
        {
            await _state.FirstReading.WaitAsync(FirstReadingWait, Context.ConnectionAborted);
        }
        catch (TimeoutException)
        {
            // not read yet: the snapshot says unknown, and the first reading's monitor status asks for another
        }
        return _state.Snapshot();
    }
}

/// <summary>Registers the liveness hub, its state and the monitor.</summary>
internal static class LivenessServiceCollectionExtensions
{
    public static IServiceCollection AddLivenessFeature(this IServiceCollection services, IConfiguration cfg)
    {
        // A background browser tab whose timers Chrome throttles may ping only once a minute: the client gets 3 min before
        // it is dropped. The server pings every 15 s; the studio gives the server 60 s (signalrHub.ts).
        services.AddSignalR(o =>
        {
            o.KeepAliveInterval = TimeSpan.FromSeconds(15);
            o.ClientTimeoutInterval = TimeSpan.FromMinutes(3);
        });
        services.Configure<LivenessMonitorOptions>(cfg.GetSection(LivenessMonitorOptions.Section));
        services.AddSingleton<LivenessState>();
        services.AddSingleton<ILivenessSource, RedisLivenessSource>();
        services.AddSingleton<ILivenessPublisher, HubLivenessPublisher>();
        services.AddHostedService<LivenessMonitor>();
        return services;
    }

    public static IEndpointRouteBuilder MapLivenessHub(this IEndpointRouteBuilder app)
    {
        app.MapHub<LivenessHub>(LivenessHub.Path);
        return app;
    }
}

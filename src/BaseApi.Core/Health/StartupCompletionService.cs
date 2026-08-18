using BaseApi.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BaseApi.Core.Health;

/// <summary>
/// Applies the migration set at startup and marks the startup gate ready only on success.
///
/// <para>
/// It resolves <see cref="BaseDbContext"/> rather than the concrete context, because the composition
/// root registers the base type as a scoped alias for the application's context. That keeps this
/// assembly free of any reference to the service assembly while still migrating the real context.
/// </para>
///
/// <para>
/// The context is scoped and this hosted service runs at the root scope, so creating a scope is
/// required — resolving a scoped dependency straight from the root provider throws.
/// </para>
///
/// <para>
/// <b>Failure semantics:</b> a migration failure is logged at critical level and swallowed. It must
/// not rethrow, because a hosted service throwing during start crashes the host; and it must not
/// mark the gate ready, so the startup probe stays unhealthy and the orchestrator does not route
/// traffic to a process whose schema is not in place.
/// </para>
/// </summary>
public sealed class StartupCompletionService : IHostedService
{
    private readonly IStartupGate _gate;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<StartupCompletionService> _logger;

    public StartupCompletionService(
        IStartupGate gate,
        IServiceScopeFactory scopeFactory,
        ILogger<StartupCompletionService> logger)
    {
        _gate = gate;
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<BaseDbContext>();
            await db.Database.MigrateAsync(cancellationToken);
            _gate.MarkReady();
        }
        catch (Exception ex)
        {
            _logger.LogCritical(ex, "Database migration failed on startup; readiness probe will remain unhealthy.");
            // Deliberately no rethrow — that would crash the host — and deliberately no MarkReady,
            // so the startup probe stays unhealthy.
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

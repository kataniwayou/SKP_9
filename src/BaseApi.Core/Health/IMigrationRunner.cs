using BaseApi.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Core.Health;

/// <summary>
/// "Apply the migration set" as something a caller can await.
/// <para>
/// <b>Why it is an interface over a four-line implementation.</b> <c>DatabaseFacade.MigrateAsync</c>
/// is an extension method on a sealed facade reached through a concrete <see cref="DbContext"/>, so a
/// test holding a real context can only ever exercise the it-failed branch — and only by pointing at
/// a host that is not there. The loop around this call is the part worth testing: that it marks the
/// startup gate before the first attempt, that it keeps retrying, that it classifies what it catches.
/// This seam is what makes that reachable. <c>IApiBrokerConnectivityCheck</c> and
/// <c>Orchestrator.Messaging.ITopologyDeclarer</c> exist for the identical reason.
/// </para>
/// </summary>
public interface IMigrationRunner
{
    /// <summary>
    /// Applies any pending migrations, throwing the provider's own exception if it cannot. Idempotent:
    /// a second call against an up-to-date schema does nothing.
    /// </summary>
    Task MigrateAsync(CancellationToken ct);
}

/// <summary>
/// The production <see cref="IMigrationRunner"/>.
/// <para>
/// It resolves <see cref="BaseDbContext"/> rather than the concrete context, because the composition
/// root registers the base type as a scoped alias for the application's context — which keeps this
/// assembly free of any reference to the service assembly while still migrating the real context. The
/// context is scoped and the caller runs at the root scope, so creating a scope here is required:
/// resolving a scoped dependency straight from the root provider throws.
/// </para>
/// </summary>
public sealed class MigrationRunner(IServiceScopeFactory scopeFactory) : IMigrationRunner
{
    private readonly IServiceScopeFactory _scopeFactory =
        scopeFactory ?? throw new ArgumentNullException(nameof(scopeFactory));

    /// <inheritdoc/>
    public async Task MigrateAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BaseDbContext>();
        await db.Database.MigrateAsync(ct).ConfigureAwait(false);
    }
}

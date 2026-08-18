using BaseApi.Core.Persistence;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// Composition root for the API service, chaining the seven sub-extensions in order.
/// Observability is deliberately not part of the chain: it is invoked on the host builder instead,
/// because <c>builder.Logging.AddOpenTelemetry</c> needs an <c>ILoggingBuilder</c>, which
/// <c>IServiceCollection</c> does not expose.
/// </summary>
public static class BaseApiServiceCollectionExtensions
{
    /// <summary>
    /// Public top-level entry. Constrained to <see cref="BaseDbContext"/> rather than plain
    /// <c>DbContext</c>, so the consumer's context is guaranteed to carry the <c>xmin</c> shadow
    /// concurrency token and the snake_case naming convention.
    /// </summary>
    /// <typeparam name="TDbContext">The application's context, or any <see cref="BaseDbContext"/> subclass.</typeparam>
    public static IServiceCollection AddBaseApi<TDbContext>(
        this IServiceCollection services, IConfiguration cfg)
        where TDbContext : BaseDbContext
        => services
            .AddBaseApiPersistence<TDbContext>(cfg)
            .AddBaseApiHealth(cfg)
            .AddBaseApiErrorHandling()
            .AddBaseApiHttp(cfg)
            .AddBaseApiValidation(typeof(TDbContext).Assembly)
            .AddBaseApiMapping(typeof(TDbContext).Assembly)
            .AddBaseApiRedis(cfg);
}

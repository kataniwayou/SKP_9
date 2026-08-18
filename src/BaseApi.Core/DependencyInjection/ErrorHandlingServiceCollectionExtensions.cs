using BaseApi.Core.Exceptions.Handlers;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Core.DependencyInjection;

/// <summary>
/// Error wiring: a problem-details customizer that injects <c>correlationId</c> and <c>instance</c>
/// into every emission, plus the exception-handler chain.
/// <para>
/// <b>Registration order is load-bearing:</b> handlers are walked in the order they are registered
/// and the first to return true claims the exception. The catch-all is deliberately not registered
/// here — the composition root registers it last, via <see cref="AddBaseApiFallbackHandler"/>, so
/// domain handlers get a chance to claim first.
/// </para>
/// </summary>
public static class ErrorHandlingServiceCollectionExtensions
{
    internal static IServiceCollection AddBaseApiErrorHandling(this IServiceCollection services)
    {
        services.AddProblemDetails(options =>
        {
            options.CustomizeProblemDetails = ctx =>
            {
                if (ctx.HttpContext.Items.TryGetValue("CorrelationId", out var corrIdObj)
                    && corrIdObj is string corrId)
                {
                    ctx.ProblemDetails.Extensions["correlationId"] = corrId;
                }
                ctx.ProblemDetails.Instance = ctx.HttpContext.Request.Path;
            };
        });

        // Order is load-bearing — walked top to bottom, first to return true claims. The concurrency
        // case inside the database handler is why it sits after the two more specific handlers.
        services.AddExceptionHandler<NotFoundExceptionHandler>();
        services.AddExceptionHandler<ValidationExceptionHandler>();
        services.AddExceptionHandler<DbUpdateExceptionHandler>();

        return services;
    }

    /// <summary>
    /// Registers the catch-all <see cref="FallbackExceptionHandler"/> last in the walk order. Must be
    /// called after the base API and after the application's own feature registration, so domain
    /// handlers register ahead of it and get first claim.
    /// </summary>
    public static IServiceCollection AddBaseApiFallbackHandler(this IServiceCollection services)
    {
        services.AddExceptionHandler<FallbackExceptionHandler>();
        return services;
    }
}

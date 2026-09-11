using BaseApi.Core.Exceptions.Handlers;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

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

                LogRefusal(ctx);
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
    /// The logger name every refusal is written under. A category rather than a type because the
    /// record belongs to no one handler: it is emitted from the customizer, which is the only place
    /// that sees them all.
    /// </summary>
    internal const string RefusalCategory = "BaseApi.Core.Exceptions.Refusal";

    /// <summary>
    /// THE RECORD OF A REFUSED REQUEST, which until 2026-09-11 did not exist.
    /// <para>
    /// <b>Five of the six exception handlers log nothing, and nothing else did either.</b> Only
    /// <see cref="FallbackExceptionHandler"/> carried a line, so a 500 was findable and every 4xx was
    /// silent: the caller got ProblemDetails and the operator got nothing. ASP.NET's own
    /// <c>Request finished</c> record does not fill the gap — <c>Microsoft.AspNetCore</c> is pinned to
    /// Warning precisely so the health probes do not write one per poll.
    /// </para>
    /// <para>
    /// <b>Here rather than in each handler, because here is the only place that cannot drift.</b> The
    /// customizer runs on every emission from every handler, including ones not yet written. Five
    /// handlers missing a line they were each supposed to carry IS the drift, already happened.
    /// </para>
    /// <para>
    /// <b>What this makes visible:</b> <c>OrchestrationService.StartAsync</c> runs five gates and logs
    /// only <c>accepted start</c>, on success. A workflow refused because a processor is UNHEALTHY —
    /// the gate ConfigSchemaConformance was built to arm — produced no server-side record at all, so
    /// "the workflow never started" and "the request never arrived" were the same log.
    /// </para>
    /// </summary>
    private static void LogRefusal(ProblemDetailsContext ctx)
    {
        // 4xx ONLY. A 500 already has a record, written with the exception by the fallback handler,
        // and a second one here would double every unhandled fault while adding no detail.
        var status = ctx.ProblemDetails.Status ?? ctx.HttpContext.Response.StatusCode;
        if (status is < 400 or >= 500)
        {
            return;
        }

        // Resolved per emission rather than captured: the customizer is configured once, on a
        // container that does not exist yet, and a refusal always has a request scope to resolve from.
        var logger = ctx.HttpContext.RequestServices
            .GetRequiredService<ILoggerFactory>()
            .CreateLogger(RefusalCategory);

        // 404 stays Information. A caller probing for existence is not a fault, and this endpoint set
        // is polled — promoting it would make the level meaningless on exactly the traffic that would
        // dominate it. 422 and 409 are Warning: work was asked for and refused, and nobody but the
        // caller learns that.
        var level = status == StatusCodes.Status404NotFound ? LogLevel.Information : LogLevel.Warning;

        // Title, not Detail. Detail carries the gate's own message — ids, field names, a cycle path —
        // which would make body.text unique per refusal, and it is indexed as a keyword, so a body
        // carrying variable text can only be found by a wildcard. Title is the small bounded set, and
        // Detail rides the record as an attribute where its cardinality costs nothing.
        logger.Log(level, "the request was refused with {StatusCode}: {Title}", status,
            ctx.ProblemDetails.Title);
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

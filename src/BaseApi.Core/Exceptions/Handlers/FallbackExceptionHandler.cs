using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace BaseApi.Core.Exceptions.Handlers;

/// <summary>
/// Last handler in the chain — the catch-all, claiming every exception the earlier handlers did not.
///
/// <para>
/// <b>Information-disclosure guard:</b> the 500 response body carries only the title, status and a
/// generic detail, plus the correlation id and instance added by the problem-details customizer. The
/// exception type, message and stack trace are never in the body — they go to the logger, which
/// serializes them as structured fields.
/// </para>
/// </summary>
public sealed class FallbackExceptionHandler : IExceptionHandler
{
    private readonly IProblemDetailsService _pdSvc;
    private readonly ILogger<FallbackExceptionHandler> _logger;

    public FallbackExceptionHandler(
        IProblemDetailsService pdSvc,
        ILogger<FallbackExceptionHandler> logger)
    {
        _pdSvc = pdSvc;
        _logger = logger;
    }

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        // The full exception and stack go to the log; the body never carries them.
        _logger.LogError(exception, "Unhandled exception on {Path}", httpContext.Request.Path);

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;

        var problem = new ProblemDetails
        {
            Status = StatusCodes.Status500InternalServerError,
            Title = "Internal Server Error",
            Detail = "An unexpected error occurred.",
        };

        // When a faulting layer tags the exception with the offending operation name, surface only
        // that name. It is a fixed literal chosen by the caller, so no connection string, exception
        // message or stack is ever copied into the body.
        //
        // Both tags matter for the same reason and neither may ever carry anything but a literal: a
        // projection-store fault and a broker fault both raise exceptions whose own messages can
        // contain a host, a port or credentials, which is precisely why the message is logged and the
        // operation name is what reaches the caller.
        if (exception.Data["redisOp"] is string redisOp && redisOp.Length > 0)
        {
            problem.Extensions["redisOp"] = redisOp;
        }

        if (exception.Data["brokerOp"] is string brokerOp && brokerOp.Length > 0)
        {
            problem.Extensions["brokerOp"] = brokerOp;
        }

        // Attempt the write but ignore its result: this exception is claimed either way. If the
        // response has already started, the write returns false and we still return true, so the
        // chain does not rethrow.
        _ = await _pdSvc.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails = problem,
            Exception = exception,
        });

        return true;  // catch-all: always claimed
    }
}

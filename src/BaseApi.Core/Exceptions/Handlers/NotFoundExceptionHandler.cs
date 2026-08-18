using BaseApi.Core.Exceptions;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Core.Exceptions.Handlers;

/// <summary>
/// First handler in the chain — claims <see cref="NotFoundException"/> and produces an HTTP 404
/// carrying <c>resourceType</c> and <c>resourceId</c> extensions.
///
/// <para>
/// If the exception is not a <see cref="NotFoundException"/> it returns false immediately, with no
/// logging and no response writes, so the next handler can claim it cleanly.
/// </para>
/// </summary>
public sealed class NotFoundExceptionHandler : IExceptionHandler
{
    private readonly IProblemDetailsService _pdSvc;

    public NotFoundExceptionHandler(IProblemDetailsService pdSvc) => _pdSvc = pdSvc;

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not NotFoundException nfx) return false;  // bail fast, no side effects

        httpContext.Response.StatusCode = StatusCodes.Status404NotFound;

        var problem = new ProblemDetails
        {
            Status = StatusCodes.Status404NotFound,
            Title = "Not Found",
            Detail = nfx.Message,
            Extensions =
            {
                ["resourceType"] = nfx.ResourceType,
                ["resourceId"] = nfx.Id,
            },
        };

        return await _pdSvc.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails = problem,
            Exception = exception,
        });
    }
}

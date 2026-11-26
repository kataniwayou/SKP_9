using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Composition;

/// <summary>
/// Claims Kestrel's <see cref="BadHttpRequestException"/> (a body over the size limit, a request timeout,
/// malformed framing) and answers with the status the exception itself carries, instead of letting the
/// catch-all turn it into a 500. It is registered with the application features, so it walks ahead of the
/// catch-all.
/// <para>
/// A 413 names the limit (Kestrel's default 30,000,000 bytes). Nothing else of the exception reaches the body.
/// </para>
/// </summary>
public sealed class BadHttpRequestExceptionHandler(IProblemDetailsService pdSvc) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not BadHttpRequestException ex) return false;

        var status = ex.StatusCode;
        httpContext.Response.StatusCode = status;

        var problem = status == StatusCodes.Status413PayloadTooLarge
            ? new ProblemDetails
            {
                Status = status,
                Title = "Request body too large",
                Detail = "The request body exceeds the 30,000,000-byte limit. Send the items in several smaller requests.",
            }
            : new ProblemDetails
            {
                Status = status,
                Title = "Bad request",
                Detail = "The request could not be read.",
            };

        return await pdSvc.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails = problem,
            Exception = exception,
        });
    }
}

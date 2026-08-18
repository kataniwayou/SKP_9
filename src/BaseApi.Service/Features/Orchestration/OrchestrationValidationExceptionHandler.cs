using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// Domain handler that claims <see cref="OrchestrationValidationException"/> and returns a 422. It
/// mirrors the not-found handler exactly, swapping the exception type and the status code.
///
/// <para>
/// If the exception is not an orchestration validation exception it returns false immediately, with
/// no side effects, so the next handler — ultimately the catch-all — claims it. That is what stops
/// this handler swallowing exceptions that are not its own.
/// </para>
///
/// <para>
/// It sets only the status, title, detail and errors. The correlation id and instance are injected by
/// the problem-details customizer on every emission, so setting them here would duplicate them.
/// </para>
/// </summary>
public sealed class OrchestrationValidationExceptionHandler : IExceptionHandler
{
    private readonly IProblemDetailsService _pdSvc;

    public OrchestrationValidationExceptionHandler(IProblemDetailsService pdSvc) => _pdSvc = pdSvc;

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not OrchestrationValidationException ex) return false;  // bail fast

        httpContext.Response.StatusCode = StatusCodes.Status422UnprocessableEntity;

        var problem = new ProblemDetails
        {
            Status = StatusCodes.Status422UnprocessableEntity,
            Title = ex.Title,
            Detail = ex.Message,
            Extensions =
            {
                ["errors"] = ex.ErrorsExtension,
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

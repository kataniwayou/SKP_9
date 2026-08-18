using FluentValidation;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Core.Exceptions.Handlers;

/// <summary>
/// Second handler in the chain — claims a FluentValidation <see cref="ValidationException"/> and
/// produces an HTTP 400 <c>ValidationProblemDetails</c> with a field-level error map.
///
/// <para>
/// This is only the FluentValidation half of the 400 shape. Model-binding failures produce the same
/// shape automatically, because the framework's default invalid-model-state factory writes through
/// the same problem-details service.
/// </para>
///
/// <para>
/// If the exception is not a validation exception it returns false immediately, with no side effects.
/// </para>
/// </summary>
public sealed class ValidationExceptionHandler : IExceptionHandler
{
    private readonly IProblemDetailsService _pdSvc;

    public ValidationExceptionHandler(IProblemDetailsService pdSvc) => _pdSvc = pdSvc;

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not ValidationException vex) return false;  // bail fast

        var errors = vex.Errors
            .GroupBy(e => e.PropertyName)
            .ToDictionary(
                g => g.Key,
                g => g.Select(e => e.ErrorMessage).ToArray());

        httpContext.Response.StatusCode = StatusCodes.Status400BadRequest;

        var problem = new ValidationProblemDetails(errors)
        {
            Status = StatusCodes.Status400BadRequest,
            Title = "Validation failed",
        };

        return await _pdSvc.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails = problem,
            Exception = exception,
        });
    }
}

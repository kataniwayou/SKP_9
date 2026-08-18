using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Features.Schema;

/// <summary>
/// Domain handler that claims <see cref="SchemaDefinitionFrozenException"/> and returns a 409. It
/// mirrors the orchestration validation handler, swapping the exception type and using the
/// state-conflict status rather than the unprocessable-entity one.
///
/// <para>
/// If the exception is not a frozen-definition exception it returns false immediately, with no side
/// effects, so the next handler — ultimately the catch-all — claims it.
/// </para>
///
/// <para>
/// It sets only the status, title and detail. The correlation id and instance are injected by the
/// problem-details customizer on every emission. The body carries only the schema id and a generic
/// message.
/// </para>
/// </summary>
public sealed class SchemaDefinitionFrozenExceptionHandler : IExceptionHandler
{
    private readonly IProblemDetailsService _pdSvc;

    public SchemaDefinitionFrozenExceptionHandler(IProblemDetailsService pdSvc) => _pdSvc = pdSvc;

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not SchemaDefinitionFrozenException ex) return false;  // bail fast

        httpContext.Response.StatusCode = StatusCodes.Status409Conflict;

        var problem = new ProblemDetails
        {
            Status = StatusCodes.Status409Conflict,
            Title  = "Schema definition is frozen",
            Detail = $"Schema '{ex.SchemaId}' is referenced by a processor; its Definition cannot be modified. " +
                     "Create a new schema and re-point. (Name and Description remain editable.)",
        };

        return await _pdSvc.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails = problem,
            Exception = exception,
        });
    }
}

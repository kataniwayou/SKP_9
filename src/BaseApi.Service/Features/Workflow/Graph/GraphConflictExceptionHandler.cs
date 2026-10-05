using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// Turns <see cref="GraphConflictException"/> into a 409 that names the stale entity, so the editor
/// can tell the user which workflow or step changed under them. The detail carries only the kind
/// and id the caller itself sent.
/// </summary>
public sealed class GraphConflictExceptionHandler : IExceptionHandler
{
    private readonly IProblemDetailsService _pdSvc;

    public GraphConflictExceptionHandler(IProblemDetailsService pdSvc) => _pdSvc = pdSvc;

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not GraphConflictException ex) return false;  // bail fast

        httpContext.Response.StatusCode = StatusCodes.Status409Conflict;

        var problem = new ProblemDetails
        {
            Status = StatusCodes.Status409Conflict,
            Title = "Graph is stale",
            Detail = $"The {ex.Kind} '{ex.Id}' was changed since it was loaded. Reload the workflow and re-apply your edits.",
        };
        problem.Extensions["kind"] = ex.Kind;
        problem.Extensions["id"] = ex.Id;

        return await _pdSvc.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            ProblemDetails = problem,
            Exception = exception,
        });
    }
}

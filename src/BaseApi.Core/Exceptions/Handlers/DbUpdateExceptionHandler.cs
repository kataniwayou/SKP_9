using BaseApi.Core.Persistence.Exceptions;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Core.Exceptions.Handlers;

/// <summary>
/// Third handler in the chain — claims <see cref="DbUpdateException"/> and all its subtypes,
/// including <see cref="DbUpdateConcurrencyException"/>.
///
/// <para>
/// <b>The concurrency check must come before the SQLSTATE mapping.</b>
/// <see cref="DbUpdateConcurrencyException"/> is detected by EF itself — zero rows affected because
/// <c>xmin</c> advanced — so it has no Postgres inner exception. Map first and the mapper returns
/// false, the handler falls through to the catch-all, and a conflict is reported as a 500.
/// </para>
///
/// <para>
/// <b>Information-disclosure guard:</b> the 409 detail is a fixed generic message. The <c>xmin</c>
/// value, the row id and the conflicting field set are never exposed.
/// </para>
///
/// <para>
/// A non-<see cref="DbUpdateException"/> bails immediately with no side effects, and an unrecognized
/// SQLSTATE also returns false so the catch-all claims the 500.
/// </para>
/// </summary>
public sealed class DbUpdateExceptionHandler : IExceptionHandler
{
    private readonly IProblemDetailsService _pdSvc;

    public DbUpdateExceptionHandler(IProblemDetailsService pdSvc) => _pdSvc = pdSvc;

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is not DbUpdateException due) return false;  // bail fast

        // Concurrency first — see the note on ordering above.
        if (exception is DbUpdateConcurrencyException)
        {
            httpContext.Response.StatusCode = StatusCodes.Status409Conflict;
            var concurrencyProblem = new ProblemDetails
            {
                Status = StatusCodes.Status409Conflict,
                Title = "Conflict",
                Detail = "The resource was modified by another request; reload and retry.",
            };
            return await _pdSvc.TryWriteAsync(new ProblemDetailsContext
            {
                HttpContext = httpContext,
                ProblemDetails = concurrencyProblem,
                Exception = exception,
            });
        }

        // Then attempt the Postgres SQLSTATE mapping.
        if (PostgresExceptionMapper.TryMap(due, out var status, out var detail, out var col))
        {
            httpContext.Response.StatusCode = status;
            var problem = new ProblemDetails
            {
                Status = status,
                Title = status == StatusCodes.Status422UnprocessableEntity
                    ? "Unprocessable Entity" : "Conflict",
                Detail = detail,
            };
            if (col is not null) problem.Extensions["field"] = col;
            return await _pdSvc.TryWriteAsync(new ProblemDetailsContext
            {
                HttpContext = httpContext,
                ProblemDetails = problem,
                Exception = exception,
            });
        }

        return false;  // unmapped SQLSTATE — the catch-all takes it
    }
}

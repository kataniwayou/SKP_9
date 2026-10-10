using BaseApi.Service.Features.Orchestration;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Filters;

namespace BaseApi.Service.Features.Workflow.Delete;

/// <summary>
/// The plain CRUD <c>DELETE /workflows/{id}</c>, refused (422) while the workflow runs or its deletion runs
/// (2026-10-10): deleted while running, its running copy could never be stopped by an id that is gone. A filter, because
/// the CRUD verb is inherited from the base controller. Its steps and assignments stay: the studio deletes a workflow
/// through <c>POST /workflows/{id}/delete</c>, which takes them with it.
/// </summary>
internal sealed class WorkflowDeleteGuardFilter : IAsyncActionFilter
{
    private readonly IWorkflowRunGuard _guard;

    public WorkflowDeleteGuardFilter(IWorkflowRunGuard guard) => _guard = guard;

    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        if (HttpMethods.IsDelete(context.HttpContext.Request.Method)
            && context.ActionArguments.TryGetValue("id", out var value) && value is Guid id)
        {
            var ct = context.HttpContext.RequestAborted;
            if (await _guard.IsLiveAsync(id, ct)) throw OrchestrationValidationException.WorkflowRunning(id);
            if (await _guard.IsDeletingAsync(id, ct)) throw OrchestrationValidationException.WorkflowDeleting(id);
        }
        await next();
    }
}

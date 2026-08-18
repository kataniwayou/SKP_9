using BaseApi.Core.Controllers;
using BaseApi.Core.Services;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Concrete controller for the Workflow feature. The body is empty because the five CRUD verbs are
/// inherited from <see cref="BaseController{TEntity,TCreate,TUpdate,TRead}"/>, and the URL prefix
/// <c>/api/v1/workflows</c> comes from the <c>[controller]</c> token convention.
/// <para>
/// The constructor injects the <b>abstract</b> <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/>
/// rather than the concrete <see cref="WorkflowService"/>, which makes the alias registered in
/// <see cref="WorkflowServiceCollectionExtensions.AddWorkflowFeature"/> load-bearing: without it, the container
/// cannot resolve this controller's dependency.
/// </para>
/// </summary>
public sealed class WorkflowsController :
    BaseController<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto>
{
    public WorkflowsController(
        BaseService<WorkflowEntity, WorkflowCreateDto, WorkflowUpdateDto, WorkflowReadDto> service)
        : base(service) { }
}

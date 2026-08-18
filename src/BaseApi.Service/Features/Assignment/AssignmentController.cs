using BaseApi.Core.Controllers;
using BaseApi.Core.Services;

namespace BaseApi.Service.Features.Assignment;

/// <summary>
/// Concrete controller for the Assignment feature. The body is empty because the five CRUD verbs are
/// inherited from <see cref="BaseController{TEntity,TCreate,TUpdate,TRead}"/>, and the URL prefix
/// <c>/api/v1/assignments</c> comes from the <c>[controller]</c> token convention.
/// <para>
/// The constructor injects the <b>abstract</b> <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/>
/// rather than the concrete <see cref="AssignmentService"/>, which makes the alias registered in
/// <see cref="AssignmentServiceCollectionExtensions.AddAssignmentFeature"/> load-bearing: without it, the container
/// cannot resolve this controller's dependency.
/// </para>
/// </summary>
public sealed class AssignmentsController :
    BaseController<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto>
{
    public AssignmentsController(
        BaseService<AssignmentEntity, AssignmentCreateDto, AssignmentUpdateDto, AssignmentReadDto> service)
        : base(service) { }
}

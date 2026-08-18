using BaseApi.Core.Controllers;
using BaseApi.Core.Services;

namespace BaseApi.Service.Features.Step;

/// <summary>
/// Concrete controller for the Step feature. The body is empty because the five CRUD verbs are
/// inherited from <see cref="BaseController{TEntity,TCreate,TUpdate,TRead}"/>, and the URL prefix
/// <c>/api/v1/steps</c> comes from the <c>[controller]</c> token convention.
/// <para>
/// The constructor injects the <b>abstract</b> <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/>
/// rather than the concrete <see cref="StepService"/>, which makes the alias registered in
/// <see cref="StepServiceCollectionExtensions.AddStepFeature"/> load-bearing: without it, the container
/// cannot resolve this controller's dependency.
/// </para>
/// </summary>
public sealed class StepsController :
    BaseController<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto>
{
    public StepsController(
        BaseService<StepEntity, StepCreateDto, StepUpdateDto, StepReadDto> service)
        : base(service) { }
}

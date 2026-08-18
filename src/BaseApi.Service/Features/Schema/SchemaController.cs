using BaseApi.Core.Controllers;
using BaseApi.Core.Services;

namespace BaseApi.Service.Features.Schema;

/// <summary>
/// Concrete controller for the Schema feature. The body is empty because the five CRUD verbs are
/// inherited from <see cref="BaseController{TEntity,TCreate,TUpdate,TRead}"/>, and the URL prefix
/// <c>/api/v1/schemas</c> comes from the <c>[controller]</c> token convention.
/// <para>
/// The constructor injects the <b>abstract</b> <see cref="BaseService{TEntity,TCreate,TUpdate,TRead}"/>
/// rather than the concrete <see cref="SchemaService"/>, which makes the alias registered in
/// <see cref="SchemaServiceCollectionExtensions.AddSchemaFeature"/> load-bearing: without it, the container
/// cannot resolve this controller's dependency.
/// </para>
/// </summary>
public sealed class SchemasController :
    BaseController<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto>
{
    public SchemasController(
        BaseService<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto> service)
        : base(service) { }
}

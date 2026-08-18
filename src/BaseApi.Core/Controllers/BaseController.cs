using Asp.Versioning;
using BaseApi.Core.Contracts;
using BaseApi.Core.Entities;
using BaseApi.Core.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Core.Controllers;

/// <summary>
/// Abstract generic base controller exposing the five CRUD verbs against
/// <typeparamref name="TEntity"/>. Concrete controllers inherit with an empty body: the verbs come
/// from here and the URL prefix comes from the route attribute below, which uses URL-segment
/// versioning.
/// </summary>
/// <typeparam name="TEntity">The concrete <see cref="BaseEntity"/> subclass.</typeparam>
/// <typeparam name="TCreate">POST body DTO, excluding server-controlled fields.</typeparam>
/// <typeparam name="TUpdate">PUT body DTO, excluding the id and the creation audit fields.</typeparam>
/// <typeparam name="TRead">Response DTO, which implements <see cref="IHasId"/>.</typeparam>
[ApiController]
[ApiVersion("1.0")]
[Route("api/v{version:apiVersion}/[controller]")]
public abstract class BaseController<TEntity, TCreate, TUpdate, TRead> : ControllerBase
    where TEntity : BaseEntity
    where TCreate : class
    where TUpdate : class
    where TRead   : IHasId
{
    private readonly BaseService<TEntity, TCreate, TUpdate, TRead> _service;

    /// <summary>Concrete controllers pass through the matching concrete service.</summary>
    protected BaseController(BaseService<TEntity, TCreate, TUpdate, TRead> service)
        => _service = service;

    /// <summary>Returns the full list as a bare JSON array.</summary>
    /// <remarks>
    /// The response-type attributes here are status-code-only: C# attribute arguments cannot use a
    /// generic type parameter, so <c>typeof(IReadOnlyList&lt;TRead&gt;)</c> would not compile. The
    /// generic schema still reaches the OpenAPI document through the action's return type, and a
    /// concrete controller may add typed attributes of its own if it wants per-status schemas.
    /// </remarks>
    [HttpGet]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<TRead>>> List(CancellationToken ct)
        => Ok(await _service.ListAsync(ct));

    /// <summary>Returns one entity by id, or 404 when it does not exist.</summary>
    [HttpGet("{id:guid}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(Microsoft.AspNetCore.Mvc.ProblemDetails), StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TRead>> GetById(Guid id, CancellationToken ct)
        => Ok(await _service.GetByIdAsync(id, ct));

    /// <summary>
    /// Creates an entity, returning 201 with a Location header and the read DTO as the body.
    /// A validation failure is mapped to 400 by the exception-handler chain.
    /// </summary>
    [HttpPost]
    [ProducesResponseType(StatusCodes.Status201Created)]
    [ProducesResponseType(typeof(Microsoft.AspNetCore.Mvc.ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(Microsoft.AspNetCore.Mvc.ProblemDetails), StatusCodes.Status409Conflict)]
    [ProducesResponseType(typeof(Microsoft.AspNetCore.Mvc.ProblemDetails), StatusCodes.Status422UnprocessableEntity)]
    public async Task<ActionResult<TRead>> Create([FromBody] TCreate dto, CancellationToken ct)
    {
        var read = await _service.CreateAsync(dto, ct);
        return CreatedAtAction(nameof(GetById), new { id = read.Id }, read);
    }

    /// <summary>Updates an entity, returning 200 with the read DTO as the body.</summary>
    [HttpPut("{id:guid}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(Microsoft.AspNetCore.Mvc.ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(Microsoft.AspNetCore.Mvc.ProblemDetails), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(Microsoft.AspNetCore.Mvc.ProblemDetails), StatusCodes.Status409Conflict)]
    public async Task<ActionResult<TRead>> Update(Guid id, [FromBody] TUpdate dto, CancellationToken ct)
        => Ok(await _service.UpdateAsync(id, dto, ct));

    /// <summary>Deletes an entity, returning 204, or 404 when it does not exist.</summary>
    [HttpDelete("{id:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(Microsoft.AspNetCore.Mvc.ProblemDetails), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct)
    {
        await _service.DeleteAsync(id, ct);
        return NoContent();
    }
}

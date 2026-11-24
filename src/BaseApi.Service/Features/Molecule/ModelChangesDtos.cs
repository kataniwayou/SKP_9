namespace BaseApi.Service.Features.Molecule;

/// <summary>The body of <c>POST /model/validate</c>: the changes, in the order they would be sent.</summary>
public sealed record ModelChangesDto(IReadOnlyList<ModelChangeDto> Changes);

/// <summary>One change.</summary>
/// <param name="Op"><c>create</c> (a <c>POST</c>), <c>update</c> (a <c>PUT</c>) or <c>delete</c> (a <c>DELETE</c>).</param>
/// <param name="Table">The entity's table (<c>workflows</c>, <c>steps</c>, <c>caches</c>, <c>assignments</c>, <c>processors</c>, <c>schemas</c>).</param>
/// <param name="Id">The row's id; for a create, the client's id for it, which later changes may name (BaseApi maps it to the id it gives).</param>
/// <param name="Row">For a create or an update, the body a <c>POST</c> or <c>PUT</c> would send; absent for a delete.</param>
/// <param name="UpdatedAt">
/// For an update or a delete, the row's <c>updatedAt</c> as the client read it: a row changed since (its <c>updatedAt</c>
/// differs) is refused with a 409, so a change made elsewhere is never overwritten unseen. Absent: no such check.
/// </param>
public sealed record ModelChangeDto(string Op, string Table, Guid Id, System.Text.Json.JsonElement? Row, DateTime? UpdatedAt = null);

/// <summary>The dry run's answer: whether every change passed, and each change's result in order.</summary>
public sealed record ModelValidateResultDto(bool Ok, IReadOnlyList<ModelChangeResultDto> Results);

/// <summary>
/// The apply's answer (<c>POST /model/apply</c>): whether every change passed, whether they were kept (all of them, or
/// none), each change's result in order, and each created row's client id → the id BaseApi gave it.
/// </summary>
public sealed record ModelApplyResultDto(bool Ok, bool Applied, IReadOnlyList<ModelChangeResultDto> Results, IReadOnlyDictionary<Guid, Guid> Made);

/// <param name="Index">The change's place in the request.</param>
/// <param name="Op">The change's op, as sent.</param>
/// <param name="Table">The change's table, as sent.</param>
/// <param name="Id">The change's row id, as sent.</param>
/// <param name="Ok">Whether it passed, on the state the changes before it left.</param>
/// <param name="Status">What the real call would answer: 200 or 204, else the problem's status.</param>
/// <param name="Problem">The problem the real call would answer (its <c>errors</c>, <c>detail</c>, <c>field</c>…), or null.</param>
public sealed record ModelChangeResultDto(int Index, string Op, string Table, Guid Id, bool Ok, int Status, System.Text.Json.JsonElement? Problem);

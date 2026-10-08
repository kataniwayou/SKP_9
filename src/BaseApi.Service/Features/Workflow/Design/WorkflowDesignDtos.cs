using System.Text.Json;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>
/// The body of <c>PUT /workflows/{id}/design</c> (plan 8 §4.2): every change of the studio's virtual
/// entities relative to the real ones. Each entity names only its changed fields, by the CRUD DTO's
/// camelCase name, with a JSON value; owned entities (the workflow, steps, assignments) carry the
/// <c>updatedAt</c> the designer loaded. Stored as it came (without <see cref="Layout"/>) whether or
/// not it can be applied.
/// </summary>
/// <param name="Workflow">The workflow's changes and loaded stamp; null when nothing of the workflow changed.</param>
/// <param name="Steps">Changed steps: fields and/or the whole next-step list.</param>
/// <param name="Processors">Changed processors: fields and slot re-points to schema copies.</param>
/// <param name="Caches">Changed caches.</param>
/// <param name="Schemas">Schema copies to insert (new ids).</param>
/// <param name="Assignments">At most one create, update or delete per step of this workflow.</param>
/// <param name="Layout">The canvas layout, loose wires included; required.</param>
public sealed record DesignSaveRequest(
    DesignWorkflowDto? Workflow,
    List<DesignStepDto>? Steps,
    List<DesignProcessorDto>? Processors,
    List<DesignCacheDto>? Caches,
    List<DesignSchemaDto>? Schemas,
    List<DesignAssignmentDto>? Assignments,
    JsonElement? Layout);

/// <param name="UpdatedAt">The workflow's <c>updatedAt</c> the designer loaded.</param>
/// <param name="Fields">The changed fields by camelCase name; null: none.</param>
/// <param name="EntryStepIds">The whole entry list when it changed; null: unchanged.</param>
/// <param name="CacheIds">The whole cache list when it changed; null: unchanged.</param>
public sealed record DesignWorkflowDto(
    DateTime? UpdatedAt, Dictionary<string, JsonElement>? Fields, List<Guid>? EntryStepIds, List<Guid>? CacheIds);

/// <param name="Id">The step.</param>
/// <param name="UpdatedAt">The step's <c>updatedAt</c> the designer loaded.</param>
/// <param name="Fields">The changed fields by camelCase name; null: none.</param>
/// <param name="NextStepIds">The whole next-step list when the step's wires changed; null: unchanged.</param>
public sealed record DesignStepDto(
    Guid Id, DateTime? UpdatedAt, Dictionary<string, JsonElement>? Fields, List<Guid>? NextStepIds);

/// <param name="Id">The processor.</param>
/// <param name="Fields">The changed fields by camelCase name; null: none.</param>
/// <param name="Slots"><c>input</c>, <c>output</c> or <c>config</c> to the id of a copy in <see cref="DesignSaveRequest.Schemas"/>.</param>
public sealed record DesignProcessorDto(Guid Id, Dictionary<string, JsonElement>? Fields, Dictionary<string, Guid>? Slots);

/// <param name="Id">The cache.</param>
/// <param name="Fields">The changed fields by camelCase name; null: none.</param>
public sealed record DesignCacheDto(Guid Id, Dictionary<string, JsonElement>? Fields);

/// <summary>A processor slot's background copy (spec §1.5): a new id, the original's name and version.</summary>
public sealed record DesignSchemaDto(Guid Id, string Name, string Version, string? Description, string Definition);

/// <param name="Id">The assignment (studio-made on create).</param>
/// <param name="StepId">The step the assignment belongs to.</param>
/// <param name="UpdatedAt">The assignment's <c>updatedAt</c> the designer loaded.</param>
/// <param name="Fields">The changed fields by camelCase name; null: none.</param>
/// <param name="Op"><c>create</c> (a new row with this id, linked to the workflow), <c>update</c> or <c>delete</c>.</param>
public sealed record DesignAssignmentDto(
    string Op, Guid Id, Guid StepId, DateTime? UpdatedAt, Dictionary<string, JsonElement>? Fields);

/// <summary>The answer: applied exactly when there are no errors; the design is stored either way.</summary>
public sealed record DesignOutcomeDto(bool Applied, List<DesignErrorDto> Errors);

/// <param name="Id">The entity that failed.</param>
/// <param name="Message">Why.</param>
/// <param name="Kind"><c>schema</c>, <c>processor</c>, <c>cache</c>, <c>step</c>, <c>assignment</c> or <c>workflow</c>.</param>
/// <param name="Stage"><c>schemas</c>, <c>processors</c>, <c>caches</c>, <c>steps</c>, <c>wires</c>, <c>assignments</c> or <c>workflow</c>.</param>
/// <param name="Field">The camelCase field, or null when the error is about the whole entity.</param>
public sealed record DesignErrorDto(string Kind, Guid Id, string Stage, string? Field, string Message);

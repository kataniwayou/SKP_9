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
/// <param name="NewSteps">
/// Steps to create (2026-10-10, copy and paste): new ids from the studio, inserted in the steps stage, their next
/// steps written in the wires stage. Null or absent: none (older studios).
/// </param>
/// <param name="NewCaches">Caches to create in the caches stage; null or absent: none.</param>
/// <param name="DeletedSteps">
/// Steps to remove from this workflow and delete (the deletes stage, last); refused while another workflow still uses
/// one. Null or absent: none.
/// </param>
/// <param name="DeletedCaches">Caches to delete (the deletes stage); refused while any workflow still lists one.</param>
public sealed record DesignSaveRequest(
    DesignWorkflowDto? Workflow,
    List<DesignStepDto>? Steps,
    List<DesignProcessorDto>? Processors,
    List<DesignCacheDto>? Caches,
    List<DesignSchemaDto>? Schemas,
    List<DesignAssignmentDto>? Assignments,
    JsonElement? Layout,
    List<DesignNewStepDto>? NewSteps = null,
    List<DesignNewCacheDto>? NewCaches = null,
    List<DesignDeleteDto>? DeletedSteps = null,
    List<DesignDeleteDto>? DeletedCaches = null);

/// <summary>A step the design creates (a pasted copy): its own new id, the same processor as its original.</summary>
/// <param name="Id">The new step's id, made by the studio; refused when a step with it already exists.</param>
/// <param name="CopyOf">The step it is a copy of (for the log only; may itself be a step of this design); null: none.</param>
/// <param name="ProcessorId">The processor it runs (processors are never copied).</param>
/// <param name="Fields">Its fields by camelCase name (<c>name</c>, <c>version</c>, <c>description</c>, <c>entryCondition</c>).</param>
/// <param name="NextStepIds">Its next steps (written in the wires stage); null or empty: none.</param>
public sealed record DesignNewStepDto(
    Guid Id, Guid? CopyOf, Guid ProcessorId, Dictionary<string, JsonElement>? Fields, List<Guid>? NextStepIds);

/// <summary>A cache the design creates (a pasted copy), with a new id; the workflow's cache list links it.</summary>
/// <param name="Id">The new cache's id; refused when a cache with it already exists.</param>
/// <param name="CopyOf">The cache it is a copy of (for the log only); null: none.</param>
/// <param name="Fields">Its fields by camelCase name (<c>name</c>, <c>version</c>, <c>description</c>, <c>root</c>, <c>items</c>).</param>
public sealed record DesignNewCacheDto(Guid Id, Guid? CopyOf, Dictionary<string, JsonElement>? Fields);

/// <summary>A step or cache the design deletes.</summary>
/// <param name="Id">The entity.</param>
/// <param name="UpdatedAt">A step's <c>updatedAt</c> the designer loaded (steps are owned); null for a cache (shared).</param>
public sealed record DesignDeleteDto(Guid Id, DateTime? UpdatedAt);

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
/// <param name="CopyOf">
/// On create: the assignment this one copies (a pasted step's); the fields it does not name start as that row's.
/// Null or absent: none.
/// </param>
public sealed record DesignAssignmentDto(
    string Op, Guid Id, Guid StepId, DateTime? UpdatedAt, Dictionary<string, JsonElement>? Fields, Guid? CopyOf = null);

/// <summary>The answer: applied exactly when there are no errors; the design is stored either way.</summary>
/// <param name="Applied">True when the dry run found no errors and the transaction committed.</param>
/// <param name="Errors">Every refused entity's error, in the order the stages found them.</param>
/// <param name="Log">
/// What the save did, in order (the studio's Output shows it line by line): the store, each stage's start
/// and its counts, one line per entity it changed, one per refused entity, then the dry run's verdict and
/// the commit or rollback. Null only from an older BaseApi; an addition, so older studios ignore it.
/// </param>
public sealed record DesignOutcomeDto(bool Applied, List<DesignErrorDto> Errors, List<DesignLogDto>? Log = null);

/// <summary>One line of a design save's log.</summary>
/// <param name="Stage"><c>store</c>, one of the seven stages (see <see cref="DesignErrorDto.Stage"/>), or <c>outcome</c>.</param>
/// <param name="Level"><c>info</c> or <c>error</c>.</param>
/// <param name="Kind">The entity kind the line is about, <c>stage</c> for a stage's start and counts, or <c>outcome</c>.</param>
/// <param name="Id">The entity, or null for a stage or outcome line.</param>
/// <param name="Message">What happened, as one sentence.</param>
/// <param name="RolledBack">
/// True on a change line of a save that was rolled back: the stage made the change inside the dry run's transaction,
/// and the rollback undid it, so the entity in the database is as it was.
/// </param>
public sealed record DesignLogDto(string Stage, string Level, string Kind, Guid? Id, string Message, bool RolledBack = false);

/// <param name="Id">The entity that failed.</param>
/// <param name="Message">Why.</param>
/// <param name="Kind"><c>schema</c>, <c>processor</c>, <c>cache</c>, <c>step</c>, <c>assignment</c> or <c>workflow</c>.</param>
/// <param name="Stage"><c>schemas</c>, <c>processors</c>, <c>caches</c>, <c>steps</c>, <c>wires</c>, <c>assignments</c>, <c>workflow</c> or <c>deletes</c>.</param>
/// <param name="Field">The camelCase field, or null when the error is about the whole entity.</param>
public sealed record DesignErrorDto(string Kind, Guid Id, string Stage, string? Field, string Message);

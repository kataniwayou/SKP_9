using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using FluentValidation;
using FluentValidation.Results;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Workflow.Graph;

/// <summary>
/// Applies processor schema-slot edits. A referenced schema's definition is frozen
/// (<see cref="SchemaService.UpdateAsync"/> answers 409), so an edit never updates a schema: it
/// inserts a new version and re-points the slot. Running replicas keep the schema they started with
/// until they restart; each workflow re-checks its own wires when the editor loads it.
/// Stages changes only; the saver saves.
/// </summary>
internal sealed class GraphSchemaEditor
{
    private const int MaxNameLength = 200;
    private static readonly string[] Slots = ["input", "output", "config"];

    private readonly BaseDbContext _db;
    private readonly IValidator<SchemaCreateDto> _schemaValidator;

    public GraphSchemaEditor(BaseDbContext db, IValidator<SchemaCreateDto> schemaValidator)
    {
        _db = db;
        _schemaValidator = schemaValidator;
    }

    public async Task ApplyAsync(IReadOnlyList<GraphSchemaEdit> edits, CancellationToken ct)
    {
        var failures = new List<ValidationFailure>();
        foreach (var edit in edits)
        {
            if (!Slots.Contains(edit.Slot))
            {
                failures.Add(new ValidationFailure($"SchemaEdits[{edit.ProcessorId}].Slot",
                    "Slot must be input, output or config."));
                continue;
            }
            if (edit.Definition is null)
                continue;

            // The definition rules (JSON, a valid draft 2020-12 schema) are the CRUD validator's.
            var probe = new SchemaCreateDto("validation", "1.0.0", null, edit.Definition);
            failures.AddRange((await _schemaValidator.ValidateAsync(probe, ct)).Errors.Select(e =>
                new ValidationFailure($"SchemaEdits[{edit.ProcessorId}].{e.PropertyName}", e.ErrorMessage)));
        }
        if (failures.Count > 0)
            throw new ValidationException(failures);

        foreach (var edit in edits)
        {
            var processor = await _db.Set<ProcessorEntity>().FirstOrDefaultAsync(p => p.Id == edit.ProcessorId, ct)
                ?? throw new NotFoundException(nameof(ProcessorEntity), edit.ProcessorId);

            if (edit.Definition is null)
            {
                SetSlot(processor, edit.Slot, null);
                continue;
            }

            var currentId = GetSlot(processor, edit.Slot);
            var current = currentId is { } id
                ? await _db.Set<SchemaEntity>().AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, ct)
                : null;

            var name = current?.Name ?? $"{processor.Name}-{edit.Slot}";
            var schema = new SchemaEntity
            {
                Id = Guid.NewGuid(),
                Name = name.Length <= MaxNameLength ? name : name[..MaxNameLength],
                Version = current is null ? "1.0.0" : BumpPatch(current.Version),
                Description = current?.Description,
                Definition = edit.Definition,
            };
            _db.Add(schema);
            SetSlot(processor, edit.Slot, schema.Id);
        }
    }

    private static Guid? GetSlot(ProcessorEntity p, string slot) => slot switch
    {
        "input" => p.InputSchemaId,
        "output" => p.OutputSchemaId,
        _ => p.ConfigSchemaId,
    };

    private static void SetSlot(ProcessorEntity p, string slot, Guid? schemaId)
    {
        switch (slot)
        {
            case "input": p.InputSchemaId = schemaId; break;
            case "output": p.OutputSchemaId = schemaId; break;
            default: p.ConfigSchemaId = schemaId; break;
        }
    }

    /// <summary><c>a.b.c</c> becomes <c>a.b.(c+1)</c>; anything else restarts at <c>1.0.0</c>.</summary>
    private static string BumpPatch(string version)
    {
        var parts = version.Split('.');
        return parts.Length == 3
               && int.TryParse(parts[0], out var major)
               && int.TryParse(parts[1], out var minor)
               && int.TryParse(parts[2], out var patch)
            ? $"{major}.{minor}.{patch + 1}"
            : "1.0.0";
    }
}

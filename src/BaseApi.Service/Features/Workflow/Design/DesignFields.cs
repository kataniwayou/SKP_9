using System.Text.Json;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Step;
using FluentValidation.Results;

namespace BaseApi.Service.Features.Workflow.Design;

/// <summary>Why one entity failed: a camelCase field (null: the entity as a whole) and the message.</summary>
internal readonly record struct FieldError(string? Field, string Message);

/// <summary>
/// Lays a design's changed fields over the CRUD update DTO built from the stored row, so the CRUD
/// validators judge exactly what the entity would become (plan 8 §4.3: only their rules decide).
/// </summary>
internal static class DesignFields
{
    private static readonly Dictionary<string, JsonElement> None = new();

    public static WorkflowUpdateDto Apply(WorkflowUpdateDto dto, IReadOnlyDictionary<string, JsonElement>? fields, List<FieldError> errors)
    {
        foreach (var (key, v) in fields ?? None)
            dto = key switch
            {
                "name" => dto with { Name = Text(v, key, errors) ?? "" },
                "version" => dto with { Version = Text(v, key, errors) ?? "" },
                "description" => dto with { Description = Text(v, key, errors) },
                "cronExpression" => dto with { CronExpression = Text(v, key, errors) },
                _ => Unknown(dto, key, errors),
            };
        return dto;
    }

    public static StepUpdateDto Apply(StepUpdateDto dto, IReadOnlyDictionary<string, JsonElement>? fields, List<FieldError> errors)
    {
        foreach (var (key, v) in fields ?? None)
            dto = key switch
            {
                "name" => dto with { Name = Text(v, key, errors) ?? "" },
                "version" => dto with { Version = Text(v, key, errors) ?? "" },
                "description" => dto with { Description = Text(v, key, errors) },
                "entryCondition" => Number(v, key, errors) is { } n ? dto with { EntryCondition = (StepEntryCondition)n } : dto,
                // the processor it runs (2026-10-10); null or empty: the designer removed it, which the stage refuses
                "processorId" => dto with { ProcessorId = Id(v, key, errors) ?? Guid.Empty },
                _ => Unknown(dto, key, errors),
            };
        return dto;
    }

    public static ProcessorUpdateDto Apply(ProcessorUpdateDto dto, IReadOnlyDictionary<string, JsonElement>? fields, List<FieldError> errors)
    {
        foreach (var (key, v) in fields ?? None)
            dto = key switch
            {
                "name" => dto with { Name = Text(v, key, errors) ?? "" },
                "version" => dto with { Version = Text(v, key, errors) ?? "" },
                "description" => dto with { Description = Text(v, key, errors) },
                "sourceHash" => dto with { SourceHash = Text(v, key, errors) ?? "" },
                "instanceId" => dto with { InstanceId = Text(v, key, errors) },
                _ => Unknown(dto, key, errors),
            };
        return dto;
    }

    public static CacheUpdateDto Apply(CacheUpdateDto dto, IReadOnlyDictionary<string, JsonElement>? fields, List<FieldError> errors)
    {
        foreach (var (key, v) in fields ?? None)
            dto = key switch
            {
                "name" => dto with { Name = Text(v, key, errors) ?? "" },
                "version" => dto with { Version = Text(v, key, errors) ?? "" },
                "description" => dto with { Description = Text(v, key, errors) },
                "root" => dto with { Root = Text(v, key, errors) ?? "" },
                "items" => dto with { Items = Text(v, key, errors) ?? "" },
                _ => Unknown(dto, key, errors),
            };
        return dto;
    }

    public static AssignmentUpdateDto Apply(AssignmentUpdateDto dto, IReadOnlyDictionary<string, JsonElement>? fields, List<FieldError> errors)
    {
        foreach (var (key, v) in fields ?? None)
            dto = key switch
            {
                "name" => dto with { Name = Text(v, key, errors) ?? "" },
                "version" => dto with { Version = Text(v, key, errors) ?? "" },
                "description" => dto with { Description = Text(v, key, errors) },
                "payload" => dto with { Payload = Text(v, key, errors) ?? "" },
                _ => Unknown(dto, key, errors),
            };
        return dto;
    }

    /// <summary>The update DTO a step's PUT would send unchanged; next steps travel separately (stage 5).</summary>
    public static StepUpdateDto UpdateOf(StepEntity e) => new(e.Name, e.Version, e.Description, e.ProcessorId, null, e.EntryCondition);

    public static ProcessorUpdateDto UpdateOf(ProcessorEntity e) =>
        new(e.Name, e.Version, e.Description, e.SourceHash, e.InstanceId, e.InputSchemaId, e.OutputSchemaId, e.ConfigSchemaId);

    public static CacheUpdateDto UpdateOf(CacheEntity e) => new(e.Name, e.Version, e.Description, e.Root, e.Items);

    public static AssignmentUpdateDto UpdateOf(AssignmentEntity e) => new(e.Name, e.Version, e.Description, e.StepId, e.Payload);

    /// <summary>A validator's failures as field errors (<c>SourceHash</c> → <c>sourceHash</c>).</summary>
    public static List<FieldError> Failures(ValidationResult result) =>
        result.Errors.Select(e => new FieldError(FieldOf(e.PropertyName), e.ErrorMessage)).ToList();

    /// <summary>A C# property name or a snake_case column as the studio's camelCase field name.</summary>
    public static string FieldOf(string name)
    {
        var parts = name.Split('_', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return name;
        var head = char.ToLowerInvariant(parts[0][0]) + parts[0][1..];
        return head + string.Concat(parts.Skip(1).Select(p => char.ToUpperInvariant(p[0]) + p[1..]));
    }

    private static string? Text(JsonElement v, string key, List<FieldError> errors)
    {
        switch (v.ValueKind)
        {
            case JsonValueKind.String: return v.GetString();
            case JsonValueKind.Null: return null;
            default: errors.Add(new FieldError(key, $"{key} must be text or null.")); return null;
        }
    }

    /// <summary>The message a step with no processor is refused with (2026-10-10).</summary>
    public const string NoProcessor = "No processor: drag one from the toolbox.";

    private static Guid? Id(JsonElement v, string key, List<FieldError> errors)
    {
        switch (v.ValueKind)
        {
            case JsonValueKind.Null: return null;
            case JsonValueKind.String when v.GetString() is { Length: 0 }: return null;
            case JsonValueKind.String when Guid.TryParse(v.GetString(), out var id): return id;
            default: errors.Add(new FieldError(key, $"{key} must be an id or null.")); return null;
        }
    }

    private static int? Number(JsonElement v, string key, List<FieldError> errors)
    {
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n)) return n;
        errors.Add(new FieldError(key, $"{key} must be a whole number."));
        return null;
    }

    private static T Unknown<T>(T dto, string key, List<FieldError> errors)
    {
        errors.Add(new FieldError(key, $"Unknown field '{key}'."));
        return dto;
    }
}

using System.Text;
using System.Text.Json;
using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Core.Services;
using BaseApi.Service.Features.Processor;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Schema;

/// <summary>
/// Service for <see cref="SchemaEntity"/>. The schema has no junction tables, so the locked create
/// order is inherited unchanged.
/// <para>
/// <b>A definition is frozen once referenced.</b> <see cref="UpdateAsync"/> is overridden to reject a
/// definition change on a schema any processor references, with a 409. Only the definition is frozen:
/// name and description edits, and an update that leaves the definition unchanged, pass through.
/// </para>
/// </summary>
public sealed class SchemaService :
    BaseService<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto>
{
    public SchemaService(
        IValidator<SchemaCreateDto> createValidator,
        IValidator<SchemaUpdateDto> updateValidator,
        IEntityMapper<SchemaEntity, SchemaCreateDto, SchemaUpdateDto, SchemaReadDto> mapper,
        IRepository<SchemaEntity> repo,
        BaseDbContext dbContext)
        : base(createValidator, updateValidator, mapper, repo, dbContext) { }

    /// <summary>
    /// Layers the frozen-once-referenced precondition in front of the inherited verb order. The check
    /// has to run before the base call, because that call mutates the entity through the mapper and
    /// the pre-mutation definition is gone by then.
    /// </summary>
    public override async Task<SchemaReadDto> UpdateAsync(Guid id, SchemaUpdateDto dto, CancellationToken ct)
    {
        var existing = await DbContext.Set<SchemaEntity>().AsNoTracking()
            .FirstOrDefaultAsync(s => s.Id == id, ct);

        // Only the definition is frozen. A re-submission of the same schema may differ from the stored
        // text in whitespace, key order or number spelling (and rows written while the column was jsonb
        // were normalized by Postgres), so the two are compared as canonical JSON rather than raw bytes.
        // That is what stops a name-only re-submission of the same body looking like a definition change
        // and falsely returning 409.
        if (existing is not null && DefinitionChanged(existing.Definition, dto.Definition))
        {
            // All three schema roles count as referenced. Assignments carry no direct schema foreign
            // key, so querying the processor is sufficient.
            var referenced = await DbContext.Set<ProcessorEntity>().AsNoTracking().AnyAsync(
                p => p.InputSchemaId == id || p.OutputSchemaId == id || p.ConfigSchemaId == id, ct);
            if (referenced)
                throw new SchemaDefinitionFrozenException(id);
        }

        // A missing id, a name or description edit, and an unchanged definition all flow through.
        return await base.UpdateAsync(id, dto, ct);
    }

    /// <summary>
    /// True only when the incoming body is a semantically different schema from the stored one.
    /// The stored text may differ from the request body in whitespace, key order and number spelling
    /// without meaning anything else (rows written while the column was jsonb were normalized on write),
    /// so an ordinal compare alone produces false positives. Both values are already-validated JSON, so they are canonicalized and compared. A value
    /// that fails to parse is treated as changed — conservative, preferring to freeze over silently
    /// letting a change through.
    /// </summary>
    private static bool DefinitionChanged(string? stored, string? incoming)
    {
        if (string.Equals(stored, incoming, StringComparison.Ordinal)) return false;
        if (stored is null || incoming is null) return true;
        try
        {
            using var a = JsonDocument.Parse(stored);
            using var b = JsonDocument.Parse(incoming);
            return !string.Equals(Canonicalize(a.RootElement), Canonicalize(b.RootElement), StringComparison.Ordinal);
        }
        catch (JsonException)
        {
            return true;
        }
    }

    /// <summary>Compact JSON with object keys recursively sorted. Array order is preserved, because it
    /// is significant.</summary>
    private static string Canonicalize(JsonElement element)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            WriteCanonical(writer, element);
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var prop in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(prop.Name);
                    WriteCanonical(writer, prop.Value);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray())
                    WriteCanonical(writer, item);
                writer.WriteEndArray();
                break;
            case JsonValueKind.Number:
                // The same number can be spelled 3.140 or 3.14, 1e3 or 1000 (and jsonb, the column's
                // earlier type, rewrote them so), so an ordinal compare of the raw token false-positives. Re-emitting through the
                // shortest round-trippable form applies the same normalization to both sides, so
                // semantically equal numbers always canonicalize equal.
                if (element.TryGetDouble(out var d))
                    writer.WriteNumberValue(d);
                else
                    element.WriteTo(writer);
                break;
            default:
                element.WriteTo(writer);
                break;
        }
    }
}

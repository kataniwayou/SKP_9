using BaseApi.Core.Entities;

namespace BaseApi.Service.Features.Schema;

/// <summary>
/// Schema domain entity — the root of the entity foreign-key graph, referenced by a processor's
/// input, output and config schema ids.
/// <para>
/// <c>Definition</c> stores a JSON Schema document as a Postgres <c>jsonb</c> column, wired by
/// <c>SchemaEntityConfiguration</c>. The validator parses the value and evaluates it against the
/// draft 2020-12 meta-schema before it is persisted.
/// </para>
/// </summary>
public sealed class SchemaEntity : BaseEntity
{
    public string Definition { get; set; } = string.Empty;
}

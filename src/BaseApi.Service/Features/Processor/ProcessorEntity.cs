using BaseApi.Core.Entities;

namespace BaseApi.Service.Features.Processor;

/// <summary>
/// Processor domain entity — one level below the schema in the foreign-key topology and one level
/// above the step.
/// <para>
/// <c>SourceHash</c> is a lowercase 64-character SHA-256 hex string identifying the processor
/// implementation. Its unique index is load-bearing: it is what turns a duplicate registration into
/// SQLSTATE 23505 and therefore a 409.
/// </para>
/// <para>
/// The three schema ids are nullable, which supports source processors with no input, sink
/// processors with no output, and unconfigured processors with no config. The foreign keys are still
/// enforced whenever a value is present, and their constraint names follow the
/// <c>fk_&lt;owner&gt;_&lt;column&gt;</c> convention the exception mapper parses.
/// </para>
/// </summary>
public sealed class ProcessorEntity : BaseEntity
{
    public string SourceHash { get; set; } = string.Empty;
    public Guid? InputSchemaId { get; set; }
    public Guid? OutputSchemaId { get; set; }
    public Guid? ConfigSchemaId { get; set; }
}

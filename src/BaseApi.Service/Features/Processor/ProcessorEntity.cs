using BaseApi.Core.Entities;

namespace BaseApi.Service.Features.Processor;

/// <summary>
/// Processor domain entity — one level below the schema in the foreign-key topology and one level
/// above the step.
/// <para>
/// <c>SourceHash</c> is a lowercase 64-character SHA-256 hex string identifying the processor
/// implementation. It is deliberately <b>not</b> unique on its own: several rows may share one hash,
/// which is what lets the pods of a StatefulSet run the same build while each holding an identity of
/// its own. What is unique is the pair with <see cref="InstanceId"/>; see
/// <c>ProcessorEntityConfiguration</c> for the two partial indexes that enforce it.
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
    private string? _instanceId;

    public string SourceHash { get; set; } = string.Empty;

    /// <summary>
    /// The replica identity this row belongs to, or null when the row is shared by every replica of
    /// its build. A StatefulSet pod carries its stable ordinal name here (<c>fetcher-0</c>); a
    /// Deployment replica carries nothing, because its pod name is regenerated on every restart and
    /// would orphan a row each time.
    /// <para>
    /// <b>Blank normalizes to null on assignment, and that is load-bearing.</b> The uniqueness rule
    /// is one row per <c>(SourceHash, InstanceId)</c> counting "no instance" as a value, and Postgres
    /// treats two NULLs in a unique index as distinct. The rule is therefore split across two partial
    /// indexes keyed on <c>instance_id IS NULL</c> — so an empty string reaching the column would be
    /// a second spelling of "no instance" that sits in the other index and collides with nothing.
    /// Normalizing here rather than in the service puts the invariant on the data, where no write
    /// path can route around it.
    /// </para>
    /// <para>
    /// Surrounding whitespace is trimmed for the same reason one step further out: the pod-side value
    /// arrives through an environment variable, where a stray space is easy to introduce and
    /// invisible to read. Trimming on both sides keeps a registration made through the API and a
    /// lookup made from a manifest comparing equal.
    /// </para>
    /// </summary>
    public string? InstanceId
    {
        get => _instanceId;
        set => _instanceId = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    public Guid? InputSchemaId { get; set; }
    public Guid? OutputSchemaId { get; set; }
    public Guid? ConfigSchemaId { get; set; }
}

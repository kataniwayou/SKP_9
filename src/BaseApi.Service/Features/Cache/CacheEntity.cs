using BaseApi.Core.Entities;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// Cache domain entity — a named dictionary a workflow projects into L2 for the duration of a run.
/// <para>
/// It sits beside <c>SchemaEntity</c> as a second root of the foreign-key graph: it references
/// nothing, and is referenced only through the <c>WorkflowCaches</c> junction.
/// </para>
/// <para>
/// <c>Items</c> stores a flat JSON object of string to string as a Postgres <c>jsonb</c> column,
/// wired by <c>CacheEntityConfiguration</c>. The validator enforces the shape — an object, string
/// values, no empty or colon-bearing keys — before it is persisted.
/// </para>
/// <para>
/// <b>Neither <c>Root</c> nor any key may contain a colon, and that is load-bearing.</b> The L2
/// address is built by concatenating the root, a colon and the key, so a colon inside either half
/// forges a different address: root <c>a</c> with key <c>b:c</c> and root <c>a:b</c> with key
/// <c>c</c> produce one string. <c>Root</c> is unique across the table for the same reason — it
/// appears verbatim in the address, so two rows sharing one would have the second write silently
/// overwrite the first.
/// </para>
/// </summary>
public sealed class CacheEntity : BaseEntity
{
    private string _root = string.Empty;

    /// <summary>
    /// The key prefix this dictionary is projected under. Trimmed on assignment, following
    /// <c>ProcessorEntity.InstanceId</c> — the invariant goes on the data, where no write path can
    /// route around it.
    /// <para>
    /// Unlike <c>InstanceId</c>, blank is <b>not</b> normalized to null: "no root" is not a
    /// meaningful state here, so the validator refuses it and the column is required.
    /// </para>
    /// </summary>
    public string Root
    {
        get => _root;
        set => _root = value?.Trim() ?? string.Empty;
    }

    public string Items { get; set; } = string.Empty;
}

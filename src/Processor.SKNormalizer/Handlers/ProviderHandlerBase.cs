namespace Processor.SKNormalizer;

/// <summary>
/// Defaults for the stages most providers will not vary. A convenience only: the INTERFACE is the
/// contract, and nothing may bind to this type.
/// </summary>
public abstract class ProviderHandlerBase : IProviderHandler
{
    public abstract string Name { get; }

    public abstract IReadOnlyList<SourceItem> Locate(FileNode root);

    public virtual void ValidateContent(SourceItem item)
    {
    }

    public virtual StandardMetadata Map(SourceItem item) => new();

    public virtual void Augment(StandardMetadata metadata, SourceItem item)
    {
    }

    public virtual ItemNames NameFor(StandardMetadata metadata, SourceItem item)
        => new($"{item.Key}.xml", $"{item.Key}");

    public virtual AudioProfile? ProfileFor(SourceItem item) => null;

    public virtual void Reconcile(StandardMetadata metadata, NormalizedAudio? audio, ItemNames names)
    {
    }

    // REPLACED IN TASK 4 by the topology-preserving mirror. Left abstract-in-spirit here so this
    // task's tests compile; no handler ships against this version.
    public virtual OutputLayout LayoutFor(FileNode root, IReadOnlyList<NormalizedItem> items)
        => new(root.Metadata.Name, root.Metadata.Extension, root.Metadata.SizeBytes, root.Metadata.CreatedUtc, root.Metadata.ModifiedUtc, null);
}

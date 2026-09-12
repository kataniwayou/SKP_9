namespace Processor.SKNormalizer;

/// <summary>
/// The metadata document under construction — an ORDERED list of name/value elements that stages 3,
/// 4 and 7 build up and <c>XmlMetadataRenderer</c> turns into XML.
/// <para>
/// <b>Ordered, and that is deliberate.</b> A standardized file whose element order varies between
/// runs is not comparable, and diffing two outputs is the cheapest way an operator checks a handler.
/// <c>Set</c> overwrites in place rather than appending, so a stage-7 correction of a stage-3 value
/// does not move it.
/// </para>
/// <para>
/// <b>Flat, not a tree, and that is a decision this phase can revisit.</b> No element vocabulary is
/// designed yet (the design's §12), so nesting would be speculative structure. The first real handler
/// is what decides whether this needs to become a tree.
/// </para>
/// </summary>
public sealed class StandardMetadata
{
    private readonly List<KeyValuePair<string, string>> _elements = [];

    /// <summary>The XML root element name. Defaulted so a handler that does not care need not say.</summary>
    public string RootName { get; set; } = "metadata";

    public IReadOnlyList<KeyValuePair<string, string>> Elements => _elements;

    public bool IsEmpty => _elements.Count == 0;

    /// <summary>Sets an element, overwriting in place if it is already present.</summary>
    public void Set(string name, string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(value);

        var index = _elements.FindIndex(e => e.Key.Equals(name, StringComparison.Ordinal));

        if (index >= 0)
        {
            _elements[index] = new KeyValuePair<string, string>(name, value);
            return;
        }

        _elements.Add(new KeyValuePair<string, string>(name, value));
    }
}

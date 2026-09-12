namespace Processor.SKNormalizer;

/// <summary>
/// The seam for the deferred Redis-backed metadata field whitelist. A handler that needs to know
/// whether a field may be carried into the standardized document asks this.
/// <para>
/// <b>Registered now as a pass-through, with no handler consuming it yet</b>, so that backing it
/// with Redis later is a registration swap rather than a reshaping of stages 3 and 4.
/// </para>
/// </summary>
public interface IFieldWhitelist
{
    bool Allows(string field);
}

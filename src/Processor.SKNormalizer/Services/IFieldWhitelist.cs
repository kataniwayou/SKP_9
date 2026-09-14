namespace Processor.SKNormalizer;

/// <summary>
/// The per-dispatch metadata field whitelist, backed by the dictionary a workflow projects into L2.
/// A handler that gates a field on an approved list asks this.
/// <para>
/// <b>It returns a value, not just a verdict, and that is the point.</b> The projected dictionary is
/// key/value: the key is the raw field as the provider wrote it, the value is what the standardized
/// document should carry instead. So a hit both admits the field and supplies its canonical form,
/// which is why this is <c>TryGet</c> rather than the <c>Allows</c> predicate that stood here while
/// the backing store was undesigned.
/// </para>
/// <para>
/// <b>Implementations are built per dispatch, not resolved from the container.</b> The address they
/// read lives on the step payload, so it differs between two steps of the same workflow and between
/// two workflows sharing a processor — there is no single instance that could be registered.
/// </para>
/// </summary>
public interface IFieldWhitelist
{
    /// <summary>
    /// Looks <paramref name="field"/> up in the projected dictionary. Returns true and sets
    /// <paramref name="value"/> to the canonical form when the field is listed; returns false and
    /// leaves <paramref name="value"/> null when it is not.
    /// </summary>
    bool TryGet(string field, out string? value);
}

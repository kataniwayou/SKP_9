using Processor.SKNormalizer;

namespace BaseApi.Tests.SKNormalizer;

/// <summary>
/// Whitelist doubles for the handler and pipeline tests.
/// <para>
/// These exist so a test that is not about the whitelist does not have to reach Redis to exercise a
/// stage that now takes one. <see cref="FieldWhitelists.AdmitAll"/> is the identity list — every
/// field is listed and maps to itself — which keeps the pre-existing tests asserting exactly what
/// they asserted before the gate was added.
/// </para>
/// </summary>
internal static class FieldWhitelists
{
    /// <summary>Lists every field and canonicalizes nothing.</summary>
    public static IFieldWhitelist AdmitAll { get; } = new IdentityWhitelist();

    /// <summary>Lists exactly the given pairs, ordinally.</summary>
    public static IFieldWhitelist Mapping(params (string Field, string Value)[] pairs)
        => new DictionaryWhitelist(pairs.ToDictionary(p => p.Field, p => p.Value, StringComparer.Ordinal));

    /// <summary>Lists nothing at all — every lookup misses.</summary>
    public static IFieldWhitelist Empty { get; } =
        new DictionaryWhitelist(new Dictionary<string, string>(StringComparer.Ordinal));

    private sealed class IdentityWhitelist : IFieldWhitelist
    {
        public bool TryGet(string field, out string? value)
        {
            value = field;
            return true;
        }
    }

    private sealed class DictionaryWhitelist(IReadOnlyDictionary<string, string> entries) : IFieldWhitelist
    {
        public bool TryGet(string field, out string? value)
        {
            var found = entries.TryGetValue(field, out var stored);
            value = found ? stored : null;
            return found;
        }
    }
}

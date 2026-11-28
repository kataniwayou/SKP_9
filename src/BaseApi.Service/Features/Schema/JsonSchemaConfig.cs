using System.Collections.Concurrent;
using Json.Schema;

namespace BaseApi.Service.Features.Schema;

/// <summary>
/// The single place JSON Schema evaluation is configured, consumed by the schema validators and by
/// the payload-against-config-schema validator.
///
/// <para>
/// <b>The static constructor is the security control.</b> It runs once on first member access and
/// does two things: it sets the dialect to draft 2020-12, because the library defaults to an older
/// one; and it pins the registry's fetch delegate to return null, which blocks server-side request
/// forgery through an external <c>$ref</c>. Any consumer that evaluates a schema must touch a member
/// of this type — <see cref="DefaultOptions"/> is the natural one — so the constructor fires before
/// evaluation. If nothing ever touches it, the constructor never runs and the lockdown silently
/// regresses.
/// </para>
///
/// <para>
/// <b>This type is deliberately duplicated by
/// <c>BaseProcessor.Core/Validation/ProcessorJsonSchemaValidator.cs</c></b> — same
/// <c>Dialect.Default</c>, same <c>SchemaRegistry.Global.Fetch</c> lockdown, same options. Both mutate
/// process-global library state, and neither can call the other: they live in assemblies that must not
/// reference each other, since a worker host must not load the web stack. <b>The two must stay in
/// sync.</b> A dialect or fetch setting changed here and not there means the same schema row evaluates
/// differently on the API side and the processor side — a divergence no test on either side would
/// catch alone.
/// </para>
/// </summary>
public static class JsonSchemaConfig
{
    static JsonSchemaConfig()
    {
        // The library's default dialect is an older draft, so set it explicitly.
        Dialect.Default = Dialect.Draft202012;
        // Defence in depth: an explicit no-op fetch, even though the library default already is one.
        SchemaRegistry.Global.Fetch = (_, _) => null;
    }

    /// <summary>
    /// Shared evaluation options. Referencing this property is what fires the static constructor and
    /// therefore applies the dialect and fetch lockdown.
    /// </summary>
    public static EvaluationOptions DefaultOptions { get; } = new() { OutputFormat = OutputFormat.List };

    /// <summary>
    /// The most distinct definitions <see cref="Parse"/> holds before it starts over. The API sees
    /// one per schema row a validation touches; this bound is what makes a static cache safe however
    /// many rows exist or are edited.
    /// </summary>
    internal const int MaxCachedDefinitions = 256;

    // Each parsed schema, keyed by its definition text (ordinal: one changed byte is another schema).
    private static readonly ConcurrentDictionary<string, JsonSchema> Schemas = new(StringComparer.Ordinal);

    /// <summary>
    /// The schema for <paramref name="definition"/>, parsed once per process and reused. Throws what
    /// <c>JsonSchema.FromText</c> throws for a definition that is not a schema; a failure is not
    /// cached.
    /// <para>
    /// <b>Why not <c>JsonSchema.FromText(definition)</c> (2026-11-28).</b> The library gives a schema
    /// without an absolute <c>$id</c> a random base URI and registers it in
    /// <c>SchemaRegistry.Global</c>, which never lets go, so every parse kept about 2 KB for the
    /// life of the process. On the processor side that ran the kafka-importer out of memory; here
    /// each start and validation kept one per config schema it read. Parsing once stops the growth,
    /// and parsing into a registry of the schema's own (same no-op <c>Fetch</c>, dialect passed
    /// explicitly) means a schema dropped at <see cref="MaxCachedDefinitions"/> is collected.
    /// Mirrors <c>ProcessorJsonSchemaValidator.Parsed</c>; <b>keep the two in sync</b>, as above.
    /// </para>
    /// </summary>
    public static JsonSchema Parse(string definition)
    {
        ArgumentNullException.ThrowIfNull(definition);
        if (Schemas.TryGetValue(definition, out var cached))
        {
            return cached;
        }

        var own = new SchemaRegistry { Fetch = (_, _) => null };   // no outbound $ref fetch, as globally
        var schema = JsonSchema.FromText(definition, new BuildOptions { SchemaRegistry = own, Dialect = Dialect.Default });
        if (Schemas.Count >= MaxCachedDefinitions)
        {
            Schemas.Clear();
        }

        return Schemas.GetOrAdd(definition, schema);
    }

    /// <summary>How many definitions are cached. Test seam.</summary>
    internal static int CachedDefinitionCount => Schemas.Count;
}

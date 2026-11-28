using System.Collections.Concurrent;
using System.Text.Json;
using Json.Schema;

namespace BaseProcessor.Core.Validation;

/// <summary>
/// Validates a payload against a schema definition, returning a verdict rather than throwing.
/// <para>
/// <b>A bool, not an exception, because the caller is a message handler.</b> The API-side validator
/// throws to become an HTTP 422; here an invalid payload is an ordinary step outcome that gets
/// reported and acknowledged. Turning it into an exception would put it on the path that parks
/// messages.
/// </para>
/// <para>
/// <b>Outbound reference resolution is disabled process-wide.</b> A schema definition arrives from a
/// database row, so an external <c>$ref</c> would let whoever wrote that row make this process issue
/// requests to a host of their choosing from inside a message handler. With the global fetcher
/// returning null the library raises instead, and that surfaces as a business failure.
/// </para>
/// <para>
/// <b>The static constructor and <see cref="DefaultOptions"/> here are a deliberate duplicate of
/// <c>BaseApi.Service/Features/Schema/JsonSchemaConfig.cs</c></b> — same <c>Dialect.Default</c>, same
/// <c>SchemaRegistry.Global.Fetch</c> lockdown, same options. Both mutate process-global library
/// state, and they are duplicated rather than shared because they live in assemblies that must not
/// reference each other: a processor host does not load <c>BaseApi.Service</c>, and a validator that
/// did would drag the web stack into a worker. <b>The two must stay in sync.</b> A dialect or fetch
/// setting changed in one and not the other means the same schema row evaluates differently on the
/// API side and the processor side — a divergence no test on either side would catch alone.
/// </para>
/// </summary>
public static class ProcessorJsonSchemaValidator
{
    static ProcessorJsonSchemaValidator()
    {
        Dialect.Default = Dialect.Draft202012;          // the library default is V1, not 2020-12
        SchemaRegistry.Global.Fetch = (_, _) => null;   // no outbound $ref fetch
    }

    /// <summary>
    /// Shared evaluation options.
    /// <para>
    /// The lockdown is guaranteed by this type having an <i>explicit</i> static constructor, which
    /// disables <c>beforefieldinit</c> and so runs before any static member access — including
    /// <see cref="TryValidate"/> itself. Touching this property is not what arms it.
    /// </para>
    /// </summary>
    public static EvaluationOptions DefaultOptions { get; } = new() { OutputFormat = OutputFormat.List };

    /// <summary>
    /// The most distinct definitions <see cref="Parsed"/> holds before it starts over. A processor
    /// sees a handful (its config, input and output schemas, and the next version of each after a
    /// re-registration), so this is only reached by churn no deployment produces. It is the bound
    /// that makes the cache safe to be static.
    /// </summary>
    internal const int MaxCachedDefinitions = 64;

    // Each parsed schema, keyed by its definition text (ordinal: one changed byte is another schema).
    private static readonly ConcurrentDictionary<string, JsonSchema> Schemas = new(StringComparer.Ordinal);

    /// <summary>
    /// The schema for <paramref name="definition"/>, parsed once per process and reused.
    /// <para>
    /// <b>Parsing per call leaked (found live 2026-11-28).</b> <c>JsonSchema.FromText</c> gives a
    /// schema without an absolute <c>$id</c> a random base URI (<c>https://json-everything.lib/{guid}</c>)
    /// and registers it in <c>SchemaRegistry.Global</c>, which never lets go. Called on every
    /// dispatch's input and every branch's output, that kept about 2 KB a message: a collapser heap
    /// held 17,385 registrations after 8,656 dispatches, and the kafka-importer ran out of memory at
    /// 384Mi and failed its steps.
    /// </para>
    /// <para>
    /// <b>Two halves, each needed.</b> Parsing once per definition stops the per-message growth.
    /// Parsing into a registry of the schema's own, not the global one, means nothing outside the
    /// cache holds a schema, so one dropped at <see cref="MaxCachedDefinitions"/> is collected: a
    /// bound on the cache is then a bound on memory. That registry gets the same no-op
    /// <c>Fetch</c> as the global one, set explicitly: a new registry's default is a non-null
    /// delegate (it made no request when tried on 9.2.1, but that is the library's choice to change),
    /// and the lockdown must not rest on it. The dialect is passed explicitly for the same reason. Outcomes are unchanged: local and remote <c>$ref</c>, an absolute <c>$id</c> and
    /// 2020-12 keywords evaluate the same either way (checked 2026-11-28 on 9.2.1).
    /// </para>
    /// <para>
    /// <b>Sharing a parsed schema is safe.</b> JsonSchema.Net 8+ builds a schema once and evaluates it
    /// without mutating it; 200,000 evaluations of one schema on 16 threads gave the same results as
    /// a fresh parse each time. A definition that fails to parse throws here, is not cached and
    /// registers nothing, so the caller's error path is unchanged and re-parsing it cannot leak.
    /// </para>
    /// </summary>
    private static JsonSchema Parsed(string definition)
    {
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

    /// <summary>
    /// True when <paramref name="data"/> satisfies <paramref name="definition"/>. A null or
    /// whitespace definition skips validation and returns true — bytes are never decoded without a
    /// schema asking for it. Every failure path fills <paramref name="errors"/> and returns false;
    /// <b>none of them throw, for any input.</b>
    /// </summary>
    public static bool TryValidate(string? definition, byte[] data, out IReadOnlyList<string> errors)
    {
        errors = [];

        if (string.IsNullOrWhiteSpace(definition))
        {
            return true;
        }

        // The outer net. The specific catches below produce better diagnostics for the cases worth
        // naming, but the JSON Schema keyword surface is large and each keyword may throw its own
        // type from deep inside the library: a bad `pattern` regex raises RegexParseException from
        // FromText, and a definition that is valid JSON but not an object or boolean at the root
        // raises ArgumentException. Enumerating them is a losing game, and losing it means an
        // exception escapes into a message handler that will then PARK the message instead of
        // reporting a failed step — the one outcome this method exists to prevent. A malformed row in
        // the schema table must always be a business failure, never a crash.
        try
        {
            JsonSchema schema;
            try
            {
                schema = Parsed(definition);
            }
            catch (Exception ex) when (ex is JsonException or JsonSchemaException)
            {
                errors = ["Schema definition is not valid JSON Schema."];
                return false;
            }

            JsonDocument doc;
            try
            {
                doc = JsonDocument.Parse(data);
            }
            catch (JsonException)
            {
                errors = ["Data is not valid JSON/UTF-8."];
                return false;
            }

            using (doc)
            {
                EvaluationResults results;
                try
                {
                    results = schema.Evaluate(doc.RootElement, DefaultOptions);
                }
                catch (JsonSchemaException)
                {
                    // An unresolvable $ref — the lockdown holding, not a fault to crash on.
                    errors = ["Schema definition could not be evaluated (unresolved $ref)."];
                    return false;
                }

                if (results.IsValid)
                {
                    return true;
                }

                errors = Flatten(results);
                return false;
            }
        }
        catch
        {
            errors = ["Schema definition could not be evaluated."];
            return false;
        }
    }

    /// <summary>
    /// Turns a failed evaluation into instance locations and keyword names — and nothing else.
    /// <para>
    /// <b>The library's own error text is deliberately discarded.</b> Several keywords embed the
    /// offending instance value in their message: <c>minimum</c> renders "-999888 should be at least
    /// 18", <c>maximum</c> and <c>multipleOf</c> likewise. A payload's account balance, age or numeric
    /// token would land wherever these strings land. Which keywords do this is a property of the
    /// library version, not of anything we control, so an allow-list of "safe" messages would need
    /// re-auditing on every upgrade. Location plus keyword says where and which rule, is sufficient to
    /// diagnose, and cannot leak by construction.
    /// </para>
    /// <para>
    /// These strings no longer reach the orchestrator — a <c>StepOutcome</c> has no text field — but
    /// they are logged by both handlers, which is the only record of why a step failed. So the
    /// discipline still holds, against a log rather than a projection: an operator's log store is not
    /// a place to put a payload either.
    /// </para>
    /// <para>
    /// <b>A KEYWORD IS NOT ALWAYS THERE, AND AN ENTRY WITHOUT ONE SAYS NOTHING.</b> The library keys
    /// its <c>Errors</c> dictionary by keyword for most failures, but reports an
    /// <c>additionalProperties</c> violation under the EMPTY key — so a document carrying one unknown
    /// property used to flatten to <c>"/providerName: "</c>, a pointer, a colon and nothing. A live
    /// run on 2026-09-12 logged a rejected record as <c>": required; /path: "</c>, which names no rule
    /// at either location. <see cref="Keyword"/> fills the gap from <c>EvaluationPath</c>, the pointer
    /// into the SCHEMA that located the failing subschema — schema vocabulary by construction, so it
    /// carries no instance data and the discipline above is untouched.
    /// </para>
    /// <para>
    /// <b>What this still does not say.</b> For <c>required</c>, the MISSING PROPERTY'S NAME lives in
    /// the discarded message ("Required properties [filePath] are not present") and nowhere else the
    /// results expose. Those names come from the schema, not the instance, so quoting them would be
    /// safe — but only for this keyword, and deciding that per keyword is the version-pinned
    /// allow-list the paragraph above rejects. So <c>required</c> still reports the rule and the
    /// location without the name, and that is a knowing trade rather than an oversight.
    /// </para>
    /// </summary>
    private static List<string> Flatten(EvaluationResults results)
    {
        var flat = (results.Details ?? [])
            .Where(d => d.Errors is { Count: > 0 })
            .SelectMany(d => d.Errors!.Select(
                kv => $"{d.InstanceLocation}: {Keyword(kv.Key, d.EvaluationPath.ToString())}"))
            .ToList();

        if (flat.Count == 0 && results.Errors is { Count: > 0 })
        {
            flat = results.Errors
                .Select(kv =>
                    $"{results.InstanceLocation}: {Keyword(kv.Key, results.EvaluationPath.ToString())}")
                .ToList();
        }

        return flat;
    }

    /// <summary>
    /// The keyword the library reported, or — when it reported none — the last segment of the
    /// evaluation path, which is the keyword that located the failing subschema.
    /// <para>
    /// <c>EvaluationPath</c> is a pointer into the schema document (<c>/additionalProperties</c>,
    /// <c>/properties/filePath/minLength</c>), so every segment is schema vocabulary. It can no more
    /// carry a payload value than the schema itself can.
    /// </para>
    /// </summary>
    private static string Keyword(string reported, string evaluationPath)
    {
        if (!string.IsNullOrEmpty(reported))
        {
            return reported;
        }

        var segments = evaluationPath.Split('/', StringSplitOptions.RemoveEmptyEntries);

        // An empty keyword at the schema root is the whole document failing rather than one rule.
        return segments.Length > 0 ? segments[^1] : "schema";
    }
}

using System.Reflection;
using System.Text.Json;
using BaseProcessor.Core.Configuration;

namespace BaseProcessor.Core.Startup;

/// <summary>
/// Checks that a registered config schema actually describes this processor's own config record.
/// <para>
/// <b>This is the reason the config definition is fetched at all.</b> Until now it was resolved at
/// startup and read by exactly one line — the liveness summary — so <c>configSchema: SUCCESS</c>
/// meant "a string arrived", not "the row describes this processor". BaseApi already validates a
/// step's PAYLOAD against the schema, at orchestration start, in
/// <c>PayloadConfigSchemaValidator</c>; what nothing checked is whether the schema it validates
/// against matches the record the payload is finally bound to. A row that disagrees with the type
/// fails CLOSED in the least useful way: it rejects payloads the processor would have accepted, at
/// start, with a 422 naming the assignment rather than the schema.
/// </para>
/// <para>
/// <b>BaseProcessor is the only place this can run.</b> BaseApi holds the schema and the payload and
/// has no access to <c>TConfig</c> — that type lives in the processor's own assembly. This side has
/// both.
/// </para>
/// <para>
/// <b>Startup only, never per dispatch.</b> The payload was already gated at start, so re-checking
/// it on every dispatch would pay for a second implementation of a check that passed, and would
/// reject the payload-less steps that arrive as <c>string.Empty</c> — <c>OrchestrationService</c>
/// supplies that for a step with no assignment.
/// </para>
/// </summary>
internal static class ConfigSchemaConformance
{
    /// <summary>
    /// The mismatches between <paramref name="configType"/> and <paramref name="definition"/>, empty
    /// when they agree.
    /// <para>
    /// <b>Parsed with System.Text.Json rather than a schema library.</b> This does not EVALUATE a
    /// schema, it reads two of its keywords — <c>properties</c> and <c>required</c> — and a document
    /// reader is the honest tool for that. It also keeps the check free of a validator's dialect
    /// handling, which matters because a malformed definition must be reported as a mismatch rather
    /// than throw out of the startup loop.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> Check(Type configType, string definition)
    {
        JsonElement root;
        try
        {
            root = JsonDocument.Parse(definition).RootElement.Clone();
        }
        catch (JsonException ex)
        {
            return [$"the config schema is not JSON: {ex.Message}"];
        }

        if (root.ValueKind != JsonValueKind.Object)
        {
            return ["the config schema is not a JSON object"];
        }

        var problems = new List<string>();

        var schemaProps = root.TryGetProperty("properties", out var p) && p.ValueKind == JsonValueKind.Object
            ? p.EnumerateObject().ToDictionary(x => x.Name, x => x.Value, StringComparer.Ordinal)
            : new Dictionary<string, JsonElement>(StringComparer.Ordinal);

        var required = root.TryGetProperty("required", out var r) && r.ValueKind == JsonValueKind.Array
            ? r.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String)
                                .Select(x => x.GetString()!).ToHashSet(StringComparer.Ordinal)
            : new HashSet<string>(StringComparer.Ordinal);

        // The record's own properties. ProcessorConfig declares no instance members — only a static
        // SerializerOptions — so nothing from the base leaks in, and an inherited positional (see
        // KafkaImporterConfig, whose MessageCount and IdleTimeoutSeconds are declared on
        // ImporterConfig) is picked up correctly because GetProperties walks the hierarchy.
        var members = configType
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(x => x.CanRead && x.Name != "EqualityContract")
            .ToArray();

        var optional = OptionalParameterNames(configType);

        foreach (var member in members)
        {
            // CAMELCASE, MATCHING EVERY REGISTERED ROW, AND NARROWER THAN THE BINDER ON PURPOSE.
            // ProcessorConfig.SerializerOptions binds case-insensitively, so {"MaxDepth": 4} reaches
            // the record just as {"maxDepth": 4} does — but a JSON Schema property name is
            // case-sensitive, so only one of those two validates. Pinning camelCase here is the same
            // decision FetchedFileJson makes explicitly for the envelope, and it means this check
            // holds the schema to the convention rather than to whatever the binder would tolerate.
            var key = JsonNamingPolicy.CamelCase.ConvertName(member.Name);

            if (!schemaProps.TryGetValue(key, out var declared))
            {
                // THE FAILURE THIS CHECK EXISTS FOR, seen from the other side. An unknown key in a
                // PAYLOAD binds to nothing and leaves the property at its default — {"maxDepht": 8}
                // silently expands one level instead of eight. A property missing from the SCHEMA is
                // the same hole one layer up: the schema cannot reject what it does not describe.
                problems.Add($"'{key}' is on {configType.Name} and missing from the schema's properties");
                continue;
            }

            var isOptional = optional.Contains(member.Name);

            if (isOptional && required.Contains(key))
            {
                problems.Add(
                    $"'{key}' has a default on {configType.Name} but the schema requires it");
            }
            else if (!isOptional && !required.Contains(key))
            {
                // NULLABILITY IS NOT THE SIGNAL, THE DEFAULT IS. FilePersisterConfig declares
                // string? FolderPath and its schema requires it, deliberately: the nullability is a
                // deserialization concern so a malformed payload can be diagnosed instead of throwing,
                // not a statement that the field is optional. A positional parameter with a default
                // is genuinely optional; one without is required however it is declared.
                problems.Add(
                    $"'{key}' has no default on {configType.Name} and the schema does not require it");
            }

            if (TypeMismatch(member.PropertyType, declared) is { } mismatch)
            {
                problems.Add($"'{key}': {mismatch}");
            }
        }

        var known = members
            .Select(x => JsonNamingPolicy.CamelCase.ConvertName(x.Name))
            .ToHashSet(StringComparer.Ordinal);

        foreach (var key in schemaProps.Keys.Where(k => !known.Contains(k)))
        {
            // A schema describing a field the record does not have. Harmless to a payload that omits
            // it and actively misleading to a reader, since the schema is the document an operator
            // writes a payload against.
            problems.Add($"'{key}' is in the schema's properties and not on {configType.Name}");
        }

        return problems;
    }

    /// <summary>
    /// The names of positional parameters that carry a default, which is what makes a field genuinely
    /// optional. Read off the primary constructor, since these are all positional records.
    /// </summary>
    private static HashSet<string> OptionalParameterNames(Type configType)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);

        foreach (var ctor in configType.GetConstructors())
        {
            foreach (var parameter in ctor.GetParameters().Where(x => x.HasDefaultValue))
            {
                set.Add(parameter.Name!);
            }
        }

        return set;
    }

    /// <summary>
    /// A description of the disagreement between a CLR type and the schema's declared <c>type</c>, or
    /// null when they are compatible.
    /// <para>
    /// <b>Coarse on purpose: the family, not the width.</b> A schema saying <c>string</c> where the
    /// record holds an int is a real mistake and is caught. Whether an integer property should also
    /// carry <c>minimum</c> is a judgement about the field, not a conformance question, and a check
    /// that insisted on one would start rejecting rows for being less strict than someone's taste.
    /// </para>
    /// </summary>
    private static string? TypeMismatch(Type clr, JsonElement declared)
    {
        if (!declared.TryGetProperty("type", out var type))
        {
            // No type keyword is not a mismatch. A schema may constrain a property by other means —
            // $ref, enum, const — and this check has no business insisting on one particular style.
            return null;
        }

        var allowed = type.ValueKind switch
        {
            JsonValueKind.String => new[] { type.GetString()! },
            JsonValueKind.Array  => type.EnumerateArray()
                                        .Where(x => x.ValueKind == JsonValueKind.String)
                                        .Select(x => x.GetString()!).ToArray(),
            _ => [],
        };

        if (allowed.Length == 0)
        {
            return null;
        }

        var underlying = Nullable.GetUnderlyingType(clr) ?? clr;
        var expected = Expected(underlying);

        if (expected is null || allowed.Contains(expected, StringComparer.Ordinal))
        {
            return null;
        }

        return $"the schema declares type [{string.Join(", ", allowed)}] and {configTypeName(clr)} "
             + $"binds as '{expected}'";

        static string configTypeName(Type t) => t.Name;
    }

    /// <summary>The JSON type family a CLR type binds from, or null when this check has no opinion.</summary>
    private static string? Expected(Type t)
    {
        if (t == typeof(string)) return "string";
        if (t == typeof(bool)) return "boolean";
        if (t == typeof(byte) || t == typeof(short) || t == typeof(int) || t == typeof(long)) return "integer";
        if (t == typeof(float) || t == typeof(double) || t == typeof(decimal)) return "number";
        if (t != typeof(string) && t.IsAssignableTo(typeof(System.Collections.IEnumerable))) return "array";

        // Nested objects, enums, DateTime and anything else: no opinion. An enum binds from a string
        // or an integer depending on the converter, and guessing here would reject correct rows.
        return null;
    }
}

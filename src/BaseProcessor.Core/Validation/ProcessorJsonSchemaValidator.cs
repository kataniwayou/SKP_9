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
                schema = JsonSchema.FromText(definition);
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
    /// <b>The library's own error text is deliberately discarded.</b> These strings reach
    /// <c>StepFailed</c> and the orchestrator's projections, and several keywords embed the offending
    /// instance value in their message: <c>minimum</c> renders "-999888 should be at least 18",
    /// <c>maximum</c> and <c>multipleOf</c> likewise. A payload's account balance, age or numeric
    /// token would land in a projection an operator can read. Which keywords do this is a property of
    /// the library version, not of anything we control, so an allow-list of "safe" messages would
    /// need re-auditing on every upgrade. Location plus keyword says where and which rule, is
    /// sufficient to diagnose, and cannot leak by construction.
    /// </para>
    /// </summary>
    private static List<string> Flatten(EvaluationResults results)
    {
        var flat = (results.Details ?? [])
            .Where(d => d.Errors is { Count: > 0 })
            .SelectMany(d => d.Errors!.Select(kv => $"{d.InstanceLocation}: {kv.Key}"))
            .ToList();

        if (flat.Count == 0 && results.Errors is { Count: > 0 })
        {
            flat = results.Errors.Select(kv => $"{results.InstanceLocation}: {kv.Key}").ToList();
        }

        return flat;
    }
}

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
/// </summary>
public static class ProcessorJsonSchemaValidator
{
    static ProcessorJsonSchemaValidator()
    {
        Dialect.Default = Dialect.Draft202012;          // the library default is V1, not 2020-12
        SchemaRegistry.Global.Fetch = (_, _) => null;   // no outbound $ref fetch
    }

    /// <summary>Referencing this fires the lockdown constructor before any evaluation runs.</summary>
    public static EvaluationOptions DefaultOptions { get; } = new() { OutputFormat = OutputFormat.List };

    /// <summary>
    /// True when <paramref name="data"/> satisfies <paramref name="definition"/>. A null or
    /// whitespace definition skips validation and returns true — bytes are never decoded without a
    /// schema asking for it. Every failure path fills <paramref name="errors"/> and returns false;
    /// none of them throw.
    /// </summary>
    public static bool TryValidate(string? definition, byte[] data, out IReadOnlyList<string> errors)
    {
        errors = [];

        if (string.IsNullOrWhiteSpace(definition))
        {
            return true;
        }

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

            // Instance locations and rule names only. These strings reach StepFailed and the
            // orchestrator's projections, so a value must never appear among them.
            var flat = (results.Details ?? [])
                .Where(d => d.Errors is { Count: > 0 })
                .SelectMany(d => d.Errors!.Select(kv => $"{d.InstanceLocation}: {kv.Value}"))
                .ToList();

            if (flat.Count == 0 && results.Errors is { Count: > 0 })
            {
                flat = results.Errors.Select(kv => $"{results.InstanceLocation}: {kv.Value}").ToList();
            }

            errors = flat;
            return false;
        }
    }
}

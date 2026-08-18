using System.Text.Json;
using BaseApi.Service.Features.Schema;
using Json.Schema;

namespace BaseApi.Service.Features.Orchestration.Validation;

/// <summary>
/// Payload conformance gate. It walks every assignment in the snapshot, resolves the chain from step
/// to processor to config schema to that schema's definition, parses each definition once through a
/// local cache keyed by schema id, and evaluates the assignment's payload against it.
/// <para>
/// A processor with no config schema passes, since there is nothing to validate against. On a
/// conformance failure the flattened validation messages are surfaced through the domain exception
/// and become a 422.
/// </para>
/// <para>
/// <b>Two things here are security-relevant.</b> Evaluation uses
/// <see cref="JsonSchemaConfig.DefaultOptions"/>, which is what fires the static constructor that
/// pins the dialect and installs the no-op fetcher, so an external <c>$ref</c> cannot trigger an
/// outbound request. And the parse cache is a local inside <see cref="Validate"/>, never an instance
/// field: this seam is registered scoped, so an instance field would leak parsed schemas across
/// requests.
/// </para>
/// </summary>
internal sealed class PayloadConfigSchemaValidator
{
    public void Validate(WorkflowGraphSnapshot snapshot)
    {
        // Local cache, so each schema is parsed at most once per call and nothing outlives it.
        var schemaCache = new Dictionary<Guid, JsonSchema>();

        foreach (var assignment in snapshot.Assignments.Values)
        {
            if (!snapshot.Steps.TryGetValue(assignment.StepId, out var step)) continue;
            if (!snapshot.Processors.TryGetValue(step.ProcessorId, out var proc)) continue;

            var cfgId = proc.ConfigSchemaId;
            if (cfgId is null) continue;   // no config schema means nothing to validate against

            if (!schemaCache.TryGetValue(cfgId.Value, out var schema))
            {
                if (!snapshot.Schemas.TryGetValue(cfgId.Value, out var schemaDto)) continue; // defensive
                try
                {
                    schema = JsonSchema.FromText(schemaDto.Definition);
                }
                catch (Exception ex) when (ex is JsonException or JsonSchemaException)
                {
                    throw OrchestrationValidationException.PayloadConfigSchema(
                        assignment.Id,
                        new[] { $"Config schema '{cfgId.Value}' is not a valid JSON Schema." });
                }
                schemaCache[cfgId.Value] = schema;
            }

            JsonDocument? payloadDoc = null;
            try
            {
                try
                {
                    payloadDoc = JsonDocument.Parse(assignment.Payload);
                }
                catch (JsonException)
                {
                    throw OrchestrationValidationException.PayloadConfigSchema(
                        assignment.Id, new[] { "Payload is not valid JSON." });
                }
                var results = schema.Evaluate(payloadDoc.RootElement, JsonSchemaConfig.DefaultOptions);
                if (!results.IsValid)
                {
                    var errorStrings = (results.Details ?? Enumerable.Empty<EvaluationResults>())
                        .Where(d => d.Errors is { Count: > 0 })
                        .SelectMany(d => d.Errors!.Select(kv => $"{d.InstanceLocation}: {kv.Value}"))
                        .ToList();
                    if (errorStrings.Count == 0 && results.Errors is { Count: > 0 })
                        errorStrings = results.Errors.Select(kv => $"{results.InstanceLocation}: {kv.Value}").ToList();
                    throw OrchestrationValidationException.PayloadConfigSchema(assignment.Id, errorStrings);
                }
            }
            finally
            {
                payloadDoc?.Dispose();
            }
        }
    }
}

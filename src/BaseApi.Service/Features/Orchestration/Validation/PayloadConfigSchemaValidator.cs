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
/// outbound request. And the parse cache is a local inside <see cref="Collect"/>, never an instance
/// field: this seam is registered scoped, so an instance field would leak parsed schemas across
/// requests.
/// </para>
/// </summary>
internal sealed class PayloadConfigSchemaValidator
{
    public void Validate(WorkflowGraphSnapshot snapshot)
    {
        var problems = Collect(snapshot);
        if (problems.Count > 0)
        {
            throw problems[0];
        }
    }

    /// <summary>Every non-conforming assignment, in snapshot order; the first is the one <see cref="Validate"/> throws.</summary>
    public IReadOnlyList<OrchestrationValidationException> Collect(WorkflowGraphSnapshot snapshot)
    {
        var problems = new List<OrchestrationValidationException>();

        // Local cache, so each schema is parsed at most once per call and nothing outlives it. A
        // definition that is not a valid JSON Schema is cached as null.
        var schemaCache = new Dictionary<Guid, JsonSchema?>();

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
                    schema = null;
                }
                schemaCache[cfgId.Value] = schema;
            }

            if (schema is null)
            {
                problems.Add(OrchestrationValidationException.PayloadConfigSchema(
                    assignment.Id,
                    new[] { $"Config schema '{cfgId.Value}' is not a valid JSON Schema." }));
                continue;
            }

            JsonDocument payloadDoc;
            try
            {
                payloadDoc = JsonDocument.Parse(assignment.Payload);
            }
            catch (JsonException)
            {
                problems.Add(OrchestrationValidationException.PayloadConfigSchema(
                    assignment.Id, new[] { "Payload is not valid JSON." }));
                continue;
            }

            using (payloadDoc)
            {
                EvaluationResults results;
                try
                {
                    results = schema.Evaluate(payloadDoc.RootElement, JsonSchemaConfig.DefaultOptions);
                }
                catch (JsonSchemaException ex)
                {
                    // An unresolvable $ref (the no-op fetcher holding) is a problem to report, not a 500.
                    problems.Add(OrchestrationValidationException.PayloadConfigSchema(
                        assignment.Id,
                        new[] { $"Config schema '{cfgId.Value}' could not be evaluated: {ex.Message}" }));
                    continue;
                }

                if (!results.IsValid)
                {
                    var errorStrings = (results.Details ?? Enumerable.Empty<EvaluationResults>())
                        .Where(d => d.Errors is { Count: > 0 })
                        .SelectMany(d => d.Errors!.Select(kv => $"{d.InstanceLocation}: {kv.Value}"))
                        .ToList();
                    if (errorStrings.Count == 0 && results.Errors is { Count: > 0 })
                        errorStrings = results.Errors.Select(kv => $"{results.InstanceLocation}: {kv.Value}").ToList();
                    problems.Add(OrchestrationValidationException.PayloadConfigSchema(assignment.Id, errorStrings));
                }
            }
        }

        problems.AddRange(MissingPayloads(snapshot));
        return problems;
    }

    /// <summary>
    /// The missing-payload check (the user, 2026-11-23: an orchestration rule, at Start only): every step a workflow
    /// reaches whose processor's config schema requires properties must have a payload the workflow links; one problem
    /// per workflow and step without it. A processor with no config schema, or one whose schema requires nothing, needs none.
    /// </summary>
    private static IEnumerable<OrchestrationValidationException> MissingPayloads(WorkflowGraphSnapshot snapshot)
    {
        var requiredOf = new Dictionary<Guid, IReadOnlyList<string>>();
        IReadOnlyList<string> Required(Guid schemaId)
        {
            if (requiredOf.TryGetValue(schemaId, out var known)) return known;
            // a payload is needed when the schema refuses an empty one — however it says so (required, allOf, if/then, minProperties)
            IReadOnlyList<string> found = [];
            if (snapshot.Schemas.TryGetValue(schemaId, out var dto))
            {
                try
                {
                    var schema = JsonSchema.FromText(dto.Definition);
                    using var empty = JsonDocument.Parse("{}");
                    if (!schema.Evaluate(empty.RootElement, JsonSchemaConfig.DefaultOptions).IsValid)
                    {
                        using var doc = JsonDocument.Parse(dto.Definition);
                        found = doc.RootElement.ValueKind == JsonValueKind.Object
                                && doc.RootElement.TryGetProperty("required", out var req) && req.ValueKind == JsonValueKind.Array
                            ? req.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList()
                            : [];
                        if (found.Count == 0) found = ["a payload (the config schema refuses an empty one)"];
                    }
                }
                catch (Exception ex) when (ex is JsonException or JsonSchemaException) { /* an unreadable definition is the conformance check's problem */ }
            }
            return requiredOf[schemaId] = found;
        }

        foreach (var wf in snapshot.Workflows.Values)
        {
            var linkedSteps = (wf.AssignmentIds ?? [])
                .Select(id => snapshot.Assignments.TryGetValue(id, out var a) ? a.StepId : (Guid?)null)
                .OfType<Guid>().ToHashSet();
            var seen = new HashSet<Guid>();
            var queue = new Queue<Guid>(wf.EntryStepIds ?? []);
            while (queue.Count > 0)
            {
                var sid = queue.Dequeue();
                if (!seen.Add(sid) || !snapshot.Steps.TryGetValue(sid, out var step)) continue;
                foreach (var next in step.NextStepIds ?? []) queue.Enqueue(next);
                if (linkedSteps.Contains(sid)) continue;
                if (!snapshot.Processors.TryGetValue(step.ProcessorId, out var proc) || proc.ConfigSchemaId is not { } cfg) continue;
                var required = Required(cfg);
                if (required.Count > 0) yield return OrchestrationValidationException.MissingPayload(wf.Id, sid, required);
            }
        }
    }
}

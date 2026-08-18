namespace BaseApi.Service.Features.Orchestration;

/// <summary>
/// A single domain exception for every orchestration validation gate, rather than a subclass per
/// gate. The <see cref="Gate"/> discriminator plus the gate-specific <see cref="Offending"/> payload
/// are what distinguish them downstream.
///
/// <para>
/// Claimed by <c>OrchestrationValidationExceptionHandler</c>, which returns a 422 and drops
/// <see cref="ErrorsExtension"/> into the problem details as a <c>{ gate, offending }</c> envelope.
/// The problem-details customizer adds the correlation id and instance on every emission, so the
/// handler must not set them itself.
/// </para>
///
/// <para>
/// <b>Information-disclosure guard:</b> the offending payloads carry only entity ids and flattened
/// validation messages — never stack traces or internal type names.
/// </para>
/// </summary>
public sealed class OrchestrationValidationException : Exception
{
    /// <summary>Gate discriminator: "cycle", "missingStep", "schemaEdge", "payloadConfigSchema" or "processorLiveness".</summary>
    public string Gate { get; }

    /// <summary>Gate-specific problem title.</summary>
    public string Title { get; }

    /// <summary>Gate-specific structured payload — entity ids and flattened messages only.</summary>
    public object Offending { get; }

    /// <summary>The envelope the handler writes into the problem details' errors extension.</summary>
    public object ErrorsExtension => new { gate = Gate, offending = Offending };

    private OrchestrationValidationException(string gate, string title, string detail, object offending)
        : base(detail)
    {
        Gate = gate;
        Title = title;
        Offending = offending;
    }

    /// <summary>Cycle gate — the workflow step graph contains a cycle.</summary>
    public static OrchestrationValidationException Cycle(IReadOnlyList<Guid> stepChain)
        => new(
            "cycle",
            "Workflow contains a cycle",
            $"A cycle was detected in the workflow step graph: {string.Join(" -> ", stepChain)}.",
            new CycleOffending(stepChain));

    /// <summary>Missing-step gate — a parent step references a child step id that does not exist.</summary>
    public static OrchestrationValidationException MissingStep(Guid parentStepId, Guid missingChildId)
        => new(
            "missingStep",
            "Workflow references a missing step",
            $"Step '{parentStepId}' references missing child step '{missingChildId}'.",
            new MissingStepOffending(parentStepId, missingChildId));

    /// <summary>Schema-edge gate — the parent's output schema id does not equal the child's input schema id.</summary>
    public static OrchestrationValidationException SchemaEdge(Guid parentStepId, Guid childStepId)
        => new(
            "schemaEdge",
            "Schema-edge mismatch between steps",
            $"Schema-edge mismatch on edge '{parentStepId}' -> '{childStepId}': parent output schema does not match child input schema.",
            new SchemaEdgeOffending(parentStepId, childStepId));

    /// <summary>Payload gate — an assignment payload does not conform to its config schema.</summary>
    public static OrchestrationValidationException PayloadConfigSchema(Guid assignmentId, IReadOnlyList<string> errors)
        => new(
            "payloadConfigSchema",
            "Assignment payload does not conform to its config schema",
            $"Assignment '{assignmentId}' payload does not conform to its config schema.",
            new PayloadConfigSchemaOffending(assignmentId, errors));

    /// <summary>Processor-liveness gate — no discovered replica of a participating processor is present,
    /// healthy and fresh. <paramref name="reason"/> is the aggregate count-only breakdown.</summary>
    public static OrchestrationValidationException ProcessorNotLive(Guid procId, string reason)
        => new(
            "processorLiveness",
            "Participating processor is not live",
            $"Processor '{procId}' is not live: {reason}.",
            new ProcessorLivenessOffending(procId, reason));
}

/// <summary>Offending payload for the cycle gate — the chain of step ids forming the cycle.</summary>
public sealed record CycleOffending(IReadOnlyList<Guid> stepChain);

/// <summary>Offending payload for the missing-step gate.</summary>
public sealed record MissingStepOffending(Guid parentStepId, Guid missingChildId);

/// <summary>Offending payload for the schema-edge gate.</summary>
public sealed record SchemaEdgeOffending(Guid parentStepId, Guid childStepId);

/// <summary>Offending payload for the payload gate — the assignment id and the flattened messages.</summary>
public sealed record PayloadConfigSchemaOffending(Guid assignmentId, IReadOnlyList<string> errors);

/// <summary>Offending payload for the processor-liveness gate — the processor id and an aggregate
/// reason. The reason carries per-state counts only, never instance ids, connection strings or stack
/// traces.</summary>
public sealed record ProcessorLivenessOffending(Guid procId, string reason);

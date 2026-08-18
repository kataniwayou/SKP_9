namespace BaseApi.Service.Features.Step;

/// <summary>
/// Junction entity for the step-to-step self reference: a row means step <c>StepId</c> may flow into
/// step <c>NextStepId</c>. <b>Deliberately not derived from <c>BaseEntity</c></b> — junction rows
/// have no id, no audit fields and no concurrency token, and the model-building loop that adds the
/// token filters on that base type, so junctions are excluded naturally.
/// <para>
/// The composite key and the two self-referencing foreign keys, both restricting deletes, are
/// configured in <c>StepNextStepsConfiguration</c>.
/// </para>
/// </summary>
public sealed class StepNextSteps
{
    public Guid StepId { get; set; }
    public Guid NextStepId { get; set; }
}

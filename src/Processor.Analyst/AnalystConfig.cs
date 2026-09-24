using BaseProcessor.Core.Configuration;

namespace Processor.Analyst;

/// <summary>
/// The step payload this processor binds — one monitor's whole configuration.
/// <para>
/// <b>Every field here is frozen on the first POST.</b> This record's shape is compared against the
/// config schema row by <c>ConfigSchemaConformance.Check</c>, in
/// <c>AnalystConfigSchemaTests</c> and again in <c>ProcessorStartupOrchestrator</c> against the live
/// row. A referenced schema definition cannot be edited, so ADDING a property later needs a new
/// schema row, the processor's <c>configSchemaId</c> re-pointed at it, and a restart. Changing a
/// <i>value</i> is a cheap row edit; discovering a missing knob is the whole dance.
/// </para>
/// <para>
/// <b>What is deliberately NOT here: the model id and the effort.</b> Both change the preflight
/// BIT's verdict, and the BIT is cached on a hash of the prompt alone. As payload values they would
/// have to enter that hash; as compiled constants, changing them requires a rebuild, which restarts
/// the pod, which clears the cache, which re-runs the BIT. Correctness falls out for free.
/// </para>
/// <para>
/// Flat primitives rather than nested records, because the conformance check compares this shape to
/// a JSON Schema definition and nested objects multiply the ways those two can disagree for no gain.
/// </para>
/// </summary>
/// <param name="TargetWorkflowId">
/// The workflow to investigate. It scopes every business-layer (Elasticsearch) query the agent
/// issues, which is also how the agent stays out of its own mirror: it runs as an ordinary
/// processor and its own step records would otherwise satisfy the same "an outcome record whose
/// emitter isn't the orchestrator" filter, but they carry the MONITOR workflow's id, not this one, so
/// a query scoped to this id cannot see them. There is no exclusion clause to forget.
/// <para>
/// <b>Ops-layer (Prometheus) panels are not scoped by this id, and cannot be.</b> <c>pipeline_*</c>
/// series carry no workflow label at all, and one processor replica ordinarily serves several
/// workflows at once — an ops panel reads host-level telemetry for the replica, not for this
/// workflow specifically. See each ops panel's description in <c>PanelRegistry</c>.
/// </para>
/// </param>
/// <param name="WindowMinutes">
/// How far back to look, matching what the dashboards show. Months of history is explicitly not the
/// job — the agent re-derives a trend from this window on every dispatch and carries nothing between
/// them.
/// </param>
/// <param name="Prompt">
/// The analytical judgment layer: what counts as a trend worth a human, how sceptical to be, which
/// correlations matter, and the specific ways these boards lie. NOT the loop contract — the stages,
/// the tool protocol and the terminal tools are compiled, so that a payload edit cannot break the
/// typed exit and turn every dispatch into a Failed step with no obvious cause.
/// </param>
/// <param name="PanelSet">
/// The panels this monitor may consult. The tool surface is the panel list, so this is also the read
/// boundary — inspectable, and widened by naming more panels rather than by loosening a permission.
/// </param>
/// <param name="MaxIterations">Hard ceiling on model turns. Exhaustion with no terminal tool call is a failed step.</param>
/// <param name="MaxTokens">Hard ceiling on accumulated tokens across the dispatch.</param>
/// <param name="WallClockSeconds">Hard ceiling on elapsed time for the investigation.</param>
public sealed record AnalystConfig(
    Guid TargetWorkflowId,
    int WindowMinutes,
    string Prompt,
    string[] PanelSet,
    int MaxIterations,
    int MaxTokens,
    int WallClockSeconds) : ProcessorConfig;

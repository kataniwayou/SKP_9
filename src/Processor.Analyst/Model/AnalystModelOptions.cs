namespace Processor.Analyst.Model;

/// <summary>
/// Where the model lives. Bound from <c>Analyst:Model:*</c>, which the manifest fills from a
/// Kubernetes Secret.
/// <para>
/// <b>Credentials are a property of where the processor runs, never of the workflow.</b> They must
/// not appear in the assignment payload — the payload says what to analyse, the deployment says what
/// it may talk to.
/// </para>
/// <para>
/// <b>The model id and effort live here, as environment variables — deliberately amending an earlier
/// decision that compiled them in.</b> Both change the preflight BIT's verdict, and the BIT caches on a
/// hash of the prompt alone, so something has to guarantee that a changed value can never meet a warm
/// cache. A compiled constant guaranteed it by forcing a rebuild. An environment variable guarantees the
/// same thing for the same reason: env vars freeze at container start, so changing one rolls the pod, and
/// <c>BitCache</c> is per-replica and dies with the process. What must not happen is either value
/// arriving from a reloadable source — see the note on each property.
/// </para>
/// </summary>
internal sealed class AnalystModelOptions
{
    /// <summary>
    /// The model to call, e.g. <c>kimi-k3</c>.
    /// <para>
    /// <b>This must arrive as an environment variable, never a reloadable config file.</b> It changes
    /// the preflight BIT's verdict, and <c>PreflightBit</c> caches on a hash of the prompt alone. Env
    /// vars freeze at container start, so changing this rolls the pod, which discards the per-replica
    /// <c>BitCache</c>, which re-runs the BIT. A mounted ConfigMap with reloadOnChange would break that
    /// silently: a live swap against a warm cache reusing a verdict earned on the old model.
    /// </para>
    /// </summary>
    public string? ModelId { get; set; }

    /// <summary>
    /// <c>low</c>, <c>high</c> or <c>max</c>. Set it explicitly — the endpoint defaults to <c>max</c>,
    /// which is the most expensive setting, and reasoning tokens bill as output. Thinking cannot be
    /// disabled on this model. Same env-var-only rule as <see cref="ModelId"/>, for the same reason:
    /// effort changes the BIT's verdict too.
    /// </summary>
    public string? ReasoningEffort { get; set; }

    public string? ApiKey { get; set; }

    /// <summary>
    /// The endpoint's base address, e.g. <c>https://api.moonshot.ai/v1</c>. A trailing slash is added
    /// if absent — without one, <see cref="Uri"/> composition drops the last path segment and requests
    /// go to <c>/chat/completions</c> instead of <c>/v1/chat/completions</c>.
    /// </summary>
    public string? BaseUrl { get; set; }
}

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
/// The model id and effort are deliberately NOT here: they change the preflight BIT's verdict, and
/// the BIT caches on a hash of the prompt alone. As compiled constants, changing them requires a
/// rebuild, which restarts the pod, which clears the cache, which re-runs the BIT.
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

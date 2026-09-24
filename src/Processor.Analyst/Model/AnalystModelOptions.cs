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
    public string? ApiKey { get; set; }

    /// <summary>Only for proxying. Never for pointing at a non-Anthropic endpoint — that is a different adapter.</summary>
    public string? BaseUrl { get; set; }
}

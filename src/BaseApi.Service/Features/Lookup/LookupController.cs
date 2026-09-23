using Asp.Versioning;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace BaseApi.Service.Features.Lookup;

/// <summary>
/// The dashboard's refresh signal for the id → name lookup table.
///
/// <para><b>Why this is an image.</b> Kibana never calls out for data it will keep, so the lookup
/// table has to be pushed — and the only thing that reliably says "an operator is looking at the
/// dashboard right now" is the browser fetching something. The diagram panel's markdown template
/// can emit an <c>&lt;img&gt;</c>, so an image is the one shape a refresh signal can take from
/// inside a TSVB panel.</para>
///
/// <para><b>It sits OUTSIDE the template's <c>{{#each}}</c> loop</b>, and that placement is the
/// whole difference between this and hanging the refresh off the diagram requests. Outside the loop
/// it fires once per render rather than once per workflow in range, and it fires even when the
/// query returns no series at all — which is exactly the cold-start case where a per-workflow
/// signal never arrives.</para>
///
/// <para><b>A GET with a side effect, deliberately.</b> That is unusual enough to be worth stating:
/// it is idempotent, it runs after the response, and it is invisible to the caller. Without this
/// note the next reader would reasonably delete the tag from the panel as dead markup.</para>
/// </summary>
[ApiController]
[ApiVersion("1.0")]
[Route("api/v{version:apiVersion}/lookup")]
public sealed class LookupController : ControllerBase
{
    // A 1x1 fully transparent SVG. Rendering nothing is the point - it lives in a dashboard panel.
    private const string Pixel =
        """<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"/>""";

    private readonly KibanaLookupPublisher _publisher;
    private readonly ILogger<LookupController> _log;

    public LookupController(KibanaLookupPublisher publisher, ILogger<LookupController> log)
    {
        _publisher = publisher;
        _log = log;
    }

    /// <summary>
    /// Returns an invisible pixel immediately and refreshes the lookup table in the background.
    /// </summary>
    /// <remarks>
    /// <b><c>no-store</c> is load-bearing.</b> This endpoint exists to be hit; a cached response is
    /// a signal that never arrives. It is also why the diagram endpoint can now be cached freely —
    /// the two were coupled while the refresh rode on the diagram requests, and caching those would
    /// silently have stopped the refresh with nothing to connect the two changes.
    /// <para>
    /// <b>A real image, not a 204.</b> A 204 leaves a broken image, which with empty alt text
    /// collapses to nothing and looks identical to the endpoint being down — the same ambiguity the
    /// diagram placeholder exists to remove.
    /// </para>
    /// <para>
    /// <b>The refresh is not awaited.</b> The dashboard is waiting on this response, and Kibana
    /// being slow or down must not hold it up. Failures are logged by the publisher at Warning and
    /// never surface here.
    /// </para>
    /// </remarks>
    [HttpGet("ping.svg")]
    [Produces("image/svg+xml")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult Ping()
    {
        if (_publisher.Enabled)
        {
            // Detached on purpose: HttpContext.RequestAborted is cancelled as soon as the response
            // completes, which would cancel the publish the moment it is useful.
            _ = Task.Run(async () =>
            {
                try
                {
                    await _publisher.RefreshAsync(CancellationToken.None);
                }
                catch (Exception ex)
                {
                    // RefreshAsync already swallows its own failures; this only catches a fault in
                    // the scheduling itself, which must never reach the thread pool unobserved.
                    _log.LogWarning(ex, "The lookup refresh task faulted.");
                }
            });
        }

        Response.Headers.CacheControl = "no-store";
        return Content(Pixel, "image/svg+xml");
    }
}

using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BaseApi.Service.Features.Lookup;

/// <summary>
/// Creates the lookup index, the enrich policy and the <c>logs@custom</c> pipeline once at boot.
/// <para>
/// <b>Why this exists at all.</b> Moving the table out of Kibana was only worth doing if no manual
/// step replaced the one it removed. Three Elasticsearch objects have to exist before a single
/// record can be named, and the service that owns the table is the only thing that knows their
/// shape, so it provisions them itself. A fresh environment then needs nothing done to it.
/// </para>
/// <para>
/// <b>A failure here does not stop the host.</b> Elasticsearch may legitimately be starting up
/// alongside this service, and refusing to serve the API because the log store is not ready yet
/// would make an observability concern an availability one. The next start republishes and will
/// fail loudly there, where there is a request to answer.
/// </para>
/// </summary>
internal sealed class LookupProvisioningService : BackgroundService
{
    private readonly IEntityLookupPublisher _publisher;
    private readonly ILogger<LookupProvisioningService> _log;

    public LookupProvisioningService(
        IEntityLookupPublisher publisher, ILogger<LookupProvisioningService> log)
    {
        _publisher = publisher;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try
        {
            await _publisher.EnsureProvisionedAsync(ct);
            _log.LogInformation("Entity lookup index, enrich policy and ingest pipeline are in place.");
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not provision the entity lookup; the next workflow start will retry.");
        }
    }
}

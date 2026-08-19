using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace BaseApi.Tests.Live;

/// <summary>
/// Registers a throwaway processor row over BaseApi's REST surface and removes it afterwards, so the
/// live tests have a row to resolve without depending on whatever happens to be in the database.
/// <para>
/// The source hash is derived from the fixture's own run rather than from assembly metadata: these
/// tests must not resolve to the sample processor's real row, because deleting that afterwards would
/// break the running deployment.
/// </para>
/// </summary>
public sealed class RealStackFixture : IAsyncLifetime
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(20) };

    public Guid ProcessorId { get; private set; }
    public string SourceHash { get; private set; } = string.Empty;
    public string Name { get; private set; } = string.Empty;
    public string Version => "1.0.0";

    public async ValueTask InitializeAsync()
    {
        if (!RealStack.Enabled)
        {
            return;
        }

        // A fresh 64-hex hash per run, so concurrent runs cannot collide on uq_processor_source_hash.
        SourceHash = Convert.ToHexString(Guid.NewGuid().ToByteArray().Concat(
            Guid.NewGuid().ToByteArray()).ToArray()).ToLowerInvariant();
        Name = $"live-test-{Guid.NewGuid():N}";

        var response = await _http.PostAsJsonAsync(
            $"{RealStack.BaseApiUrl}/api/v1/processors",
            new { SourceHash, Name, Version });

        response.EnsureSuccessStatusCode();

        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        ProcessorId = body.RootElement.GetProperty("id").GetGuid();
    }

    public async ValueTask DisposeAsync()
    {
        if (RealStack.Enabled && ProcessorId != Guid.Empty)
        {
            // Best effort. A leftover row is noise in a dev cluster, not a failure worth masking a
            // real assertion behind.
            try
            {
                await _http.DeleteAsync($"{RealStack.BaseApiUrl}/api/v1/processors/{ProcessorId}");
            }
            catch (HttpRequestException)
            {
            }
        }

        _http.Dispose();
    }
}

[CollectionDefinition(Name)]
public sealed class RealStackCollection : ICollectionFixture<RealStackFixture>
{
    public const string Name = "RealStack";
}

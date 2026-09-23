using System.Text.Json;
using BaseProcessor.Core.Configuration;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

/// <summary>
/// The cache seam, declared and not yet read.
/// <para>
/// It is added ahead of the behaviour because adding it later is not free.
/// <c>ProcessorConfig.SerializerOptions</c> leaves <c>UnmappedMemberHandling</c> at its default of
/// Skip, so a payload carrying <c>cacheRoot</c> against a record that does not declare it is
/// silently discarded — the exact failure that looks like a whitelist matching nothing. Declaring it
/// now means the behaviour change later is a handler edit rather than a contract edit.
/// </para>
/// </summary>
public sealed class SKNormalizerConfigTests
{
    private static SKNormalizerConfig? Bind(string payload) =>
        JsonSerializer.Deserialize<SKNormalizerConfig>(payload, ProcessorConfig.SerializerOptions);

    [Fact]
    public void APayloadCarryingACacheRootBindsIt()
    {
        var config = Bind("""{"handler":"Acme","cacheRoot":"sk-whitelist"}""");

        Assert.Equal("sk-whitelist", config!.CacheRoot);
    }

    [Fact]
    public void APayloadStillCarryingTheOldAddressBindsNothing()
    {
        // THE RENAME'S ONE QUIET FAILURE, pinned so nobody has to rediscover it during a deploy.
        // UnmappedMemberHandling is Skip, so a payload left at the pre-rename shape does not throw --
        // cacheAddress binds to nothing and CacheRoot is null, which the processor then treats as a
        // handler that wants no list. For Acme that surfaces at the first lookup as a payload defect,
        // not at startup, which is why the schema row and the assignment have to move together.
        var config = Bind(
            """{"handler":"Acme","cacheAddress":"skp:11111111-1111-1111-1111-111111111111:cache:sk-whitelist"}""");

        Assert.Null(config!.CacheRoot);
    }

    [Fact]
    public void APayloadOmittingItLeavesItNull()
    {
        // Null is what the processor treats as a payload defect rather than a cache miss, so that a
        // step whose root was forgotten fails loudly instead of cancelling every document as though
        // nothing were whitelisted.
        var config = Bind("""{"handler":"Acme"}""");

        Assert.Null(config!.CacheRoot);
    }

    [Fact]
    public void TheHandlerStillBinds()
    {
        Assert.Equal("Acme", Bind("""{"handler":"Acme"}""")!.Handler);
    }
}

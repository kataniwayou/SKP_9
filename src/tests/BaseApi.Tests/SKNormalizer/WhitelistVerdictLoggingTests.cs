using BaseApi.Tests.Support;
using BaseProcessor.Core.Processing;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

/// <summary>
/// The attribute contract the whitelist board is built on.
/// <para>
/// <b>These assert on scope dictionaries, not on message text, and that is the whole point.</b> A
/// pie chart slices on a field; prose inside a message is something a query has to match into. If
/// these three keys are ever renamed or demoted into the template, the panels keep rendering and
/// silently count nothing — which is why the contract is pinned here rather than left to the
/// dashboard to discover.
/// </para>
/// </summary>
public sealed class WhitelistVerdictLoggingTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");

    private const string Root = "chain-artists";

    /// <summary>The address the whitelist will compose, built here the same way, for seeding.</summary>
    private static readonly string Address = L2ProjectionKeys.Cache(W, Root);

    private static (RedisFieldWhitelist Whitelist, RecordingLogger<RedisFieldWhitelist> Log)
        Build(InMemoryL2 l2, string root = Root)
    {
        var log = new RecordingLogger<RedisFieldWhitelist>();
        return (new RedisFieldWhitelist(l2.Multiplexer, W, root, log), log);
    }

    private static async Task<InMemoryL2> Projected(params string[] listed)
    {
        var l2 = new InMemoryL2();
        await l2.Db.StringSetAsync(Address, "[]");

        foreach (var entry in listed)
        {
            await l2.Db.StringSetAsync($"{Address}:{entry}", $"{entry} (Approved)");
        }

        return l2;
    }

    [Fact]
    public async Task AListedValueIsRecordedWithItsValueAndVerdict()
    {
        var (whitelist, log) = Build(await Projected("SKP Live Suite"));

        Assert.True(whitelist.TryGet("SKP Live Suite", out _));

        var scope = Assert.Single(log.Scopes);
        Assert.Equal("chain-artists", scope["WhitelistRoot"]);
        Assert.Equal("SKP Live Suite", scope["WhitelistValue"]);
        Assert.Equal("Listed", scope["WhitelistVerdict"]);
    }

    [Fact]
    public async Task AnUnlistedValueIsRecordedToo()
    {
        // THE HALF THAT DID NOT EXIST BEFORE was the listed one; this half already reached the store
        // inside the handler's cancel reason. Both are asserted because a board that counts only
        // rejections cannot say what proportion of traffic the list admits — the question the pie
        // chart exists to answer.
        var (whitelist, log) = Build(await Projected("SKP Live Suite"));

        Assert.False(whitelist.TryGet("Unapproved Sim Artist", out _));

        var scope = Assert.Single(log.Scopes);
        Assert.Equal("Unapproved Sim Artist", scope["WhitelistValue"]);
        Assert.Equal("Unlisted", scope["WhitelistVerdict"]);
    }

    [Fact]
    public async Task BothVerdictsAreWrittenAtInformation()
    {
        // Demoting hits to Debug is the obvious economy and it would break the board silently: a
        // deployment filtering below Information would drop every Listed record and leave a chart
        // reading 100% Unlisted, which is indistinguishable from a list that approves nobody.
        var (whitelist, log) = Build(await Projected("SKP Live Suite"));

        whitelist.TryGet("SKP Live Suite", out _);
        whitelist.TryGet("Unapproved Sim Artist", out _);

        Assert.Equal(2, log.Records.Count);
        Assert.All(log.Records, r => Assert.Equal(LogLevel.Information, r.Level));
    }

    [Fact]
    public async Task TheRootIsTheCacheNameAloneAndNotTheWholeAddress()
    {
        // The root is what tells two whitelists apart on one board. Logging the composed address would
        // put a workflow id in every slice label and make two runs of the same workflow — or the same
        // list under two workflows — look like different lists.
        //
        // STILL WORTH ASSERTING AFTER THE RENAME, for a different reason than before. It used to guard
        // a last-colon split that could have leaked the address into the label; now the root arrives
        // whole and the ADDRESS is the derived half, so what this pins is that the derivation did not
        // get logged by accident.
        var (whitelist, log) = Build(await Projected("SKP Live Suite"));

        whitelist.TryGet("SKP Live Suite", out _);

        var scope = Assert.Single(log.Scopes);
        Assert.Equal(Root, scope["WhitelistRoot"]);
        Assert.DoesNotContain(":", (string)scope["WhitelistRoot"], StringComparison.Ordinal);
    }

    [Fact]
    public void ARootCarryingAColonIsRefused()
    {
        // The forgery the composition makes possible, and the reason the colon guard moved to this
        // side with it: root "a" + key "b:c" and root "a:b" + key "c" are one string. While the address
        // arrived pre-composed, CacheRules.CheckRoot was the only guard that had to exist.
        var l2 = new InMemoryL2();

        Assert.Throws<ArgumentException>(() =>
            new RedisFieldWhitelist(
                l2.Multiplexer, W, "chain:artists", new RecordingLogger<RedisFieldWhitelist>()));
    }

    [Fact]
    public void AnUnprojectedDictionaryRecordsNoVerdict()
    {
        // "There is no list" is not an answer a list gave. Counting it as Unlisted would put a
        // configuration defect into a chart an operator reads as upstream behaviour.
        var (whitelist, log) = Build(new InMemoryL2());

        Assert.Throws<FailedException>(() => whitelist.TryGet("SKP Live Suite", out _));

        Assert.Empty(log.Scopes);
        Assert.Empty(log.Records);
    }

    [Fact]
    public async Task ABlankFieldRecordsNoVerdict()
    {
        // The list is never consulted, so there is nothing to report. Recording it as a miss would
        // charge a caller's own defect to the upstream data the board measures.
        var (whitelist, log) = Build(await Projected("SKP Live Suite"));

        Assert.False(whitelist.TryGet("   ", out _));

        Assert.Empty(log.Scopes);
    }

    [Fact]
    public async Task OneRecordIsWrittenPerLookupRatherThanPerDispatch()
    {
        // The pie counts records, so a whitelist asked twice must say so twice — otherwise a
        // document whose every item was rejected weighs the same as one with a single rejection.
        var (whitelist, log) = Build(await Projected("SKP Live Suite"));

        whitelist.TryGet("SKP Live Suite", out _);
        whitelist.TryGet("SKP Live Suite", out _);
        whitelist.TryGet("Unapproved Sim Artist", out _);

        Assert.Equal(3, log.Scopes.Count);
        Assert.Equal(2, log.Scopes.Count(s => (string)s["WhitelistVerdict"] == "Listed"));
    }
}

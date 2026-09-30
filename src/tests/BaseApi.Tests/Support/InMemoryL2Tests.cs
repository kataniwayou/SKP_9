using StackExchange.Redis;
using Xunit;

namespace BaseApi.Tests.Support;

public sealed class InMemoryL2Tests
{
    [Fact]
    public async Task AHashFieldIsStoredAndReadBack()
    {
        var l2 = new InMemoryL2();

        await l2.Db.HashSetAsync("skp:wf:a", "name", "chain");
        await l2.Db.HashSetAsync("skp:wf:a", [new HashEntry("store", "{}"), new HashEntry("roots", "[]")]);

        Assert.Equal("chain", (string?)await l2.Db.HashGetAsync("skp:wf:a", "name"));
        Assert.Equal("{}", l2.HashValue("skp:wf:a", "store"));
        Assert.True(l2.HasHash("skp:wf:a"));
        Assert.True((await l2.Db.HashGetAsync("skp:wf:a", "missing")).IsNull);
    }

    [Fact]
    public async Task ExpireIsRecordedForAnExistingKeyOnly()
    {
        var l2 = new InMemoryL2();
        await l2.Db.SetAddAsync("skp:proc:p:instances", "pod-0");

        Assert.True(await l2.Db.KeyExpireAsync("skp:proc:p:instances", TimeSpan.FromSeconds(40), ExpireWhen.Always, CommandFlags.None));
        Assert.False(await l2.Db.KeyExpireAsync("skp:absent", TimeSpan.FromSeconds(40), ExpireWhen.Always, CommandFlags.None));
        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl("skp:proc:p:instances"));
        Assert.Null(l2.Ttl("skp:absent"));
    }

    [Fact]
    public async Task AStringWrittenWithAnExpiryRecordsItsTtl()
    {
        var l2 = new InMemoryL2();

        await l2.Db.StringSetAsync("skp:proc:p:pod-0", "{}", TimeSpan.FromSeconds(40), When.Always, CommandFlags.None);

        Assert.Equal(TimeSpan.FromSeconds(40), l2.Ttl("skp:proc:p:pod-0"));
    }

    [Fact]
    public async Task SetContainsAnswersMembership()
    {
        var l2 = new InMemoryL2();
        await l2.Db.SetAddAsync("skp:live", "w1");

        Assert.True(await l2.Db.SetContainsAsync("skp:live", "w1"));
        Assert.False(await l2.Db.SetContainsAsync("skp:live", "w2"));
    }

    [Fact]
    public async Task ExistsAndDeleteCoverEveryType()
    {
        var l2 = new InMemoryL2();
        await l2.Db.StringSetAsync("s", "v");
        await l2.Db.HashSetAsync("h", "f", "v");
        await l2.Db.SetAddAsync("set", "m");

        Assert.True(await l2.Db.KeyExistsAsync("h"));
        Assert.True(await l2.Db.KeyExistsAsync("set"));
        Assert.Equal(3, await l2.Db.KeyDeleteAsync(["s", "h", "set"]));
        Assert.False(await l2.Db.KeyExistsAsync("h"));
        Assert.Empty(l2.Members("set"));
    }

    [Fact]
    public async Task TheSnapshotIncludesHashes()
    {
        var l2 = new InMemoryL2();
        await l2.Db.HashSetAsync("skp:step:s", "name", "step-a");

        Assert.Contains("hash skp:step:s.name = step-a", l2.Snapshot());
    }
}

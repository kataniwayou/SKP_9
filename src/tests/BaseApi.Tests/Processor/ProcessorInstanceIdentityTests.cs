using BaseApi.Core.Exceptions;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service;
using BaseApi.Service.Features.Processor;
using BaseProcessor.Core.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace BaseApi.Tests.Processor;

/// <summary>
/// The per-replica registration rule: several processors may share one <c>SourceHash</c>, and what
/// distinguishes them is <c>InstanceId</c>. It exists so a StatefulSet's pods can run one build while
/// each holds an identity — and therefore a work queue, which is named after the identity — of its
/// own, where a Deployment's replicas share one.
/// <para>
/// <b>The uniqueness rule itself is asserted against the model, not by inserting twice.</b> The
/// in-memory provider enforces no index at all, so a duplicate-insert test against it would pass
/// whatever the configuration said — the same reason <c>DeletePolicyTests</c> gives for pinning
/// delete behaviour as metadata. What the two partial filters actually do to Postgres is proven in
/// the live suite.
/// </para>
/// </summary>
public sealed class ProcessorInstanceIdentityTests
{
    private const string Hash = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    private const string OtherHash = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    private static AppDbContext NewContext() =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"processor-instance-{Guid.NewGuid():N}")
            .Options);

    private static ProcessorService NewService(AppDbContext db)
        => new(
            new ProcessorCreateDtoValidator(),
            new ProcessorUpdateDtoValidator(),
            new ProcessorEntityMapper(),
            new Repository<ProcessorEntity>(db),
            db);

    private static ProcessorCreateDto Create(string hash, string? instanceId, string name = "sample")
        => new(name, "1.0.0", null, hash, instanceId, null, null, null);

    // ---------------------------------------------------------------- normalization

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\t")]
    public void BlankInstanceIdIsStoredAsNull(string? supplied)
    {
        // Not cosmetic. The uniqueness rule counts "no instance" as a value, and it is split across
        // two partial indexes keyed on `instance_id IS NULL` — so an empty string reaching the column
        // would sit in the other index, collide with nothing, and let a second shared row exist for a
        // hash that is supposed to have exactly one.
        var entity = new ProcessorEntity { InstanceId = supplied };

        Assert.Null(entity.InstanceId);
    }

    [Fact]
    public void SurroundingWhitespaceIsTrimmedFromTheInstanceId()
    {
        // The pod side reads this from an environment variable, where a stray space is invisible.
        // Untrimmed, a row registered as " fetcher-0 " would never match the pod asking for
        // "fetcher-0", and the pod would wait forever on a row that looks correct in the API.
        var entity = new ProcessorEntity { InstanceId = "  fetcher-0  " };

        Assert.Equal("fetcher-0", entity.InstanceId);
    }

    // ---------------------------------------------------------------- the index pair

    [Fact]
    public void TheSharedRowIndexIsUniquePerHashAndCoversOnlyRowsWithNoInstance()
    {
        using var db = NewContext();

        var index = db.Model.FindEntityType(typeof(ProcessorEntity))!
            .GetIndexes()
            .Single(i => i.GetDatabaseName() == "uq_processor_source_hash");

        Assert.True(index.IsUnique);
        Assert.Equal("instance_id IS NULL", index.GetFilter());
        Assert.Equal(
            new[] { nameof(ProcessorEntity.SourceHash) },
            index.Properties.Select(p => p.Name).ToArray());
    }

    [Fact]
    public void ThePerReplicaIndexIsUniqueOnTheHashAndInstancePair()
    {
        using var db = NewContext();

        var index = db.Model.FindEntityType(typeof(ProcessorEntity))!
            .GetIndexes()
            .Single(i => i.GetDatabaseName() == "uq_processor_instance_id");

        Assert.True(index.IsUnique);
        Assert.Equal("instance_id IS NOT NULL", index.GetFilter());
        // Ordered: the hash leads, so this index also serves the identity lookup, which always
        // narrows by hash before it looks at the instance.
        Assert.Equal(
            new[] { nameof(ProcessorEntity.SourceHash), nameof(ProcessorEntity.InstanceId) },
            index.Properties.Select(p => p.Name).ToArray());
    }

    [Fact]
    public void NoIndexMakesTheSourceHashUniqueOnItsOwn()
    {
        // The point of the whole change, stated as the absence it is: an unfiltered unique index on
        // source_hash would forbid the second replica row before anything else had a chance to.
        using var db = NewContext();

        var unconditional = db.Model.FindEntityType(typeof(ProcessorEntity))!
            .GetIndexes()
            .Where(i => i.IsUnique && i.GetFilter() is null)
            .Where(i => i.Properties.Count == 1
                        && i.Properties[0].Name == nameof(ProcessorEntity.SourceHash))
            .ToList();

        Assert.Empty(unconditional);
    }

    [Fact]
    public void BothIndexNamesStillYieldARealColumnToTheExceptionMapper()
    {
        // The mapper recovers the offending column by stripping "uq_<table>_" off the constraint
        // name, and reports whatever is left verbatim. A composite named for both columns would strip
        // to "source_hash_instance_id" — a string that passes its snake_case sanity check while naming
        // no column, so the 409 would point the caller at a field that does not exist.
        using var db = NewContext();
        var entityType = db.Model.FindEntityType(typeof(ProcessorEntity))!;
        var columns = entityType.GetProperties()
            .Select(p => p.GetColumnName())
            .ToHashSet(StringComparer.Ordinal);

        foreach (var index in entityType.GetIndexes().Where(i => i.IsUnique))
        {
            var name = index.GetDatabaseName()!;
            Assert.StartsWith("uq_processor_", name, StringComparison.Ordinal);
            var reported = name["uq_processor_".Length..];
            Assert.Contains(reported, columns);
        }
    }

    // ---------------------------------------------------------------- persistence

    [Fact]
    public async Task TwoReplicasOfOneBuildCanBothRegister()
    {
        using var db = NewContext();
        var service = NewService(db);

        var first = await service.CreateAsync(Create(Hash, "fetcher-0"), TestContext.Current.CancellationToken);
        var second = await service.CreateAsync(Create(Hash, "fetcher-1"), TestContext.Current.CancellationToken);

        Assert.Equal(Hash, first.SourceHash);
        Assert.Equal(Hash, second.SourceHash);
        // Distinct ids are the whole point: ProcessorQueues.Work names the work queue after the id,
        // so two ids is two queues, which is what makes the replicas individually addressable.
        Assert.NotEqual(first.Id, second.Id);
        Assert.Equal("fetcher-0", first.InstanceId);
        Assert.Equal("fetcher-1", second.InstanceId);
    }

    [Fact]
    public async Task AnInstanceIdMayRepeatAcrossDifferentBuilds()
    {
        // Uniqueness is scoped to the hash. Two unrelated StatefulSets both have an ordinal 0, and
        // neither has any reason to know about the other.
        using var db = NewContext();
        var service = NewService(db);

        await service.CreateAsync(Create(Hash, "worker-0"), TestContext.Current.CancellationToken);
        var other = await service.CreateAsync(Create(OtherHash, "worker-0", "other"), TestContext.Current.CancellationToken);

        Assert.Equal("worker-0", other.InstanceId);
    }

    [Fact]
    public async Task ABlankInstanceIdSurvivesTheRoundTripAsNull()
    {
        using var db = NewContext();
        var service = NewService(db);

        var created = await service.CreateAsync(Create(Hash, "   "), TestContext.Current.CancellationToken);

        Assert.Null(created.InstanceId);
    }

    // ---------------------------------------------------------------- the lookup

    [Fact]
    public async Task ASuppliedInstanceIdResolvesThatReplicasOwnRow()
    {
        using var db = NewContext();
        var service = NewService(db);
        await service.CreateAsync(Create(Hash, "fetcher-0"), TestContext.Current.CancellationToken);
        var wanted = await service.CreateAsync(Create(Hash, "fetcher-1"), TestContext.Current.CancellationToken);

        var found = await service.GetBySourceHashAsync(Hash, "fetcher-1", TestContext.Current.CancellationToken);

        Assert.Equal(wanted.Id, found.Id);
    }

    [Fact]
    public async Task NoInstanceIdResolvesTheSharedRow()
    {
        // The path every processor running today takes, and the one that must keep working: a
        // Deployment replica leaves Processor:InstanceId unset and asks by hash alone.
        using var db = NewContext();
        var service = NewService(db);
        var shared = await service.CreateAsync(Create(Hash, null), TestContext.Current.CancellationToken);
        await service.CreateAsync(Create(Hash, "fetcher-0"), TestContext.Current.CancellationToken);

        var found = await service.GetBySourceHashAsync(Hash, null, TestContext.Current.CancellationToken);

        Assert.Equal(shared.Id, found.Id);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task ABlankInstanceIdOnTheLookupMeansTheSharedRow(string blank)
    {
        // Folded the same way the write side folds it. Without this the query would ask for a row
        // whose instance_id equals "", which the column can never hold.
        using var db = NewContext();
        var service = NewService(db);
        var shared = await service.CreateAsync(Create(Hash, null), TestContext.Current.CancellationToken);

        var found = await service.GetBySourceHashAsync(Hash, blank, TestContext.Current.CancellationToken);

        Assert.Equal(shared.Id, found.Id);
    }

    [Fact]
    public async Task AnUnregisteredInstanceIdIsNotFoundEvenWhenASharedRowExists()
    {
        // The no-fallback rule, and the reason the whole feature is safe to deploy. Resolving the
        // shared row here would hand fetcher-3 an identity belonging to every other replica, and it
        // would go on to consume their work queue. Not-found leaves it waiting and visible instead.
        using var db = NewContext();
        var service = NewService(db);
        await service.CreateAsync(Create(Hash, null), TestContext.Current.CancellationToken);
        await service.CreateAsync(Create(Hash, "fetcher-0"), TestContext.Current.CancellationToken);

        var ex = await Assert.ThrowsAsync<NotFoundException>(
            () => service.GetBySourceHashAsync(Hash, "fetcher-3", TestContext.Current.CancellationToken));

        // The instance id belongs in the message. Without it, "no processor for hash abc…" sends an
        // operator to register a row that already exists.
        Assert.Contains("fetcher-3", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task NoInstanceIdIsNotFoundWhenEveryRowForThatHashClaimsOne()
    {
        // The mirror case: a Deployment pod still running against a build whose rows have all been
        // converted to per-replica registrations. Picking one arbitrarily would put it on a queue
        // that belongs to a named replica.
        using var db = NewContext();
        var service = NewService(db);
        await service.CreateAsync(Create(Hash, "fetcher-0"), TestContext.Current.CancellationToken);
        await service.CreateAsync(Create(Hash, "fetcher-1"), TestContext.Current.CancellationToken);

        await Assert.ThrowsAsync<NotFoundException>(
            () => service.GetBySourceHashAsync(Hash, null, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task AnAbsentHashIsNotFoundWhateverTheInstanceId()
    {
        using var db = NewContext();
        var service = NewService(db);
        await service.CreateAsync(Create(Hash, "fetcher-0"), TestContext.Current.CancellationToken);

        await Assert.ThrowsAsync<NotFoundException>(
            () => service.GetBySourceHashAsync(OtherHash, "fetcher-0", TestContext.Current.CancellationToken));
        await Assert.ThrowsAsync<NotFoundException>(
            () => service.GetBySourceHashAsync(OtherHash, null, TestContext.Current.CancellationToken));
    }

    // ---------------------------------------------------------------- the pod's side

    [Fact]
    public void AnUnsetConfigurationKeyMeansTheSharedRow()
    {
        // This is what keeps the feature inert for everything already deployed. Every processor in
        // the cluster is a Deployment, none of them sets the key, so all of them go on asking by hash
        // alone and resolving the row they resolve today.
        var provider = new ConfigurationProcessorInstanceIdProvider(
            new ConfigurationBuilder().Build());

        Assert.Null(provider.Get());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ABlankConfigurationValueReadsAsAbsentRatherThanAsAnInstanceNamedNothing(string value)
    {
        // A downward-API field that does not resolve arrives as an empty string, not as a missing
        // variable — the same trap InstanceId.Resolve documents.
        var provider = new ConfigurationProcessorInstanceIdProvider(
            new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    [ConfigurationProcessorInstanceIdProvider.Key] = value,
                })
                .Build());

        Assert.Null(provider.Get());
    }

    [Fact]
    public void AConfiguredInstanceIdIsReadAndTrimmed()
    {
        var provider = new ConfigurationProcessorInstanceIdProvider(
            new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    [ConfigurationProcessorInstanceIdProvider.Key] = "  fetcher-2 ",
                })
                .Build());

        Assert.Equal("fetcher-2", provider.Get());
    }

    [Fact]
    public void TheConfigurationKeyIsTheOneAManifestWouldSet()
    {
        // Pinned because a manifest spells it with the double underscore an environment variable
        // needs, and nothing else in the build would catch a rename on this side.
        Assert.Equal("Processor:InstanceId", ConfigurationProcessorInstanceIdProvider.Key);
    }
}

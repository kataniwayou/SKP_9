using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// Pins the parts of the cache's mapping that are invisible at the C# level and expensive to get
/// wrong: the column type and the index name.
/// <para>
/// The index name matters beyond tidiness. <c>PostgresExceptionMapper</c> resolves the offending
/// column from a constraint name by stripping a <c>{kind}_{owner}_</c> prefix built from the table
/// name, so a duplicate root reports the column as <c>root</c> only while the index is called
/// <c>uq_cache_root</c>. Nothing else in the suite would notice it being renamed.
/// </para>
/// </summary>
public sealed class CacheModelTests
{
    private static AppDbContext NewContext() =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"cache-model-{Guid.NewGuid():N}")
            .Options);

    [Fact]
    public void ItemsIsStoredAsJsonb()
    {
        using var db = NewContext();

        var property = db.Model.FindEntityType(typeof(CacheEntity))!
            .FindProperty(nameof(CacheEntity.Items))!;

        // GetColumnType() cannot be used against the InMemory provider: it unconditionally tries
        // to resolve a relational type mapping, which InMemory has none of, and throws
        // InvalidCastException. HasColumnType() sets the "Relational:ColumnType" annotation
        // directly on the mutable model regardless of provider, so read that annotation instead —
        // it still pins the exact thing this test exists to pin.
        Assert.Equal("jsonb", property["Relational:ColumnType"]);
        Assert.False(property.IsNullable);
    }

    [Fact]
    public void RootIsRequiredAndBounded()
    {
        using var db = NewContext();

        var property = db.Model.FindEntityType(typeof(CacheEntity))!
            .FindProperty(nameof(CacheEntity.Root))!;

        Assert.False(property.IsNullable);
        Assert.Equal(200, property.GetMaxLength());
    }

    [Fact]
    public void RootCarriesTheUniqueIndexTheExceptionMapperCanParse()
    {
        using var db = NewContext();

        var index = db.Model.FindEntityType(typeof(CacheEntity))!
            .GetIndexes()
            .Single(i => i.Properties.Any(p => p.Name == nameof(CacheEntity.Root)));

        Assert.True(index.IsUnique);
        Assert.Equal("uq_cache_root", index.GetDatabaseName());
    }

    [Fact]
    public void TheCacheReferencesNothing()
    {
        // It is a root of the foreign-key graph, beside the schema. A foreign key appearing here
        // would mean the cache had acquired a dependency the projection would have to resolve.
        using var db = NewContext();

        Assert.Empty(db.Model.FindEntityType(typeof(CacheEntity))!.GetForeignKeys());
    }
}

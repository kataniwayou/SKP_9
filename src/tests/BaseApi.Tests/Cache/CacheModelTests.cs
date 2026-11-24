using BaseApi.Service;
using BaseApi.Service.Features.Cache;
using BaseApi.Tests.Support;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// Pins the parts of the cache's mapping that are invisible at the C# level and expensive to get
/// wrong: where the items live, the keys and the index name.
/// <para>
/// The index name matters beyond tidiness. <c>PostgresExceptionMapper</c> resolves the offending
/// column from a constraint name by stripping a <c>{kind}_{owner}_</c> prefix built from the table
/// name, so a duplicate root reports the column as <c>root</c> only while the index is called
/// <c>uq_cache_root</c>. Nothing else in the suite would notice it being renamed.
/// </para>
/// <para>
/// The items are rows of their own (<c>cache_items</c>), one per key, not a document in a column: a
/// dictionary is no longer capped as a whole, and the database itself refuses a key twice.
/// </para>
/// </summary>
public sealed class CacheModelTests
{
    // Npgsql-configured, never connected: table and column names are relational conventions, which the
    // InMemory provider does not apply.
    private static AppDbContext NewContext() => NpgsqlModel.Context();

    private static IEntityType Items(AppDbContext db) => db.Model.FindEntityType(typeof(CacheItem))!;

    [Fact]
    public void TheCachesTableHasNoItemsColumn()
    {
        using var db = NewContext();

        var cache = db.Model.FindEntityType(typeof(CacheEntity))!;

        Assert.Null(cache.FindProperty("Items"));
        Assert.DoesNotContain(cache.GetProperties(), p => p.GetColumnName() == "items");
    }

    [Fact]
    public void ItemsLiveInTheCacheItemsTable()
    {
        using var db = NewContext();

        Assert.Equal("cache_items", Items(db).GetTableName());
    }

    [Fact]
    public void AnItemIsKeyedByItsCacheAndItsKey()
    {
        // The primary key is the uniqueness rule: one value per key per dictionary, refused by the
        // database even when a write path skips the validator.
        using var db = NewContext();

        var key = Items(db).FindPrimaryKey()!;

        Assert.Equal([nameof(CacheItem.CacheId), nameof(CacheItem.Key)], key.Properties.Select(p => p.Name));
    }

    [Fact]
    public void TheKeyIsRequiredAndBounded()
    {
        using var db = NewContext();

        var key = Items(db).FindProperty(nameof(CacheItem.Key))!;

        Assert.False(key.IsNullable);
        Assert.Equal(CacheRules.MaxKeyLength, key.GetMaxLength());
        Assert.Equal("key", key.GetColumnName());
    }

    [Fact]
    public void TheValueIsRequiredUnboundedText()
    {
        using var db = NewContext();

        var value = Items(db).FindProperty(nameof(CacheItem.Value))!;

        Assert.False(value.IsNullable);
        Assert.Null(value.GetMaxLength());
        Assert.Equal("text", value.GetColumnType());
    }

    [Fact]
    public void ItemsCascadeWithTheirCacheUnderANamedConstraint()
    {
        using var db = NewContext();

        var fk = Assert.Single(Items(db).GetForeignKeys());

        Assert.Equal(typeof(CacheEntity), fk.PrincipalEntityType.ClrType);
        Assert.Equal([nameof(CacheItem.CacheId)], fk.Properties.Select(p => p.Name));
        Assert.Equal(DeleteBehavior.Cascade, fk.DeleteBehavior);
        Assert.Equal("fk_cache_items_cache_id", fk.GetConstraintName());
    }

    [Fact]
    public void ACacheAlwaysLoadsItsItems()
    {
        // Every reader (the generic repository, the graph loader, the refresh handler, the design
        // save) queries CacheEntity without naming the items; auto-include is what keeps each of them
        // from seeing an empty dictionary.
        using var db = NewContext();

        var navigation = db.Model.FindEntityType(typeof(CacheEntity))!.FindNavigation(nameof(CacheEntity.Items))!;

        Assert.True(navigation.IsCollection);
        Assert.True(navigation.IsEagerLoaded);
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
        // It is a root of the foreign-key graph, beside the schema. Its items reference it, not the
        // other way round; a foreign key appearing here would mean the cache had acquired a
        // dependency the projection would have to resolve.
        using var db = NewContext();

        Assert.Empty(db.Model.FindEntityType(typeof(CacheEntity))!.GetForeignKeys());
    }
}

using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Xunit;

namespace BaseApi.Tests.Persistence;

/// <summary>
/// A cache's items move from one <c>jsonb</c> document on <c>caches</c> to rows of their own in <c>cache_items</c>
/// (2026-11-24). The table is created, each stored pair is copied into it, and only then is the column dropped — in
/// the other order the dictionaries are lost. Down rebuilds each document from the rows before dropping the table.
/// </summary>
public sealed class CacheItemsTableMigrationTests
{
    private const string Previous = "20261124180000_RemoveWorkflowCron";
    private const string ThisOne = "20261125120000_CacheItemsTable";

    private static string Script(string from, string to)
    {
        using var db = Molecule.ModelRelationsTests.NpgsqlModelContext();
        return db.GetService<IMigrator>().GenerateScript(from, to);
    }

    [Fact]
    public void UpCreatesTheTableKeyedByCacheAndKeyCascadingWithItsCache()
    {
        var up = Script(Previous, ThisOne);

        Assert.Contains("CREATE TABLE cache_items (", up);
        Assert.Contains("key character varying(256) NOT NULL,", up);
        Assert.Contains("value text NOT NULL,", up);
        Assert.Contains("CONSTRAINT pk_cache_items PRIMARY KEY (cache_id, key),", up);
        Assert.Contains("CONSTRAINT fk_cache_items_cache_id FOREIGN KEY (cache_id) REFERENCES caches (id) ON DELETE CASCADE", up);
    }

    [Fact]
    public void UpCopiesEveryPairBeforeDroppingTheColumn()
    {
        var up = Script(Previous, ThisOne);

        const string create = "CREATE TABLE cache_items (";
        const string copy = "INSERT INTO cache_items (cache_id, key, value) " +
                            "SELECT c.id, e.key, e.value FROM caches c CROSS JOIN LATERAL jsonb_each_text(c.items) e;";
        const string drop = "ALTER TABLE caches DROP COLUMN items;";
        var createAt = up.IndexOf(create, StringComparison.Ordinal);
        var copyAt = up.IndexOf(copy, StringComparison.Ordinal);
        var dropAt = up.IndexOf(drop, StringComparison.Ordinal);

        Assert.True(createAt >= 0, up);
        Assert.True(copyAt > createAt, up);
        Assert.True(dropAt > copyAt, up);
    }

    [Fact]
    public void DownRebuildsEachDocumentFromItsRowsBeforeDroppingTheTable()
    {
        var down = Script(ThisOne, Previous);

        const string add = "ALTER TABLE caches ADD items jsonb NOT NULL DEFAULT '{}';";
        const string rebuild = "UPDATE caches c SET items = COALESCE(" +
                               "(SELECT jsonb_object_agg(i.key, i.value) FROM cache_items i WHERE i.cache_id = c.id), '{}'::jsonb);";
        const string drop = "DROP TABLE cache_items;";
        var addAt = down.IndexOf(add, StringComparison.Ordinal);
        var rebuildAt = down.IndexOf(rebuild, StringComparison.Ordinal);
        var dropAt = down.IndexOf(drop, StringComparison.Ordinal);

        Assert.True(addAt >= 0, down);
        Assert.True(rebuildAt > addAt, down);
        Assert.True(dropAt > rebuildAt, down);
    }
}

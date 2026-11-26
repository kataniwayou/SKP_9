using Npgsql;
using Xunit;

namespace BaseApi.Tests.Support;

[Collection("Postgres")]
public sealed class PostgresFixtureTests(PostgresFixture pg)
{
    [Fact]
    public async Task MigratedDatabaseHasCacheItemsTable()
    {
        PostgresFixture.SkipUnlessEnabled();

        await using var conn = new NpgsqlConnection(pg.ConnectionString);
        await conn.OpenAsync(TestContext.Current.CancellationToken);
        await using var cmd = new NpgsqlCommand(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = 'cache_items'", conn);
        Assert.Equal(1L, await cmd.ExecuteScalarAsync(TestContext.Current.CancellationToken));
    }
}

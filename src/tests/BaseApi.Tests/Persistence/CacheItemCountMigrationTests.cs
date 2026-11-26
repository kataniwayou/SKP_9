using BaseApi.Service;
using BaseApi.Tests.Support;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using Xunit;

namespace BaseApi.Tests.Persistence;

/// <summary>
/// The stored <c>item_count</c> is backfilled from the rows already there. Needs a real database, migrated to
/// the step before this one on its own throwaway database, so the fixture's fully migrated one is not used.
/// </summary>
[Collection("Postgres")]
public sealed class CacheItemCountMigrationTests(PostgresFixture fixture)
{
    [Fact]
    public async Task CacheItemCountMigrationAddsColumnAndBackfills()
    {
        PostgresFixture.SkipUnlessEnabled();

        var server = new NpgsqlConnectionStringBuilder(fixture.ConnectionString);
        var database = $"skp_test_{Guid.NewGuid():N}";
        var maintenance = new NpgsqlConnectionStringBuilder(server.ConnectionString) { Database = "postgres", Pooling = false };
        await Exec(maintenance.ConnectionString, $"CREATE DATABASE \"{database}\"");

        try
        {
            server.Database = database;
            await using var db = new AppDbContext(
                new DbContextOptionsBuilder<AppDbContext>().UseNpgsql(server.ConnectionString).Options);
            var migrator = db.GetService<IMigrator>();

            await migrator.MigrateAsync("20261126120000_AddSchemaProcessorLocations", Ct);

            var id = Guid.NewGuid();
            await Exec(server.ConnectionString,
                $"INSERT INTO caches (id, name, version, root, created_at, updated_at) " +
                $"VALUES ('{id}', 'c', '1.0.0', 'r', now(), now()); " +
                $"INSERT INTO cache_items (cache_id, key, value) VALUES ('{id}', 'a', '1'), ('{id}', 'b', '2'), ('{id}', 'c', '3')");

            await migrator.MigrateAsync(cancellationToken: Ct);

            await using var conn = new NpgsqlConnection(server.ConnectionString);
            await conn.OpenAsync(Ct);
            await using var cmd = new NpgsqlCommand($"SELECT item_count FROM caches WHERE id = '{id}'", conn);
            Assert.Equal(3, (int)(await cmd.ExecuteScalarAsync(Ct))!);
        }
        finally
        {
            NpgsqlConnection.ClearAllPools();
            await Exec(maintenance.ConnectionString, $"DROP DATABASE IF EXISTS \"{database}\" WITH (FORCE)");
        }
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task Exec(string connectionString, string sql)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync(Ct);
        await using var cmd = new NpgsqlCommand(sql, conn);
        await cmd.ExecuteNonQueryAsync(Ct);
    }
}

using BaseApi.Core.Persistence.Interceptors;
using BaseApi.Service;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Xunit;

namespace BaseApi.Tests.Support;

/// <summary>
/// A real, migrated Postgres database for the tests that run set-based SQL (<c>unnest</c>,
/// <c>ON CONFLICT</c>) the EF in-memory provider cannot. Enabled by <c>SKP_TEST_PG</c>, a connection
/// string to a server (any database; e.g. <c>Host=localhost;Port=15432;Username=postgres;Password=pg</c>).
/// One throwaway database <c>skp_test_{guid}</c> is created per fixture and dropped on dispose.
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    private const string EnvName = "SKP_TEST_PG";
    private string? _database;

    public static bool Enabled => !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(EnvName));

    public static void SkipUnlessEnabled() =>
        Assert.SkipUnless(Enabled, $"set {EnvName} to a Postgres connection string to run the set-based SQL tests");

    /// <summary>Connection string of the throwaway database; empty when the fixture is not enabled.</summary>
    public string ConnectionString { get; private set; } = "";

    public async ValueTask InitializeAsync()
    {
        if (!Enabled) return;

        var admin = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable(EnvName)!);
        _database = $"skp_test_{Guid.NewGuid():N}";
        await ExecuteAdminAsync(admin, $"CREATE DATABASE \"{_database}\"");

        admin.Database = _database;
        ConnectionString = admin.ConnectionString;

        await using var db = NewContext();
        await db.Database.MigrateAsync();
    }

    public async ValueTask DisposeAsync()
    {
        if (_database is null) return;

        NpgsqlConnection.ClearAllPools();
        var admin = new NpgsqlConnectionStringBuilder(Environment.GetEnvironmentVariable(EnvName)!);
        await ExecuteAdminAsync(admin, $"DROP DATABASE IF EXISTS \"{_database}\" WITH (FORCE)");
    }

    /// <summary>A context on the migrated database, stamping audit columns from <paramref name="clock"/>.</summary>
    public AppDbContext NewContext(TimeProvider? clock = null) => new(
        new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(ConnectionString)
            .AddInterceptors(new AuditInterceptor(new HttpContextAccessor(), clock ?? TimeProvider.System))
            .Options);

    private static async Task ExecuteAdminAsync(NpgsqlConnectionStringBuilder admin, string sql)
    {
        // The maintenance database always exists; the caller's may be the one being dropped.
        var b = new NpgsqlConnectionStringBuilder(admin.ConnectionString) { Database = "postgres", Pooling = false };
        await using var conn = new NpgsqlConnection(b.ConnectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await cmd.ExecuteNonQueryAsync();
    }
}

[CollectionDefinition("Postgres")]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;

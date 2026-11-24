using BaseApi.Service;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Tests.Support;

/// <summary>
/// A context configured for Npgsql that never connects: the relational model (table and column names, store types,
/// migrations' SQL) exists only on a relational provider, which the in-memory one is not.
/// </summary>
internal static class NpgsqlModel
{
    public static AppDbContext Context() =>
        new(new DbContextOptionsBuilder<AppDbContext>().UseNpgsql("Host=unused;Database=unused").Options);
}

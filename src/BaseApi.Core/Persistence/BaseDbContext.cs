using Microsoft.EntityFrameworkCore;
using BaseApi.Core.Entities;

namespace BaseApi.Core.Persistence;

/// <summary>
/// Abstract base for every context in this ecosystem.
///
/// <para>
/// Concrete contexts derive from this and add their <c>DbSet</c> properties. This base has none; it
/// provides three concerns — snake_case naming, audit interception and an <c>xmin</c> concurrency
/// token on every <see cref="BaseEntity"/> subclass.
/// </para>
///
/// <para>
/// <c>OnConfiguring</c> repeats the snake_case call that the composition root also performs. The
/// duplication is deliberate defence in depth: test paths that build options directly, without the
/// composition root, still get the right configuration. The audit interceptor is wired by the
/// composition root or the test fixture through <c>AddInterceptors</c>, never here.
/// </para>
///
/// <para>
/// The naming convention is applied here so it is active before any migration is generated.
/// </para>
/// </summary>
public abstract class BaseDbContext : DbContext
{
    protected BaseDbContext(DbContextOptions options) : base(options) { }

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    {
        base.OnConfiguring(optionsBuilder);
        optionsBuilder.UseSnakeCaseNamingConvention();
        // The audit interceptor is wired via AddInterceptors at the composition root or in the test
        // fixture's options builder — not here.
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        // An xmin shadow concurrency token on every BaseEntity subclass. Junction entities are
        // excluded naturally, because they do not derive from BaseEntity. xmin is Postgres's xid
        // system column: the column name and type pin the mapping, and ValueGeneratedOnAddOrUpdate
        // tells EF that Postgres maintains the value itself.
        foreach (var entityType in modelBuilder.Model.GetEntityTypes()
            .Where(t => typeof(BaseEntity).IsAssignableFrom(t.ClrType)))
        {
            modelBuilder.Entity(entityType.ClrType)
                .Property<uint>("xmin")
                .HasColumnName("xmin")
                .HasColumnType("xid")
                .ValueGeneratedOnAddOrUpdate()
                .IsConcurrencyToken();
        }
    }
}

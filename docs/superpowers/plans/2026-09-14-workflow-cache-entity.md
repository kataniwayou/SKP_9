# Workflow Cache Entity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workflow may name any number of `CacheEntity` rows; starting the workflow writes each one's key/value dictionary into Redis under `skp:{workflowId}:cache:{root}`, and stopping it deletes them.

**Architecture:** `CacheEntity` is a new `BaseEntity` modelled on `AssignmentEntity` — one required `jsonb` column plus a unique `Root` scalar — linked to the workflow through a `WorkflowCaches` junction modelled on `WorkflowAssignments`. The dictionaries travel to the projection on `WorkflowL1` and are written and removed inside the batches `L2ProjectionWriter` and `L2Cleanup` already build, so no new handler, message type or orchestration gate is introduced. Processors are handed a full address in their step payload and compose nothing; `SKNormalizerConfig` gains an unused `CacheAddress` seam.

**Tech Stack:** .NET 8, EF Core 8 (Npgsql, `jsonb`), FluentValidation, Riok.Mapperly, StackExchange.Redis, xUnit v3 on Microsoft.Testing.Platform.

**Spec:** `docs/superpowers/specs/2026-09-14-workflow-cache-entity-design.md`

## Global Constraints

- **Table names are plural, constraint names are singular.** Tables come from the `DbSet` property name (`schemas`, `processors`, `assignments`); constraint names use the singular owner. `PostgresExceptionMapper.ExtractColumn` strips a `{kind}_{owner}_` prefix using the table name, trying the exact name then its s-stripped singular. So with `DbSet<CacheEntity> Caches`: table `caches`, unique index **`uq_cache_root`**. `uq_cache_entity_root` would report the offending column as `entity_root`.
- **No navigation properties, anywhere.** Relationships are declared with `HasOne<T>().WithMany()` and no lambdas, so EF creates the foreign key without generating navigations. Collections live on DTOs and are kept in step by `SyncJunctionsAsync` / `EnrichReadAsync`.
- **Junction entities must not derive from `BaseEntity`.** That is what excludes them from the `xmin` shadow-token loop in `BaseDbContext.OnModelCreating`.
- **`BaseApi.Core` and `Messaging.Contracts` are consumed as NuGet packages, not project references.** After editing either, `bash scripts/pack-all.sh` must run or every consumer compiles against the previous package contents. This affects Task 4.
- **Colons are forbidden in `Root` and in every `Items` key.** The L2 address is built by concatenation, so root `a` + key `b:c` and root `a:b` + key `c` produce the same string.
- **`Items` cap: 1 048 576 characters**, matching `AssignmentEntity.Payload`.
- **`Root` max length: 200.**
- **No TTL on any L2 key, ever.** Reclaim is explicit on stop.
- **Test commands.** Build: `dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo`. Run one class: `src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "<FQN>"`. Run one method: `--filter-method "<FQN>.<Method>"`. Full hermetic suite: `--filter-not-namespace "BaseApi.Tests.Live*"`. **Do not use `dotnet test`** — it reports counts only and hides which tests failed. The `--filter "Category!=…"` form is silently ignored by this runner; the `--filter-class` / `--filter-not-namespace` options above are the ones it actually implements.

---

## File Structure

**New — `src/BaseApi.Service/Features/Cache/`** (the feature, modelled file-for-file on `Features/Assignment/`)

| File | Responsibility |
|---|---|
| `CacheEntity.cs` | The entity: `Root` (trimmed on assignment) and `Items` (jsonb) |
| `CacheDtos.cs` | Create / Update / Read records |
| `CacheDtoValidator.cs` | Both validators plus the `CacheRules` helper they share |
| `CacheEntityMapper.cs` | Mapperly mapper, ignoring the five server-controlled targets |
| `CacheService.cs` | `BaseService` subclass with no overrides |
| `CacheController.cs` | `BaseController` shell |
| `CacheServiceCollectionExtensions.cs` | `AddCacheFeature()` |

**New — elsewhere**

| File | Responsibility |
|---|---|
| `src/BaseApi.Service/Features/Workflow/WorkflowCaches.cs` | The junction row |
| `src/BaseApi.Service/Persistence/Configurations/CacheEntityConfiguration.cs` | jsonb column, length, unique index |
| `src/BaseApi.Service/Persistence/Configurations/WorkflowCachesConfiguration.cs` | Composite key, two foreign keys |
| `src/BaseApi.Service/Persistence/Migrations/<stamp>_AddCacheEntity.cs` | Both tables (EF-generated) |
| `src/Messaging.Contracts/CacheL1.cs` | The wire record for one cache |
| `src/tests/BaseApi.Tests/Cache/*.cs` | Five test classes |

**Modified**

| File | Change |
|---|---|
| `src/BaseApi.Service/AppDbContext.cs` | Two `DbSet`s |
| `src/BaseApi.Service/Composition/AppFeatures.cs` | One registration |
| `src/BaseApi.Service/Features/Workflow/WorkflowDtos.cs` | `CacheIds` on all three records |
| `src/BaseApi.Service/Features/Workflow/WorkflowDtoValidator.cs` | One rule pair, twice |
| `src/BaseApi.Service/Features/Workflow/WorkflowService.cs` | Third junction in both overrides |
| `src/BaseApi.Service/Features/Orchestration/Loading/WorkflowGraphLoader.cs` | Third junction read, cache batch |
| `src/BaseApi.Service/Features/Orchestration/WorkflowGraphSnapshot.cs` | `Caches` dictionary |
| `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs` | `ToDefinition` only |
| `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs` | Cache writes in the existing batch |
| `src/BaseApi.Service/Features/Orchestration/Projection/L2Cleanup.cs` | Cache deletes in the existing batch |
| `src/Messaging.Contracts/WorkflowL1.cs` | `Caches` on `WorkflowL1` |
| `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs` | Two builders |
| `src/Messaging.Contracts/Projections/WorkflowRootProjection.cs` | `cacheRoots` |
| `src/Processor.SKNormalizer/SKNormalizerConfig.cs` | One property |
| `src/tests/BaseApi.Tests/Orchestration/WorkflowReadEnrichmentTests.cs` | New DTO argument |
| `src/tests/BaseApi.Tests/Validation/NullCollectionCascadeTests.cs` | New DTO argument |

---

## Task 1: The `CacheEntity` feature

**Files:**
- Create: `src/BaseApi.Service/Features/Cache/CacheEntity.cs`
- Create: `src/BaseApi.Service/Features/Cache/CacheDtos.cs`
- Create: `src/BaseApi.Service/Features/Cache/CacheDtoValidator.cs`
- Create: `src/BaseApi.Service/Features/Cache/CacheEntityMapper.cs`
- Create: `src/BaseApi.Service/Features/Cache/CacheService.cs`
- Create: `src/BaseApi.Service/Features/Cache/CacheController.cs`
- Create: `src/BaseApi.Service/Features/Cache/CacheServiceCollectionExtensions.cs`
- Create: `src/BaseApi.Service/Persistence/Configurations/CacheEntityConfiguration.cs`
- Modify: `src/BaseApi.Service/AppDbContext.cs`
- Modify: `src/BaseApi.Service/Composition/AppFeatures.cs`
- Test: `src/tests/BaseApi.Tests/Cache/CacheDtoValidatorTests.cs`
- Test: `src/tests/BaseApi.Tests/Cache/CacheModelTests.cs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BaseApi.Service.Features.Cache.CacheEntity` with `string Root` and `string Items`; `CacheCreateDto(string Name, string Version, string? Description, string Root, string Items)`; `CacheUpdateDto` with the same shape; `CacheReadDto(Guid Id, string Name, string Version, string? Description, string Root, string Items, DateTime CreatedAt, DateTime UpdatedAt, string? CreatedBy, string? UpdatedBy)`; `CacheCreateDtoValidator`; `CacheUpdateDtoValidator`; `CacheEntityMapper`; `CacheService`; `IServiceCollection.AddCacheFeature()`; `AppDbContext.Caches`.

- [ ] **Step 1: Write the failing validator tests**

Create `src/tests/BaseApi.Tests/Cache/CacheDtoValidatorTests.cs`:

```csharp
using BaseApi.Service.Features.Cache;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The cache's two fields carry rules that nothing downstream re-checks. The colon rule is the one
/// worth stating twice: the L2 address is built by concatenating root, ':' and key, so a colon
/// inside either half forges a different address — root "a" with key "b:c" and root "a:b" with key
/// "c" produce one string, and one dictionary then answers for the other.
/// </summary>
public sealed class CacheDtoValidatorTests
{
    private static CacheCreateDto Dto(string root, string items) =>
        new("cache-name", "1.0.0", null, root, items);

    private static bool IsValid(string root, string items) =>
        new CacheCreateDtoValidator().Validate(Dto(root, items)).IsValid;

    private static string FirstError(string root, string items) =>
        new CacheCreateDtoValidator().Validate(Dto(root, items)).Errors[0].ErrorMessage;

    [Fact]
    public void AFlatObjectOfStringsIsAccepted()
    {
        Assert.True(IsValid("sk-whitelist", """{"acme":"1","alphabeta":"1"}"""));
    }

    [Fact]
    public void AnEmptyObjectIsAccepted()
    {
        // "Allow nothing" is a legitimate configuration, and refusing it would refuse a valid intent.
        Assert.True(IsValid("sk-whitelist", "{}"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ABlankRootIsRejected(string root)
    {
        Assert.False(IsValid(root, "{}"));
    }

    [Fact]
    public void ARootCarryingAColonIsRejected()
    {
        Assert.Contains("':'", FirstError("sk:whitelist", "{}"));
    }

    [Fact]
    public void AKeyCarryingAColonIsRejected()
    {
        Assert.Contains("':'", FirstError("sk-whitelist", """{"a:b":"1"}"""));
    }

    [Fact]
    public void AnEmptyKeyIsRejected()
    {
        Assert.Contains("empty key", FirstError("sk-whitelist", """{"":"1"}"""));
    }

    [Fact]
    public void ANonStringValueIsRejected()
    {
        Assert.Contains("must be a string", FirstError("sk-whitelist", """{"acme":1}"""));
    }

    [Fact]
    public void AnArrayIsRejected()
    {
        Assert.Contains("must be a JSON object", FirstError("sk-whitelist", """["acme"]"""));
    }

    [Fact]
    public void ItemsThatAreNotJsonAreRejected()
    {
        Assert.Contains("not valid JSON", FirstError("sk-whitelist", "not json"));
    }

    [Fact]
    public void EmptyItemsAreRejected()
    {
        // Distinct from "{}": the column is required, so an absent document is not the same as an
        // empty dictionary.
        Assert.False(IsValid("sk-whitelist", ""));
    }

    [Fact]
    public void TheUpdateValidatorAppliesTheSameRules()
    {
        // Create and update must agree about what a valid dictionary is; they share CacheRules so
        // that they cannot drift.
        var result = new CacheUpdateDtoValidator()
            .Validate(new CacheUpdateDto("cache-name", "1.0.0", null, "sk:whitelist", "{}"));

        Assert.False(result.IsValid);
    }

    [Fact]
    public void TheEntityTrimsItsRootOnAssignment()
    {
        // The invariant lives on the data, following ProcessorEntity.InstanceId, so no write path
        // can route around it — a root arriving with a stray space from a manifest still compares
        // equal to one registered through the API.
        var entity = new CacheEntity { Root = "  sk-whitelist  " };

        Assert.Equal("sk-whitelist", entity.Root);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
```

Expected: FAIL to compile, with `CS0234`/`CS0246` — the namespace `BaseApi.Service.Features.Cache` and every type in it do not exist.

- [ ] **Step 3: Write the entity**

Create `src/BaseApi.Service/Features/Cache/CacheEntity.cs`:

```csharp
using BaseApi.Core.Entities;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// Cache domain entity — a named dictionary a workflow projects into L2 for the duration of a run.
/// <para>
/// It sits beside <c>SchemaEntity</c> as a second root of the foreign-key graph: it references
/// nothing, and is referenced only through the <c>WorkflowCaches</c> junction.
/// </para>
/// <para>
/// <c>Items</c> stores a flat JSON object of string to string as a Postgres <c>jsonb</c> column,
/// wired by <c>CacheEntityConfiguration</c>. The validator enforces the shape — an object, string
/// values, no empty or colon-bearing keys — before it is persisted.
/// </para>
/// <para>
/// <b>Neither <c>Root</c> nor any key may contain a colon, and that is load-bearing.</b> The L2
/// address is built by concatenating the root, a colon and the key, so a colon inside either half
/// forges a different address: root <c>a</c> with key <c>b:c</c> and root <c>a:b</c> with key
/// <c>c</c> produce one string. <c>Root</c> is unique across the table for the same reason — it
/// appears verbatim in the address, so two rows sharing one would have the second write silently
/// overwrite the first.
/// </para>
/// </summary>
public sealed class CacheEntity : BaseEntity
{
    private string _root = string.Empty;

    /// <summary>
    /// The key prefix this dictionary is projected under. Trimmed on assignment, following
    /// <c>ProcessorEntity.InstanceId</c> — the invariant goes on the data, where no write path can
    /// route around it.
    /// <para>
    /// Unlike <c>InstanceId</c>, blank is <b>not</b> normalized to null: "no root" is not a
    /// meaningful state here, so the validator refuses it and the column is required.
    /// </para>
    /// </summary>
    public string Root
    {
        get => _root;
        set => _root = value?.Trim() ?? string.Empty;
    }

    public string Items { get; set; } = string.Empty;
}
```

- [ ] **Step 4: Write the DTOs**

Create `src/BaseApi.Service/Features/Cache/CacheDtos.cs`:

```csharp
using BaseApi.Core.Contracts;
using BaseApi.Core.Validation;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// Create-side DTO. Server-controlled fields are deliberately absent: the mapper cannot map what is
/// not on the source.
/// </summary>
public sealed record CacheCreateDto(
    string Name,
    string Version,
    string? Description,
    string Root,
    string Items) : IBaseDto;

/// <summary>
/// Update-side DTO. Server-controlled fields are absent here, and the mapper's <c>Update</c> method
/// additionally ignores them on the target side.
/// </summary>
public sealed record CacheUpdateDto(
    string Name,
    string Version,
    string? Description,
    string Root,
    string Items) : IBaseDto;

/// <summary>
/// Read-side DTO returned to clients, carrying the id and the audit fields. It implements
/// <see cref="IHasId"/> so the base controller can read the id when building the created-at
/// response.
/// </summary>
public sealed record CacheReadDto(
    Guid Id,
    string Name,
    string Version,
    string? Description,
    string Root,
    string Items,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedBy,
    string? UpdatedBy) : IBaseDto, IHasId;
```

- [ ] **Step 5: Write the validators**

Create `src/BaseApi.Service/Features/Cache/CacheDtoValidator.cs`:

```csharp
using System.Text.Json;
using BaseApi.Core.Validation;
using FluentValidation;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// The shape rules both cache validators apply.
/// <para>
/// They are shared rather than duplicated — which is the local convention — because they are long
/// enough that a copy would drift, and create and update disagreeing about what a valid dictionary
/// is would mean a row that can be written but not edited.
/// </para>
/// </summary>
internal static class CacheRules
{
    public const int MaxItemsBytes = 1_048_576; // roughly 1 MB, matching AssignmentEntity.Payload

    public const int MaxRootLength = 200;

    /// <summary>
    /// Refuses a blank root, and one carrying a colon. See <c>CacheEntity</c> for why the colon
    /// matters: the address is a concatenation, so a colon on either side of it forges another
    /// dictionary's address.
    /// </summary>
    public static void CheckRoot<T>(string root, ValidationContext<T> ctx, string property)
    {
        if (string.IsNullOrWhiteSpace(root))
        {
            ctx.AddFailure(property, "Root must not be empty.");
            return;
        }

        if (root.Contains(':'))
        {
            ctx.AddFailure(property, "Root must not contain ':'.");
        }
    }

    /// <summary>
    /// Confirms the document parses, is an object, and holds only non-empty colon-free keys mapping
    /// to string values. It reports the first offending pair rather than all of them: the author is
    /// fixing a document by hand, and one precise name is more use than a list.
    /// </summary>
    public static void CheckItems<T>(string items, ValidationContext<T> ctx, string property)
    {
        if (string.IsNullOrEmpty(items))
        {
            return; // NotEmpty has already reported this; a second failure would just be noise.
        }

        JsonDocument document;

        try
        {
            document = JsonDocument.Parse(items);
        }
        catch (JsonException ex)
        {
            ctx.AddFailure(property, $"Items is not valid JSON: {ex.Message}");
            return;
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                ctx.AddFailure(property, "Items must be a JSON object.");
                return;
            }

            foreach (var pair in document.RootElement.EnumerateObject())
            {
                if (pair.Name.Length == 0)
                {
                    ctx.AddFailure(property, "Items must not contain an empty key.");
                    return;
                }

                if (pair.Name.Contains(':'))
                {
                    ctx.AddFailure(property, $"Items key '{pair.Name}' must not contain ':'.");
                    return;
                }

                if (pair.Value.ValueKind != JsonValueKind.String)
                {
                    ctx.AddFailure(property, $"Items value for key '{pair.Name}' must be a string.");
                    return;
                }
            }
        }
    }
}

/// <summary>Create-side rules. The cascade stops match <c>AssignmentDtoValidator</c>.</summary>
public sealed class CacheCreateDtoValidator : AbstractValidator<CacheCreateDto>
{
    public CacheCreateDtoValidator()
    {
        Include(new BaseDtoValidator<CacheCreateDto>());

        RuleFor(x => x.Root)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .MaximumLength(CacheRules.MaxRootLength)
            .WithMessage($"Root must be at most {CacheRules.MaxRootLength} characters.")
            .Custom((root, ctx) => CacheRules.CheckRoot(root, ctx, nameof(CacheCreateDto.Root)));

        // The cascade stop is load-bearing, not cosmetic: FluentValidation continues through a rule
        // chain by default, so without it the parse below would still run on an oversized document —
        // which is exactly the case the length cap exists to refuse.
        RuleFor(x => x.Items)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .MaximumLength(CacheRules.MaxItemsBytes)
            .WithMessage($"Items must be at most {CacheRules.MaxItemsBytes} characters.")
            .Custom((items, ctx) => CacheRules.CheckItems(items, ctx, nameof(CacheCreateDto.Items)));
    }
}

/// <summary>Update-side rules — identical, and sharing <see cref="CacheRules"/> so they stay so.</summary>
public sealed class CacheUpdateDtoValidator : AbstractValidator<CacheUpdateDto>
{
    public CacheUpdateDtoValidator()
    {
        Include(new BaseDtoValidator<CacheUpdateDto>());

        RuleFor(x => x.Root)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .MaximumLength(CacheRules.MaxRootLength)
            .WithMessage($"Root must be at most {CacheRules.MaxRootLength} characters.")
            .Custom((root, ctx) => CacheRules.CheckRoot(root, ctx, nameof(CacheUpdateDto.Root)));

        RuleFor(x => x.Items)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .MaximumLength(CacheRules.MaxItemsBytes)
            .WithMessage($"Items must be at most {CacheRules.MaxItemsBytes} characters.")
            .Custom((items, ctx) => CacheRules.CheckItems(items, ctx, nameof(CacheUpdateDto.Items)));
    }
}
```

- [ ] **Step 6: Write the mapper, service, controller and DI extension**

Create `src/BaseApi.Service/Features/Cache/CacheEntityMapper.cs`:

```csharp
using BaseApi.Core.Mapping;
using Riok.Mapperly.Abstractions;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// Maps between <see cref="CacheEntity"/> and its DTOs. The five server-controlled targets are
/// ignored on both write directions: the audit interceptor owns them, and a mapper that could write
/// them would let a caller forge an id or an audit stamp.
/// </summary>
[Mapper]
public sealed partial class CacheEntityMapper :
    IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>
{
    [MapperIgnoreTarget(nameof(CacheEntity.Id))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedBy))]
    public partial CacheEntity ToEntity(CacheCreateDto dto);

    [MapperIgnoreTarget(nameof(CacheEntity.Id))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedAt))]
    [MapperIgnoreTarget(nameof(CacheEntity.CreatedBy))]
    [MapperIgnoreTarget(nameof(CacheEntity.UpdatedBy))]
    public partial void Update(CacheUpdateDto dto, CacheEntity target);

    public partial CacheReadDto ToRead(CacheEntity entity);
}
```

Create `src/BaseApi.Service/Features/Cache/CacheService.cs`:

```csharp
using BaseApi.Core.Mapping;
using BaseApi.Core.Persistence;
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Core.Services;
using FluentValidation;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// The cache's service. It overrides nothing: there are no junctions to synchronize from this side
/// and no collection to enrich on read, so the base class's behaviour is the whole behaviour.
/// </summary>
public sealed class CacheService :
    BaseService<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>
{
    public CacheService(
        IValidator<CacheCreateDto> createValidator,
        IValidator<CacheUpdateDto> updateValidator,
        IEntityMapper<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> mapper,
        IRepository<CacheEntity> repo,
        BaseDbContext dbContext)
        : base(createValidator, updateValidator, mapper, repo, dbContext) { }
}
```

Create `src/BaseApi.Service/Features/Cache/CacheController.cs`:

```csharp
using BaseApi.Core.Controllers;
using BaseApi.Core.Services;

namespace BaseApi.Service.Features.Cache;

public sealed class CachesController :
    BaseController<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>
{
    public CachesController(
        BaseService<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto> service)
        : base(service) { }
}
```

Create `src/BaseApi.Service/Features/Cache/CacheServiceCollectionExtensions.cs`:

```csharp
using BaseApi.Core.Services;
using Microsoft.Extensions.DependencyInjection;

namespace BaseApi.Service.Features.Cache;

internal static class CacheServiceCollectionExtensions
{
    public static IServiceCollection AddCacheFeature(this IServiceCollection services)
    {
        services.AddScoped<CacheService>();
        services.AddScoped<BaseService<CacheEntity, CacheCreateDto, CacheUpdateDto, CacheReadDto>>(
            sp => sp.GetRequiredService<CacheService>());
        return services;
    }
}
```

- [ ] **Step 7: Write the EF configuration**

Create `src/BaseApi.Service/Persistence/Configurations/CacheEntityConfiguration.cs`:

```csharp
using BaseApi.Service.Features.Cache;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="CacheEntity"/>: the items column is stored as Postgres <c>jsonb</c>,
/// and the root carries a named unique index.
/// <para>
/// <b>The index name is <c>uq_cache_root</c>, not <c>uq_cache_entity_root</c>.</b> The exception
/// mapper resolves the offending column by stripping a <c>{kind}_{owner}_</c> prefix, where the
/// owner is the table name — <c>caches</c>, from the <c>DbSet</c> — tried exactly and then
/// s-stripped to <c>cache</c>. The entity-bearing spelling would leave <c>entity_root</c> as the
/// column name in the 409 body.
/// </para>
/// </summary>
internal sealed class CacheEntityConfiguration : IEntityTypeConfiguration<CacheEntity>
{
    public void Configure(EntityTypeBuilder<CacheEntity> entity)
    {
        entity.Property(e => e.Items)
            .IsRequired()
            .HasColumnType("jsonb");

        // A generous upper bound for a key prefix, and documentation that this is not an unbounded
        // text column.
        entity.Property(e => e.Root)
            .IsRequired()
            .HasMaxLength(200);

        // One dictionary per root. The root appears verbatim inside the L2 address, so two rows
        // sharing one would have the second write silently overwrite the first.
        entity.HasIndex(e => e.Root)
            .IsUnique()
            .HasDatabaseName("uq_cache_root");
    }
}
```

- [ ] **Step 8: Register the entity and the feature**

In `src/BaseApi.Service/AppDbContext.cs`, add the `DbSet` after `Schemas` and update the class summary:

```csharp
    public DbSet<SchemaEntity> Schemas => Set<SchemaEntity>();
    public DbSet<CacheEntity> Caches => Set<CacheEntity>();
    public DbSet<ProcessorEntity> Processors => Set<ProcessorEntity>();
```

Add `using BaseApi.Service.Features.Cache;` to the file's usings, and change the summary's first line from `five entity sets and three junction sets` to `six entity sets and three junction sets`.

In `src/BaseApi.Service/Composition/AppFeatures.cs`, add `using BaseApi.Service.Features.Cache;` and the registration — after `AddSchemaFeature()`, because both are foreign-key-graph roots and the list reads root-first:

```csharp
        services.AddSchemaFeature();
        services.AddCacheFeature();
        services.AddProcessorFeature();
```

- [ ] **Step 9: Write the model test**

Create `src/tests/BaseApi.Tests/Cache/CacheModelTests.cs`:

```csharp
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

        Assert.Equal("jsonb", property.GetColumnType());
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
```

- [ ] **Step 10: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Cache.*"
```

Expected: PASS, 15 tests, exit code 0.

- [ ] **Step 11: Run the full hermetic suite to verify nothing regressed**

```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 0 failed, exit code 0. Read the shape — zero failures and a clean exit — not a remembered total; the count only grows.

- [ ] **Step 12: Commit**

```bash
git add src/BaseApi.Service/Features/Cache src/BaseApi.Service/Persistence/Configurations/CacheEntityConfiguration.cs src/BaseApi.Service/AppDbContext.cs src/BaseApi.Service/Composition/AppFeatures.cs src/tests/BaseApi.Tests/Cache
git commit -m "feat(cache): a named dictionary entity, validated down to its keys"
```

---

## Task 2: The `WorkflowCaches` junction

**Files:**
- Create: `src/BaseApi.Service/Features/Workflow/WorkflowCaches.cs`
- Create: `src/BaseApi.Service/Persistence/Configurations/WorkflowCachesConfiguration.cs`
- Modify: `src/BaseApi.Service/AppDbContext.cs`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowDtos.cs`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowDtoValidator.cs:39-43` and `:91-95`
- Modify: `src/BaseApi.Service/Features/Workflow/WorkflowService.cs`
- Modify: `src/tests/BaseApi.Tests/Orchestration/WorkflowReadEnrichmentTests.cs`
- Modify: `src/tests/BaseApi.Tests/Validation/NullCollectionCascadeTests.cs`
- Test: `src/tests/BaseApi.Tests/Cache/WorkflowCacheJunctionTests.cs`

**Interfaces:**
- Consumes: `CacheEntity` from Task 1.
- Produces: `BaseApi.Service.Features.Workflow.WorkflowCaches` with `Guid WorkflowId` and `Guid CacheId`; `WorkflowCreateDto`/`WorkflowUpdateDto` gain a sixth positional parameter `List<Guid>? CacheIds` **between** `AssignmentIds` and `CronExpression`; `WorkflowReadDto` gains `List<Guid>? CacheIds` in the same position; `AppDbContext.WorkflowCaches`.

- [ ] **Step 1: Write the failing junction test**

Create `src/tests/BaseApi.Tests/Cache/WorkflowCacheJunctionTests.cs`:

```csharp
using BaseApi.Core.Persistence.Repositories;
using BaseApi.Service;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The caches a workflow names live in <c>workflow_caches</c> rather than on the entity, so the
/// mapper cannot supply them and hard-codes null. Without the enrichment step every read reports a
/// workflow as having no caches, and a client that reads-then-writes destroys the bindings it just
/// failed to see — the same failure the entry-step and assignment collections were given
/// <c>EnrichReadAsync</c> to prevent.
/// </summary>
public sealed class WorkflowCacheJunctionTests : IAsyncLifetime
{
    private AppDbContext _db = null!;
    private WorkflowService _service = null!;
    private readonly Guid _entryStep = Guid.NewGuid();
    private readonly Guid _cacheA = Guid.NewGuid();
    private readonly Guid _cacheB = Guid.NewGuid();
    private Guid _bound, _bare;

    public async ValueTask InitializeAsync()
    {
        _db = new AppDbContext(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"workflow-caches-{Guid.NewGuid():N}")
            .Options);

        _service = new WorkflowService(
            new WorkflowCreateDtoValidator(),
            new WorkflowUpdateDtoValidator(),
            new WorkflowEntityMapper(),
            new Repository<WorkflowEntity>(_db),
            _db);

        // Two caches on the first workflow, so no assertion can pass by accident on a single-element
        // list. The second names none at all.
        _bound = await CreateAsync("wf-bound", [_cacheA, _cacheB]);
        _bare  = await CreateAsync("wf-bare", null);
    }

    public async ValueTask DisposeAsync() => await _db.DisposeAsync();

    private async Task<Guid> CreateAsync(string name, List<Guid>? caches)
    {
        var dto = new WorkflowCreateDto(name, "1.0.0", null, [_entryStep], null, caches, null);
        return (await _service.CreateAsync(dto, TestContext.Current.CancellationToken)).Id;
    }

    [Fact]
    public async Task GetByIdReturnsTheCaches()
    {
        var read = await _service.GetByIdAsync(_bound, TestContext.Current.CancellationToken);

        Assert.NotNull(read.CacheIds);
        Assert.Equal(
            new[] { _cacheA, _cacheB }.OrderBy(x => x),
            read.CacheIds!.OrderBy(x => x));
    }

    [Fact]
    public async Task GetByIdReturnsAnEmptyListForAWorkflowWithNoCaches()
    {
        // Empty, not null — the field always means what it says, so a caller can tell a workflow
        // with no caches from a collection that was never read.
        var read = await _service.GetByIdAsync(_bare, TestContext.Current.CancellationToken);

        Assert.NotNull(read.CacheIds);
        Assert.Empty(read.CacheIds!);
    }

    [Fact]
    public async Task AnUpdateReplacesTheCachesRatherThanAppending()
    {
        var replacement = new WorkflowUpdateDto(
            "wf-bound", "1.0.0", null, [_entryStep], null, [_cacheB], null);

        await _service.UpdateAsync(_bound, replacement, TestContext.Current.CancellationToken);
        var read = await _service.GetByIdAsync(_bound, TestContext.Current.CancellationToken);

        Assert.Equal([_cacheB], read.CacheIds!);
    }

    [Fact]
    public void TheJunctionCascadesFromItsWorkflowAndRestrictsFromItsCache()
    {
        // Deleting a workflow takes its junction rows with it; deleting a cache a workflow still
        // names is refused, becoming a 422 rather than silently unbinding a live projection.
        var junction = _db.Model.FindEntityType(typeof(WorkflowCaches))!;

        var toWorkflow = junction.GetForeignKeys()
            .Single(f => f.Properties.Any(p => p.Name == nameof(WorkflowCaches.WorkflowId)));
        var toCache = junction.GetForeignKeys()
            .Single(f => f.Properties.Any(p => p.Name == nameof(WorkflowCaches.CacheId)));

        Assert.Equal(DeleteBehavior.Cascade, toWorkflow.DeleteBehavior);
        Assert.Equal(DeleteBehavior.Restrict, toCache.DeleteBehavior);
    }

    [Fact]
    public void TheJunctionIsNotAnAuditedEntity()
    {
        // Deriving from BaseEntity would pull it into the xmin shadow-token loop in
        // BaseDbContext.OnModelCreating, which is for audited domain rows only.
        Assert.False(typeof(BaseApi.Core.Entities.BaseEntity)
            .IsAssignableFrom(typeof(WorkflowCaches)));
    }

    [Fact]
    public void DuplicateCacheIdsAreRefusedByTheValidator()
    {
        var id = Guid.NewGuid();
        var dto = new WorkflowCreateDto("wf", "1.0.0", null, [_entryStep], null, [id, id], null);

        var result = new WorkflowCreateDtoValidator().Validate(dto);

        Assert.False(result.IsValid);
    }

    [Fact]
    public void AnEmptyGuidInCacheIdsIsRefusedByTheValidator()
    {
        var dto = new WorkflowCreateDto(
            "wf", "1.0.0", null, [_entryStep], null, [Guid.Empty], null);

        var result = new WorkflowCreateDtoValidator().Validate(dto);

        Assert.False(result.IsValid);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
```

Expected: FAIL to compile — `WorkflowCaches` does not exist, and `WorkflowCreateDto` takes six arguments, not seven.

- [ ] **Step 3: Write the junction entity and its configuration**

Create `src/BaseApi.Service/Features/Workflow/WorkflowCaches.cs`:

```csharp
namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Junction row binding a workflow to one cache dictionary it projects on start.
/// <para>
/// Like the other two junctions it deliberately does not derive from <c>BaseEntity</c>, which is
/// what keeps it out of the <c>xmin</c> shadow-property loop in
/// <c>BaseDbContext.OnModelCreating</c>.
/// </para>
/// <para>
/// The column is <c>CacheId</c>, not <c>CacheEntityId</c>, matching how <c>WorkflowAssignments</c>
/// names <c>AssignmentEntity</c> as <c>AssignmentId</c> — the exception mapper strips the owner
/// prefix from the constraint name, so the convention has to hold for the 422 body to name a column
/// that exists.
/// </para>
/// </summary>
public sealed class WorkflowCaches
{
    public Guid WorkflowId { get; set; }

    public Guid CacheId { get; set; }
}
```

Create `src/BaseApi.Service/Persistence/Configurations/WorkflowCachesConfiguration.cs`:

```csharp
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BaseApi.Service.Persistence.Configurations;

/// <summary>
/// Configuration for <see cref="WorkflowCaches"/>, mirroring <c>WorkflowAssignmentsConfiguration</c>.
/// <para>
/// The workflow side cascades, so deleting a workflow removes its junction rows; the cache side
/// restricts, so deleting a cache a workflow still names raises SQLSTATE 23001 and becomes a 422
/// rather than silently unbinding a projection that may be live.
/// </para>
/// </summary>
internal sealed class WorkflowCachesConfiguration : IEntityTypeConfiguration<WorkflowCaches>
{
    public void Configure(EntityTypeBuilder<WorkflowCaches> entity)
    {
        entity.HasKey(e => new { e.WorkflowId, e.CacheId });

        entity.HasOne<WorkflowEntity>()
            .WithMany()
            .HasForeignKey(e => e.WorkflowId)
            .HasConstraintName("fk_workflow_caches_workflow_id")
            .OnDelete(DeleteBehavior.Cascade);

        entity.HasOne<CacheEntity>()
            .WithMany()
            .HasForeignKey(e => e.CacheId)
            .HasConstraintName("fk_workflow_caches_cache_id")
            .OnDelete(DeleteBehavior.Restrict);
    }
}
```

In `src/BaseApi.Service/AppDbContext.cs`, add the junction `DbSet` after `WorkflowAssignments`:

```csharp
    public DbSet<WorkflowAssignments> WorkflowAssignments => Set<WorkflowAssignments>();
    public DbSet<WorkflowCaches> WorkflowCaches => Set<WorkflowCaches>();
```

Change the summary's junction count from `three junction sets` to `four junction sets`.

- [ ] **Step 4: Add `CacheIds` to the three workflow DTOs**

In `src/BaseApi.Service/Features/Workflow/WorkflowDtos.cs`, insert the parameter between `AssignmentIds` and `CronExpression` in all three records. `WorkflowCreateDto` becomes:

```csharp
public sealed record WorkflowCreateDto(
    string Name,
    string Version,
    string? Description,
    List<Guid> EntryStepIds,
    List<Guid>? AssignmentIds,
    List<Guid>? CacheIds,
    string? CronExpression) : IBaseDto;
```

`WorkflowUpdateDto` takes the identical insertion. `WorkflowReadDto` becomes:

```csharp
public sealed record WorkflowReadDto(
    Guid Id,
    string Name,
    string Version,
    string? Description,
    List<Guid>? EntryStepIds,
    List<Guid>? AssignmentIds,
    List<Guid>? CacheIds,
    string? CronExpression,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedBy,
    string? UpdatedBy) : IBaseDto, IHasId;
```

Inserting mid-record is safe here precisely because the position is taken by a differently-typed
parameter: every existing positional call site fails to compile rather than silently rebinding
`CronExpression` to a list.

- [ ] **Step 5: Add the validator rules**

In `src/BaseApi.Service/Features/Workflow/WorkflowDtoValidator.cs`, add this block immediately after the `AssignmentIds` rule in **both** validators (after line 43 and after line 95):

```csharp
        RuleFor(x => x.CacheIds)
            .Must(ids => ids is null || ids.Distinct().Count() == ids.Count)
            .WithMessage("CacheIds must be unique when present.")
            .Must(ids => ids is null || ids.All(id => id != Guid.Empty))
            .WithMessage("CacheIds must not contain Guid.Empty.");
```

- [ ] **Step 6: Sync and enrich the third junction**

In `src/BaseApi.Service/Features/Workflow/WorkflowService.cs`, add `using BaseApi.Service.Features.Cache;` is **not** needed — the junction type lives in the workflow's own namespace.

In `SyncJunctionsAsync`, add the set alongside the other two:

```csharp
        var cachesSet = DbContext.Set<WorkflowCaches>();
```

Inside the `if (updateDto is not null)` block, after the assignments clear:

```csharp
            var existingCaches = await cachesSet
                .Where(j => j.WorkflowId == entity.Id)
                .ToListAsync(ct);

            if (existingCaches.Count > 0)
            {
                cachesSet.RemoveRange(existingCaches);
            }
```

After the assignment insert block:

```csharp
        // The cache collection is optional, so insert only when it is present and non-empty.
        var cacheIds = createDto?.CacheIds ?? updateDto?.CacheIds;

        if (cacheIds is { Count: > 0 })
        {
            var rows = cacheIds.Select(cacheId => new WorkflowCaches
            {
                WorkflowId = entity.Id,
                CacheId = cacheId,
            });

            await cachesSet.AddRangeAsync(rows, ct);
        }
```

In `EnrichReadAsync`, after the assignment lookup:

```csharp
        var cacheRows = await DbContext.Set<WorkflowCaches>().AsNoTracking()
            .Where(j => ids.Contains(j.WorkflowId))
            .ToListAsync(ct);

        var cacheLookup = cacheRows.GroupBy(j => j.WorkflowId)
            .ToDictionary(g => g.Key, g => g.Select(j => j.CacheId).ToList());
```

and add the third line to the `with` expression:

```csharp
                CacheIds = cacheLookup.GetValueOrDefault(d.Id) ?? new List<Guid>(),
```

- [ ] **Step 7: Fix the two existing test files the DTO change breaks**

Both files construct workflow DTOs positionally. Add `null` (or the relevant list) in the new sixth position.

In `src/tests/BaseApi.Tests/Orchestration/WorkflowReadEnrichmentTests.cs`, the `CreateAsync` helper becomes:

```csharp
    private async Task<Guid> CreateAsync(string name, List<Guid> entry, List<Guid>? assignments)
    {
        var dto = new WorkflowCreateDto(name, "1.0.0", null, entry, assignments, null, null);
        return (await _service.CreateAsync(dto, TestContext.Current.CancellationToken)).Id;
    }
```

In `src/tests/BaseApi.Tests/Validation/NullCollectionCascadeTests.cs`, add a `null` in the sixth position of every `new WorkflowCreateDto(...)`, `new WorkflowUpdateDto(...)` and `new WorkflowReadDto(...)`. Let the compiler enumerate them: build, then fix each `CS7036`/`CS1729` in turn.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Cache.WorkflowCacheJunctionTests"
```

Expected: PASS, 7 tests.

- [ ] **Step 9: Run the full hermetic suite**

```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 0 failed, exit code 0. `DeletePolicyTests.NoForeignKeyInTheModelNullsOutItsColumnOnDelete` covers the new foreign keys automatically and must still pass.

- [ ] **Step 10: Commit**

```bash
git add src/BaseApi.Service/Features/Workflow src/BaseApi.Service/Persistence/Configurations/WorkflowCachesConfiguration.cs src/BaseApi.Service/AppDbContext.cs src/tests/BaseApi.Tests
git commit -m "feat(cache): bind caches to a workflow through a junction, read and write"
```

---

## Task 3: The migration

**Files:**
- Create: `src/BaseApi.Service/Persistence/Migrations/<stamp>_AddCacheEntity.cs` (EF-generated)
- Modify: `src/BaseApi.Service/Persistence/Migrations/AppDbContextModelSnapshot.cs` (EF-generated)

**Interfaces:**
- Consumes: the model from Tasks 1 and 2.
- Produces: tables `caches` and `workflow_caches` in the database schema.

- [ ] **Step 1: Generate the migration**

```bash
dotnet ef migrations add AddCacheEntity \
  --project src/BaseApi.Service/BaseApi.Service.csproj \
  --output-dir Persistence/Migrations
```

- [ ] **Step 2: Read the generated migration and check the four names**

Open the new `<stamp>_AddCacheEntity.cs` and confirm, by eye:

- `CreateTable(name: "caches", …)` — plural, from the `DbSet`.
- `CreateTable(name: "workflow_caches", …)`.
- `CreateIndex(name: "uq_cache_root", table: "caches", column: "root", unique: true)`.
- Two foreign keys named `fk_workflow_caches_workflow_id` (`onDelete: ReferentialAction.Cascade`) and `fk_workflow_caches_cache_id` (`onDelete: ReferentialAction.Restrict`).

If any name differs, the EF configuration is wrong — fix the configuration and regenerate rather than hand-editing the migration.

Confirm also that the migration's `Up` contains **only** `CreateTable` and `CreateIndex` calls. An `AlterColumn` or `DropIndex` against an existing table means something outside this change drifted, and must be investigated before proceeding.

- [ ] **Step 3: Verify no model changes remain pending**

```bash
dotnet ef migrations has-pending-model-changes \
  --project src/BaseApi.Service/BaseApi.Service.csproj
```

Expected: `No changes have been made to the model since the last migration.`

- [ ] **Step 4: Run the full hermetic suite**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 0 failed, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/BaseApi.Service/Persistence/Migrations
git commit -m "feat(cache): migration adding caches and workflow_caches"
```

---

## Task 4: The wire and projection contracts

**Files:**
- Create: `src/Messaging.Contracts/CacheL1.cs`
- Modify: `src/Messaging.Contracts/WorkflowL1.cs:30-34`
- Modify: `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs`
- Modify: `src/Messaging.Contracts/Projections/WorkflowRootProjection.cs`
- Test: `src/tests/BaseApi.Tests/Cache/CacheKeyTests.cs`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is a standalone contract assembly.
- Produces: `Messaging.Contracts.CacheL1(string Root, Dictionary<string, string> Items)`; `WorkflowL1` gains a fifth positional parameter `List<CacheL1> Caches` **after** `Steps`; `L2ProjectionKeys.Cache(Guid workflowId, string root) → string`; `L2ProjectionKeys.CacheEntry(Guid workflowId, string root, string key) → string`; `WorkflowRootProjection` gains a fifth positional parameter `List<string>? CacheRoots` after `Liveness`, serialized as `cacheRoots`.

> **`Messaging.Contracts` is consumed as a NuGet package, not a project reference.** Step 6 repacks it. Skipping that leaves every consumer compiling against the previous package contents, and the failure looks like the new members simply not existing.

- [ ] **Step 1: Write the failing key tests**

Create `src/tests/BaseApi.Tests/Cache/CacheKeyTests.cs`:

```csharp
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The cache key format, pinned because two components compose it independently — the writer that
/// stores a dictionary and the operator who pastes an address into a step payload — and nothing at
/// runtime would report a mismatch. A processor handed an address one character different from the
/// one that was written simply misses every lookup, which is indistinguishable from an empty
/// whitelist.
/// </summary>
public sealed class CacheKeyTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");

    [Fact]
    public void TheCacheRootIsTheWorkflowScopeFollowedByTheRoot()
    {
        Assert.Equal(
            "skp:11111111-1111-1111-1111-111111111111:cache:sk-whitelist",
            L2ProjectionKeys.Cache(W, "sk-whitelist"));
    }

    [Fact]
    public void AnEntryIsItsCacheRootPlusTheKey()
    {
        Assert.Equal(
            "skp:11111111-1111-1111-1111-111111111111:cache:sk-whitelist:acme",
            L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme"));
    }

    [Fact]
    public void AnEntryKeyIsExactlyItsCacheRootPlusASeparatorAndTheKey()
    {
        // Stated as a relationship rather than two literals, because cleanup reads the key list from
        // the cache root and rebuilds each entry key from it. If the two builders ever disagree,
        // stop would delete keys that were never written and leave the ones that were.
        Assert.Equal(
            L2ProjectionKeys.Cache(W, "sk-whitelist") + ":acme",
            L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme"));
    }

    [Fact]
    public void ACacheKeyCannotCollideWithAStepKey()
    {
        // Both are skp:{workflowId}:… — the discriminator is that a step key's third segment is a
        // GUID and a cache key's is the literal "cache", which CacheEntity's validator guarantees no
        // root can impersonate, since it refuses a root containing ':'.
        var step = L2ProjectionKeys.Step(W, Guid.Parse("22222222-2222-2222-2222-222222222222"));

        Assert.NotEqual(step, L2ProjectionKeys.Cache(W, "sk-whitelist"));
        Assert.StartsWith($"skp:{W:D}:cache:", L2ProjectionKeys.Cache(W, "sk-whitelist"));
    }

    [Fact]
    public void ARootProjectionWrittenBeforeCachesExistedReadsAsNoCaches()
    {
        // The compatibility guarantee cleanup depends on: an in-flight workflow projected by the
        // previous writer has no cacheRoots field at all, and must deserialize to null rather than
        // throwing, so its graph can still be removed.
        const string legacy = """
            {"entryStepIds":[],"stepIds":[],"cron":null,
             "liveness":{"LastSeenUtc":"2026-08-21T12:00:00Z","IntervalSeconds":0,"Status":"Pending"}}
            """;

        var root = System.Text.Json.JsonSerializer.Deserialize<WorkflowRootProjection>(
            legacy, Messaging.Contracts.MessagingJson.Options);

        Assert.NotNull(root);
        Assert.Null(root!.CacheRoots);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
```

Expected: FAIL to compile — `L2ProjectionKeys.Cache`, `L2ProjectionKeys.CacheEntry` and `WorkflowRootProjection.CacheRoots` do not exist.

- [ ] **Step 3: Add the two key builders**

In `src/Messaging.Contracts/Projections/L2ProjectionKeys.cs`, add these two members after `Step`, and add two `<item>` lines to the class summary's list:

```csharp
    /// <summary>
    /// The cache root: the key holding the JSON array of key names in one projected dictionary.
    /// <para>
    /// <b>This is the first key to place a literal segment after the workflow id.</b> Every other
    /// discriminator in this scheme — <c>proc:</c>, <c>data:</c> — sits immediately after the
    /// prefix. It cannot collide with <see cref="Step"/>, because <c>cache</c> is not a GUID, and
    /// keeping a workflow's keys contiguous under one scan prefix is worth more here than symmetry
    /// with the other two.
    /// </para>
    /// <para>
    /// <paramref name="root"/> is interpolated verbatim, which is safe because the cache validator
    /// refuses a root containing a colon — the one character that could forge another address.
    /// </para>
    /// </summary>
    public static string Cache(Guid workflowId, string root)
        => $"{Prefix}{workflowId:D}:cache:{root}";

    /// <summary>
    /// One entry of a projected dictionary: exactly <see cref="Cache"/> followed by the key. The two
    /// must stay in that relationship, because cleanup reads the key list from the cache root and
    /// rebuilds every entry key from it.
    /// </summary>
    public static string CacheEntry(Guid workflowId, string root, string key)
        => $"{Cache(workflowId, root)}:{key}";
```

- [ ] **Step 4: Add `CacheRoots` to the root projection**

In `src/Messaging.Contracts/Projections/WorkflowRootProjection.cs`, add the parameter after `Liveness` and document why the key list is not here:

```csharp
public sealed record WorkflowRootProjection(
    [property: JsonPropertyName("entryStepIds")] List<Guid> EntryStepIds,
    [property: JsonPropertyName("stepIds")]      List<Guid> StepIds,
    [property: JsonPropertyName("cron")]         string? Cron,
    [property: JsonPropertyName("liveness")]     LivenessProjection Liveness,
    /// <summary>
    /// The roots of every dictionary this workflow projected — names only. Nothing else records
    /// which roots exist for a workflow, and discovering them with a SCAN is the walk this design
    /// refuses everywhere else.
    /// <para>
    /// <b>The keys under each root are recorded at that root, not here, and that split is
    /// deliberate.</b> The step-key list lives here because a step key names its successors, so a
    /// missing one strands everything beyond it. A cache root names nothing — its key list is a flat
    /// leaf — so keeping it at the root costs one extra read at stop and buys the property the flat
    /// key layout exists for: an operator reading one key sees the dictionary's contents by name.
    /// </para>
    /// <para>
    /// Null for a root written before caches existed, and read as empty.
    /// </para>
    /// </summary>
    [property: JsonPropertyName("cacheRoots")]   List<string>? CacheRoots = null);
```

- [ ] **Step 5: Add `CacheL1` and hang it off `WorkflowL1`**

Create `src/Messaging.Contracts/CacheL1.cs`:

```csharp
namespace Messaging.Contracts;

/// <summary>
/// One dictionary a workflow projects into L2 for the duration of a run, flattened for the wire.
/// <para>
/// The junction that binds it to the workflow is resolved before this record is built, so the
/// consumer never learns the junction exists — the same treatment the assignment payload gets.
/// </para>
/// </summary>
public sealed record CacheL1(string Root, Dictionary<string, string> Items);
```

In `src/Messaging.Contracts/WorkflowL1.cs`, add the parameter after `Steps`:

```csharp
public sealed record WorkflowL1(
    Guid WorkflowId,
    List<Guid> EntryStepIds,
    string? Cron,
    List<StepL1> Steps,
    List<CacheL1> Caches);
```

- [ ] **Step 6: Repack the contracts package**

```bash
bash scripts/pack-all.sh
```

Expected: the script prints each library in dependency order and ends with a list of `.nupkg` paths. **This step is not optional.** `BaseApi.Service` references `Messaging.Contracts` as a versioned package, and restore never consults a feed for a version it already holds extracted — without the repack, the next build compiles against the previous package and reports the new members as missing.

- [ ] **Step 7: Fix the `WorkflowL1` construction sites the new parameter breaks**

Build and let the compiler enumerate them:

```bash
dotnet build SK_P.sln --nologo
```

Every `new WorkflowL1(...)` needs a fifth argument. In production code there is one, in
`OrchestrationService.ToDefinition`, which Task 5 rewrites — for now pass `new List<CacheL1>()`. In
`src/tests/BaseApi.Tests/Orchestration/StartStopIdempotencyTests.cs` the `Definition` helper needs
the same:

```csharp
    private static WorkflowL1 Definition(params Guid[] stepIds) => new(
        WorkflowId: W,
        EntryStepIds: [stepIds[0]],
        Cron: Cron,
        Steps: stepIds
            .Select(id => new StepL1(id, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: []))
            .ToList(),
        Caches: []);
```

Fix every other site the compiler names the same way.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Cache.CacheKeyTests"
```

Expected: PASS, 5 tests.

- [ ] **Step 9: Run the full hermetic suite**

```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 0 failed, exit code 0.

- [ ] **Step 10: Commit**

```bash
git add src/Messaging.Contracts src/BaseApi.Service src/tests/BaseApi.Tests
git commit -m "feat(cache): key builders, the wire record, and the roots the root projection records"
```

---

## Task 5: Loading the caches into the definition

**Files:**
- Modify: `src/BaseApi.Service/Features/Orchestration/WorkflowGraphSnapshot.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/Loading/WorkflowGraphLoader.cs`
- Modify: `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs` (`ToDefinition` only)
- Test: `src/tests/BaseApi.Tests/Cache/CacheDefinitionTests.cs`

**Interfaces:**
- Consumes: `CacheEntity`, `CacheReadDto`, `CacheEntityMapper` (Task 1); `WorkflowCaches` (Task 2); `CacheL1`, `WorkflowL1.Caches` (Task 4).
- Produces: `WorkflowGraphSnapshot.Caches` as `Dictionary<Guid, CacheReadDto>`; `WorkflowL1.Caches` populated by `OrchestrationService.ToDefinition`.

- [ ] **Step 1: Write the failing round-trip test**

Create `src/tests/BaseApi.Tests/Cache/CacheDefinitionTests.cs`:

```csharp
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Workflow;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The flattening step, where a snapshot of rows becomes the definition that travels on the wire.
/// The junction is resolved here, while both sides are in hand, so nothing downstream has to know it
/// exists — the same treatment the assignment payload already gets.
/// </summary>
public sealed class CacheDefinitionTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");

    private static WorkflowGraphSnapshot Snapshot(params CacheReadDto[] caches)
    {
        var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);

        snapshot.Workflows[W] = new WorkflowReadDto(
            W, "wf", "1.0.0", null, [], [], caches.Select(c => c.Id).ToList(), null,
            DateTime.UtcNow, DateTime.UtcNow, null, null);

        foreach (var cache in caches)
        {
            snapshot.Caches[cache.Id] = cache;
        }

        return snapshot;
    }

    private static CacheReadDto Cache(string root, string items) => new(
        Guid.NewGuid(), $"cache-{root}", "1.0.0", null, root, items,
        DateTime.UtcNow, DateTime.UtcNow, null, null);

    [Fact]
    public void EveryCacheOnTheWorkflowReachesTheDefinition()
    {
        using var snapshot = Snapshot(
            Cache("sk-whitelist", """{"acme":"1"}"""),
            Cache("other-list", """{"beta":"2"}"""));

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);

        Assert.Equal(
            new[] { "other-list", "sk-whitelist" },
            definition.Caches.Select(c => c.Root).OrderBy(r => r, StringComparer.Ordinal));
    }

    [Fact]
    public void TheDictionaryArrivesIntact()
    {
        using var snapshot = Snapshot(Cache("sk-whitelist", """{"acme":"1","alphabeta":"2"}"""));

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);

        var items = definition.Caches.Single().Items;
        Assert.Equal(2, items.Count);
        Assert.Equal("1", items["acme"]);
        Assert.Equal("2", items["alphabeta"]);
    }

    [Fact]
    public void AnEmptyDictionaryIsCarriedRatherThanDropped()
    {
        // "Allow nothing" is a legitimate configuration. Dropping the cache here would make it
        // indistinguishable from a workflow that named no cache at all.
        using var snapshot = Snapshot(Cache("sk-whitelist", "{}"));

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);

        Assert.Empty(definition.Caches.Single().Items);
        Assert.Single(definition.Caches);
    }

    [Fact]
    public void AWorkflowWithNoCachesProducesAnEmptyList()
    {
        // Empty, never null — the writer enumerates this without a guard.
        using var snapshot = Snapshot();

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);

        Assert.Empty(definition.Caches);
    }

    [Fact]
    public void ACacheIdNamingNoLoadedRowIsSkippedRatherThanThrowing()
    {
        // Defensive, matching how the loader's other lookups behave: the foreign key makes this
        // unreachable, and a throw here would turn an impossible state into a failed start.
        using var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
        snapshot.Workflows[W] = new WorkflowReadDto(
            W, "wf", "1.0.0", null, [], [], [Guid.NewGuid()], null,
            DateTime.UtcNow, DateTime.UtcNow, null, null);

        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);

        Assert.Empty(definition.Caches);
    }

    [Fact]
    public void TheSnapshotClearsItsCachesOnDispose()
    {
        var snapshot = Snapshot(Cache("sk-whitelist", """{"acme":"1"}"""));

        snapshot.Dispose();

        Assert.Empty(snapshot.Caches);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
```

Expected: FAIL to compile — `WorkflowGraphSnapshot.Caches` and `OrchestrationService.ToDefinitionForTests` do not exist.

- [ ] **Step 3: Add the snapshot dictionary**

In `src/BaseApi.Service/Features/Orchestration/WorkflowGraphSnapshot.cs`, add `using BaseApi.Service.Features.Cache;`, the dictionary alongside the other five, and the clear in `Dispose`:

```csharp
    public Dictionary<Guid, CacheReadDto>      Caches      { get; init; } = new();
```

```csharp
        Schemas.Clear();
        Caches.Clear();
```

- [ ] **Step 4: Load the caches**

In `src/BaseApi.Service/Features/Orchestration/Loading/WorkflowGraphLoader.cs`:

Add `using BaseApi.Service.Features.Cache;`.

Add the mapper field, constructor parameter and assignment, following the five that are already there:

```csharp
    private readonly IEntityMapper<CacheEntity,      CacheCreateDto,      CacheUpdateDto,      CacheReadDto>      _cacheMapper;
```

```csharp
        IEntityMapper<CacheEntity,      CacheCreateDto,      CacheUpdateDto,      CacheReadDto>      cacheMapper,
```

```csharp
        _cacheMapper      = cacheMapper      ?? throw new ArgumentNullException(nameof(cacheMapper));
```

In stage 1, after the `wfAssignmentRows` lookup:

```csharp
        var cacheRows = await _db.Set<WorkflowCaches>().AsNoTracking()
            .Where(j => workflowIds.Contains(j.WorkflowId)).ToListAsync(ct);
        var cacheLookup = cacheRows.GroupBy(j => j.WorkflowId)
            .ToDictionary(g => g.Key, g => g.Select(j => j.CacheId).ToList());
```

In stage 3, after the assignments load:

```csharp
        var cacheIds = cacheLookup.Values.SelectMany(x => x).Distinct().ToList();
        var caches = await _db.Set<CacheEntity>().AsNoTracking()
            .Where(c => cacheIds.Contains(c.Id)).ToListAsync(ct);
```

In stage 4, beside the other three straight maps:

```csharp
        foreach (var c in caches)      snapshot.Caches[c.Id]      = _cacheMapper.ToRead(c);
```

and in the workflow enrichment loop, add the third collection to the `with`:

```csharp
            var cch   = cacheLookup.GetValueOrDefault(wf.Id) ?? new List<Guid>();
            snapshot.Workflows[wf.Id] = dto with { EntryStepIds = entry, AssignmentIds = asg, CacheIds = cch };
```

- [ ] **Step 5: Flatten the caches in `ToDefinition`**

In `src/BaseApi.Service/Features/Orchestration/OrchestrationService.cs`, add `using System.Text.Json;` and `using BaseApi.Service.Features.Cache;` if absent, then extend `ToDefinition`. Replace its `return` with:

```csharp
        // Resolved here, while both sides of the junction are in hand, so the consumer never has to
        // know the junction exists — the same reason the assignment payload is resolved above.
        //
        // A cache id naming no loaded row is skipped rather than throwing. The foreign key makes
        // that unreachable, and turning an impossible state into a failed start would refuse a
        // workflow for a reason no operator could act on.
        var caches = (workflow.CacheIds ?? new List<Guid>())
            .Select(id => snapshot.Caches.TryGetValue(id, out var dto) ? dto : null)
            .Where(dto => dto is not null)
            .Select(dto => new CacheL1(
                dto!.Root,
                JsonSerializer.Deserialize<Dictionary<string, string>>(dto.Items)
                    ?? new Dictionary<string, string>()))
            .ToList();

        return new WorkflowL1(
            WorkflowId: workflowId,
            EntryStepIds: workflow.EntryStepIds ?? new List<Guid>(),
            Cron: workflow.CronExpression,
            Steps: steps,
            Caches: caches);
```

Add the test seam below `ToDefinition`, so the flattening can be exercised without building a
service with eight dependencies:

```csharp
    /// <summary>
    /// Exposes <see cref="ToDefinition"/> to the test assembly. The method is static and pure, and
    /// reaching it through a constructed service would mean supplying eight dependencies none of
    /// which it touches.
    /// </summary>
    internal static WorkflowL1 ToDefinitionForTests(WorkflowGraphSnapshot snapshot, Guid workflowId)
        => ToDefinition(snapshot, workflowId);
```

Confirm `src/BaseApi.Service` already exposes its internals to the test assembly; if the build
reports `ToDefinitionForTests` as inaccessible, add to `BaseApi.Service.csproj`:

```xml
  <ItemGroup>
    <InternalsVisibleTo Include="BaseApi.Tests" />
  </ItemGroup>
```

- [ ] **Step 6: Confirm the new loader dependency resolves — no registration needed**

`WorkflowGraphLoader` now takes a sixth mapper, and **nothing has to be registered for it**. Three
open-generic or assembly-scanning registrations already cover every new type in this plan, all
reached from `AddBaseApi<TDbContext>` in
`src/BaseApi.Core/DependencyInjection/BaseApiServiceCollectionExtensions.cs:34`:

- `AddBaseApiMapping(typeof(TDbContext).Assembly)` scans `BaseApi.Service` for exported types
  implementing `IEntityMapper<,,,>` and registers each closed interface as a singleton. `CacheEntityMapper`
  is public and sealed in that assembly, so it is picked up.
- `AddBaseApiValidation(typeof(TDbContext).Assembly)` does the same for the two cache validators.
- `services.AddScoped(typeof(IRepository<>), typeof(Repository<>))`
  (`PersistenceServiceCollectionExtensions.cs:34`) covers `IRepository<CacheEntity>`.

So `AddCacheFeature` from Task 1 correctly registers only `CacheService` and its `BaseService` alias,
exactly as `AddAssignmentFeature` does. Do not add mapper, validator or repository registrations —
a duplicate singleton for the same closed interface would shadow the scanned one.

Verify rather than assume: the startup tests in Step 8's full suite resolve the real container, so a
genuinely missing registration fails there.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Cache.CacheDefinitionTests"
```

Expected: PASS, 6 tests.

- [ ] **Step 8: Run the full hermetic suite**

```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 0 failed, exit code 0. The DI container is exercised by the startup tests — a missing
mapper registration surfaces there, not in the tests above.

- [ ] **Step 9: Commit**

```bash
git add src/BaseApi.Service src/tests/BaseApi.Tests
git commit -m "feat(cache): load a workflow's caches and flatten them into the definition"
```

---

## Task 6: Writing the caches into L2

**Files:**
- Modify: `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs`
- Test: `src/tests/BaseApi.Tests/Cache/CacheProjectionWriteTests.cs`

**Interfaces:**
- Consumes: `CacheL1`, `WorkflowL1.Caches`, `L2ProjectionKeys.Cache`, `L2ProjectionKeys.CacheEntry`, `WorkflowRootProjection.CacheRoots` (Task 4).
- Produces: L2 state — one string key per cache root holding a JSON array of key names, one string key per entry, and `cacheRoots` populated on the stored root.

- [ ] **Step 1: Write the failing write tests**

Create `src/tests/BaseApi.Tests/Cache/CacheProjectionWriteTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// What the writer leaves in the store for a workflow that names caches.
/// <para>
/// The assertions are about resulting keys rather than calls, because the contract cleanup depends
/// on is exactly that: a root naming the dictionaries, each dictionary naming its entries, and every
/// entry present under the address a processor will be handed.
/// </para>
/// </summary>
public sealed class CacheProjectionWriteTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    private static WorkflowL1 Definition(params CacheL1[] caches) => new(
        WorkflowId: W,
        EntryStepIds: [S],
        Cron: null,
        Steps: [new StepL1(S, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: [])],
        Caches: caches.ToList());

    private static async Task<InMemoryL2> WriteAsync(WorkflowL1 definition)
    {
        var l2 = new InMemoryL2();
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 9, 14, 12, 0, 0, TimeSpan.Zero));

        await new L2ProjectionWriter(l2.Multiplexer, clock)
            .WriteAsync(definition, TestContext.Current.CancellationToken);

        return l2;
    }

    [Fact]
    public async Task EveryEntryIsWrittenUnderItsOwnKey()
    {
        var l2 = await WriteAsync(Definition(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1", ["alphabeta"] = "2" })));

        Assert.Equal("1", l2.Value(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "acme")));
        Assert.Equal("2", l2.Value(L2ProjectionKeys.CacheEntry(W, "sk-whitelist", "alphabeta")));
    }

    [Fact]
    public async Task TheCacheRootListsItsKeys()
    {
        var l2 = await WriteAsync(Definition(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1", ["alphabeta"] = "2" })));

        var listed = JsonSerializer.Deserialize<List<string>>(
            l2.Value(L2ProjectionKeys.Cache(W, "sk-whitelist"))!, MessagingJson.Options)!;

        Assert.Equal(new[] { "acme", "alphabeta" }, listed.OrderBy(k => k, StringComparer.Ordinal));
    }

    [Fact]
    public async Task TheWorkflowRootRecordsEveryCacheRoot()
    {
        var l2 = await WriteAsync(Definition(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1" }),
            new CacheL1("other-list", new() { ["beta"] = "2" })));

        var root = JsonSerializer.Deserialize<WorkflowRootProjection>(
            l2.Value(L2ProjectionKeys.Root(W))!, MessagingJson.Options)!;

        Assert.NotNull(root.CacheRoots);
        Assert.Equal(
            new[] { "other-list", "sk-whitelist" },
            root.CacheRoots!.OrderBy(r => r, StringComparer.Ordinal));
    }

    [Fact]
    public async Task AnEmptyDictionaryStillWritesItsRootWithAnEmptyList()
    {
        // "Allow nothing" must be distinguishable from "no cache": the root key exists and lists
        // nothing, rather than being absent.
        var l2 = await WriteAsync(Definition(new CacheL1("sk-whitelist", new())));

        Assert.True(l2.Has(L2ProjectionKeys.Cache(W, "sk-whitelist")));
        Assert.Equal("[]", l2.Value(L2ProjectionKeys.Cache(W, "sk-whitelist")));
    }

    [Fact]
    public async Task AWorkflowWithNoCachesWritesNoCacheKeys()
    {
        var l2 = await WriteAsync(Definition());

        Assert.DoesNotContain(l2.Keys(), k => k.Contains(":cache:"));
    }

    [Fact]
    public async Task AWorkflowWithNoCachesRecordsAnEmptyRootList()
    {
        // Empty rather than null, so cleanup reads one shape from anything this writer produced.
        var l2 = await WriteAsync(Definition());

        var root = JsonSerializer.Deserialize<WorkflowRootProjection>(
            l2.Value(L2ProjectionKeys.Root(W))!, MessagingJson.Options)!;

        Assert.NotNull(root.CacheRoots);
        Assert.Empty(root.CacheRoots!);
    }

    [Fact]
    public async Task TheSameCacheNamedTwiceIsWrittenOnce()
    {
        // The junction's composite key makes this unreachable, but the writer should not depend on a
        // constraint two layers away.
        var l2 = await WriteAsync(Definition(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1" }),
            new CacheL1("sk-whitelist", new() { ["acme"] = "1" })));

        var root = JsonSerializer.Deserialize<WorkflowRootProjection>(
            l2.Value(L2ProjectionKeys.Root(W))!, MessagingJson.Options)!;

        Assert.Single(root.CacheRoots!);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Cache.CacheProjectionWriteTests"
```

Expected: FAIL — the cache keys are absent and `CacheRoots` is null.

- [ ] **Step 3: Write the caches in the existing batch**

In `src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs`, before the `root` is constructed:

```csharp
        // Deduplicated by root: the junction's composite key already prevents a repeat, but the
        // writer should not depend on a constraint two layers away — and a repeat here would put the
        // same root in the record twice, making the stop path delete it twice.
        var caches = (workflow.Caches ?? new List<CacheL1>())
            .GroupBy(c => c.Root, StringComparer.Ordinal)
            .Select(g => g.First())
            .ToList();
```

Add `CacheRoots` to the root projection being built:

```csharp
        var root = new WorkflowRootProjection(
            EntryStepIds: workflow.EntryStepIds ?? new List<Guid>(),
            StepIds: steps.Select(s => s.StepId).ToList(),
            Cron: workflow.Cron,
            Liveness: liveness,
            // Recorded from the same list the cache keys are written from, in this method, so the
            // root cannot name a dictionary the write did not produce — the same rule the step ids
            // above follow, and for the same reason: a root missing from this list is a set of keys
            // nothing will ever delete.
            CacheRoots: caches.Select(c => c.Root).ToList());
```

And after the step-key loop, before `batch.Execute()`:

```csharp
        foreach (var cache in caches)
        {
            var items = cache.Items ?? new Dictionary<string, string>();

            // The key list goes at the cache root, so an operator reading one key sees the
            // dictionary's contents by name, and so cleanup can remove the entries without a scan.
            writes.Add(batch.StringSetAsync(
                L2ProjectionKeys.Cache(workflow.WorkflowId, cache.Root),
                JsonSerializer.Serialize(items.Keys.ToList(), MessagingJson.Options)));

            foreach (var (key, value) in items)
            {
                writes.Add(batch.StringSetAsync(
                    L2ProjectionKeys.CacheEntry(workflow.WorkflowId, cache.Root, key),
                    value));
            }
        }
```

Extend the class summary to say it now writes the caches too.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Cache.CacheProjectionWriteTests"
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full hermetic suite**

```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 0 failed, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add src/BaseApi.Service/Features/Orchestration/Projection/L2ProjectionWriter.cs src/tests/BaseApi.Tests/Cache
git commit -m "feat(cache): project every named dictionary in the batch that carries the graph"
```

---

## Task 7: Removing the caches on stop

**Files:**
- Modify: `src/BaseApi.Service/Features/Orchestration/Projection/L2Cleanup.cs`
- Test: `src/tests/BaseApi.Tests/Cache/CacheProjectionCleanupTests.cs`

**Interfaces:**
- Consumes: everything Task 6 writes.
- Produces: no new API — `L2Cleanup.RemoveAsync` removes the cache keys as well.

- [ ] **Step 1: Write the failing cleanup tests**

Create `src/tests/BaseApi.Tests/Cache/CacheProjectionCleanupTests.cs`:

```csharp
using System.Text.Json;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// Stop must leave nothing behind. A cache entry that survives its workflow is unreachable from any
/// later root, so no subsequent stop can find it either — it leaks permanently, one key per entry
/// per run, and it answers lookups for whatever workflow next claims the same root.
/// </summary>
public sealed class CacheProjectionCleanupTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid P = Guid.Parse("33333333-3333-3333-3333-333333333333");

    private static WorkflowL1 Definition(params CacheL1[] caches) => new(
        WorkflowId: W,
        EntryStepIds: [S],
        Cron: null,
        Steps: [new StepL1(S, EntryCondition: 0, ProcessorId: P, Payload: "{}", NextStepIds: [])],
        Caches: caches.ToList());

    private static async Task<InMemoryL2> ProjectedAsync(params CacheL1[] caches)
    {
        var l2 = new InMemoryL2();
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 9, 14, 12, 0, 0, TimeSpan.Zero));

        await new L2ProjectionWriter(l2.Multiplexer, clock)
            .WriteAsync(Definition(caches), TestContext.Current.CancellationToken);

        return l2;
    }

    private static Task CleanAsync(InMemoryL2 l2) =>
        new L2Cleanup(l2.Multiplexer).RemoveAsync(W, TestContext.Current.CancellationToken);

    [Fact]
    public async Task EveryCacheKeyIsRemoved()
    {
        var l2 = await ProjectedAsync(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1", ["alphabeta"] = "2" }),
            new CacheL1("other-list", new() { ["beta"] = "3" }));

        await CleanAsync(l2);

        Assert.DoesNotContain(l2.Keys(), k => k.Contains(":cache:"));
    }

    [Fact]
    public async Task TheCacheRootItselfIsRemoved()
    {
        var l2 = await ProjectedAsync(new CacheL1("sk-whitelist", new() { ["acme"] = "1" }));

        await CleanAsync(l2);

        Assert.False(l2.Has(L2ProjectionKeys.Cache(W, "sk-whitelist")));
    }

    [Fact]
    public async Task TheWorkflowRootAndItsStepsGoTooAsBefore()
    {
        var l2 = await ProjectedAsync(new CacheL1("sk-whitelist", new() { ["acme"] = "1" }));

        await CleanAsync(l2);

        Assert.False(l2.Has(L2ProjectionKeys.Root(W)));
        Assert.False(l2.Has(L2ProjectionKeys.Step(W, S)));
    }

    [Fact]
    public async Task ASecondCleanupIsAQuietNoOp()
    {
        // A stop asks for an end state rather than an action, so a redelivery, a repeat, or a stop
        // for something never started must all complete without throwing.
        var l2 = await ProjectedAsync(new CacheL1("sk-whitelist", new() { ["acme"] = "1" }));

        await CleanAsync(l2);
        await CleanAsync(l2);

        Assert.Empty(l2.Keys());
    }

    [Fact]
    public async Task ARootWithNoCacheRootsFieldStillCleansTheGraph()
    {
        // The compatibility case: a workflow projected before caches existed. Its root carries no
        // cacheRoots, and refusing to clean it would strand the graph permanently.
        var l2 = new InMemoryL2();
        var legacyRoot = new WorkflowRootProjection(
            EntryStepIds: [S],
            StepIds: [S],
            Cron: null,
            Liveness: new LivenessProjection(new DateTime(2026, 9, 14, 12, 0, 0, DateTimeKind.Utc), 0, "Pending"));

        await l2.Db.StringSetAsync(
            L2ProjectionKeys.Root(W), JsonSerializer.Serialize(legacyRoot, MessagingJson.Options));
        await l2.Db.StringSetAsync(L2ProjectionKeys.Step(W, S), "{}");

        await CleanAsync(l2);

        Assert.Empty(l2.Keys());
    }

    [Fact]
    public async Task ACacheRootAlreadyGoneDoesNotStopTheRestOfTheRemoval()
    {
        // The entries under a missing cache root are unreachable — nothing records them elsewhere —
        // but everything else must still go, rather than the whole removal aborting on the gap.
        var l2 = await ProjectedAsync(
            new CacheL1("sk-whitelist", new() { ["acme"] = "1" }),
            new CacheL1("other-list", new() { ["beta"] = "2" }));

        await l2.Db.KeyDeleteAsync(L2ProjectionKeys.Cache(W, "sk-whitelist"));

        await CleanAsync(l2);

        Assert.False(l2.Has(L2ProjectionKeys.Root(W)));
        Assert.False(l2.Has(L2ProjectionKeys.CacheEntry(W, "other-list", "beta")));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Cache.CacheProjectionCleanupTests"
```

Expected: FAIL — the cache keys survive the cleanup.

- [ ] **Step 3: Delete the cache keys in the existing batch**

In `src/BaseApi.Service/Features/Orchestration/Projection/L2Cleanup.cs`, after `stepKeys` is built and before the batch is created:

```csharp
        // Read the key list from each cache root, exactly as the step key set is read from the
        // workflow root: the write recorded what it wrote, so removal is one read per dictionary
        // rather than a scan. A cache root that is already gone contributes nothing — its entries
        // are unreachable, and aborting here would strand every key after it.
        var cacheKeys = new List<RedisKey>();

        foreach (var cacheRoot in (root?.CacheRoots ?? new List<string>()).Distinct(StringComparer.Ordinal))
        {
            if (string.IsNullOrEmpty(cacheRoot))
            {
                continue;
            }

            var cacheRootKey = L2ProjectionKeys.Cache(workflowId, cacheRoot);
            cacheKeys.Add(cacheRootKey);

            var listJson = await db.StringGetAsync(cacheRootKey).ConfigureAwait(false);
            if (listJson.IsNullOrEmpty)
            {
                continue;
            }

            var keys = JsonSerializer.Deserialize<List<string>>(listJson!, MessagingJson.Options)
                       ?? new List<string>();

            cacheKeys.AddRange(keys
                .Where(k => !string.IsNullOrEmpty(k))
                .Distinct(StringComparer.Ordinal)
                .Select(k => (RedisKey)L2ProjectionKeys.CacheEntry(workflowId, cacheRoot, k)));
        }
```

Then add them to the batch, beside the step keys:

```csharp
        if (cacheKeys.Count > 0)
        {
            deletes.Add(batch.KeyDeleteAsync(cacheKeys.ToArray()));
        }
```

Extend the class summary to say the cache roots and their entries go too, and why the key list is
read from each cache root rather than from the workflow root.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.Cache.CacheProjectionCleanupTests"
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full hermetic suite**

```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 0 failed, exit code 0. `StartStopIdempotencyTests` is the one to watch: it runs the whole
start/stop path twice over one store, so a cleanup that misses a key surfaces there as a
non-converging key space.

- [ ] **Step 6: Commit**

```bash
git add src/BaseApi.Service/Features/Orchestration/Projection/L2Cleanup.cs src/tests/BaseApi.Tests/Cache
git commit -m "feat(cache): remove every projected dictionary when the workflow stops"
```

---

## Task 8: The `SKNormalizer` seam

**Files:**
- Modify: `src/Processor.SKNormalizer/SKNormalizerConfig.cs`
- Test: `src/tests/BaseApi.Tests/SKNormalizer/SKNormalizerConfigTests.cs` (create if absent)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SKNormalizerConfig(string Handler, string? CacheAddress = null)`.

- [ ] **Step 1: Write the failing binding test**

Create `src/tests/BaseApi.Tests/SKNormalizer/SKNormalizerConfigTests.cs` (if the file exists, add the two facts to it):

```csharp
using System.Text.Json;
using BaseProcessor.Core.Configuration;
using Processor.SKNormalizer;
using Xunit;

namespace BaseApi.Tests.SKNormalizer;

/// <summary>
/// The cache seam, declared and not yet read.
/// <para>
/// It is added ahead of the behaviour because adding it later is not free.
/// <c>ProcessorConfig.SerializerOptions</c> leaves <c>UnmappedMemberHandling</c> at its default of
/// Skip, so a payload carrying <c>cacheAddress</c> against a record that does not declare it is
/// silently discarded — the exact failure that looks like a whitelist matching nothing. Declaring it
/// now means the behaviour change later is a handler edit rather than a contract edit.
/// </para>
/// </summary>
public sealed class SKNormalizerConfigTests
{
    private static SKNormalizerConfig? Bind(string payload) =>
        JsonSerializer.Deserialize<SKNormalizerConfig>(payload, ProcessorConfig.SerializerOptions);

    [Fact]
    public void APayloadCarryingACacheAddressBindsIt()
    {
        var config = Bind(
            """{"handler":"Acme","cacheAddress":"skp:11111111-1111-1111-1111-111111111111:cache:sk-whitelist"}""");

        Assert.Equal(
            "skp:11111111-1111-1111-1111-111111111111:cache:sk-whitelist",
            config!.CacheAddress);
    }

    [Fact]
    public void APayloadOmittingItLeavesItNull()
    {
        // Null is what the processor will later treat as a payload defect rather than a cache miss,
        // so that a step whose address was forgotten fails loudly instead of cancelling every
        // document as though nothing were whitelisted.
        var config = Bind("""{"handler":"Acme"}""");

        Assert.Null(config!.CacheAddress);
    }

    [Fact]
    public void TheHandlerStillBinds()
    {
        Assert.Equal("Acme", Bind("""{"handler":"Acme"}""")!.Handler);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
```

Expected: FAIL to compile — `SKNormalizerConfig` has no `CacheAddress`.

- [ ] **Step 3: Add the property**

Replace the body of `src/Processor.SKNormalizer/SKNormalizerConfig.cs`:

```csharp
using BaseProcessor.Core.Configuration;

namespace Processor.SKNormalizer;

/// <summary>
/// The step payload this processor binds.
/// <para>
/// <b><see cref="CacheAddress"/> is declared and deliberately unread.</b> It is the seam for the
/// whitelist behaviour: the full L2 address of one projected dictionary —
/// <c>skp:{workflowId}:cache:{root}</c> — which the handler will later append a name to. The
/// operator authors it; nothing rewrites a payload to supply it.
/// </para>
/// <para>
/// It is declared ahead of the behaviour because <c>ProcessorConfig.SerializerOptions</c> leaves
/// <c>UnmappedMemberHandling</c> at Skip: a payload carrying the property against a record that does
/// not declare it binds silently to nothing, which is indistinguishable from a whitelist that
/// matches nothing.
/// </para>
/// <para>
/// <b>When the behaviour ships, a null here is a payload defect, not a cache miss.</b> Reporting it
/// as a miss would cancel every document of a step whose address was simply forgotten, which reads
/// in the logs exactly like a correctly-configured empty whitelist.
/// </para>
/// <para>
/// Authoring it in a payload will also require SKNormalizer's config schema to declare it. Every
/// config schema in the chain sets <c>additionalProperties: false</c>, and schema definitions are
/// frozen — so that is a new schema row, both sides re-pointed, and a restart. Nothing here triggers
/// it; the day an operator writes the property does.
/// </para>
/// </summary>
public sealed record SKNormalizerConfig(string Handler, string? CacheAddress = null) : ProcessorConfig;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
dotnet build src/tests/BaseApi.Tests/BaseApi.Tests.csproj -c Debug --nologo
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-class "BaseApi.Tests.SKNormalizer.SKNormalizerConfigTests"
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full hermetic suite**

```bash
src/tests/BaseApi.Tests/bin/Debug/net8.0/BaseApi.Tests.exe --filter-not-namespace "BaseApi.Tests.Live*"
```

Expected: 0 failed, exit code 0.

- [ ] **Step 6: Build the whole solution**

```bash
dotnet build SK_P.sln --nologo
```

Expected: 0 errors. This is the last chance to catch a consumer of `WorkflowL1` or the workflow DTOs
outside the test project.

- [ ] **Step 7: Commit**

```bash
git add src/Processor.SKNormalizer/SKNormalizerConfig.cs src/tests/BaseApi.Tests/SKNormalizer
git commit -m "feat(cache): declare the SKNormalizer cache seam, unread for now"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: §3.1 → Task 1; §3.2 → Task 2; §3.3 → Task 3; §4 → Tasks 1–2; §4.1 → Tasks 2 and 5; §5.1 → Task 4; §5.2 → Task 6; §5.3 → Tasks 4 and 6; §5.4 → Task 7; §5.5 → Tasks 4 and 5; §6 → Task 8; §7.1 → Task 2's delete-policy fact; §7.3 → no task, correctly: the gate order is unchanged, and `OrchestrationService.StartAsync` is untouched; §7.4 → Tasks 1, 5 and 6 each assert the empty-dictionary case; §7.5 → the 1 MB cap in Task 1; §8 → the rejected alternatives need no task; §9 → the tests are distributed across Tasks 1–8.

**Two deliberate deviations from the spec.**

1. The spec's §4.1 asks only for the `Guid.Empty` rule on `CacheIds`. Task 2 adds the uniqueness rule too, because the `AssignmentIds` rule it mirrors has both, and a duplicate would put the same root in `CacheRoots` twice.
2. The spec does not mention a test seam. Task 5 adds `OrchestrationService.ToDefinitionForTests`, because `ToDefinition` is private and static and reaching it through a constructed service would mean supplying eight dependencies it does not touch.

**Dependency injection needs no new wiring, and the plan says so explicitly.** The first draft left this as an open question for the executor; it is now resolved in Task 5 Step 6. Mappers and validators are registered by assembly scan over the `AppDbContext` assembly, and `IRepository<>` is an open-generic registration, so `CacheEntityMapper`, both cache validators and `IRepository<CacheEntity>` all resolve without a line being added. `AddCacheFeature` registers only the service and its alias.

**One risk the plan carries rather than resolves.** Task 2 Step 7 tells the executor to let the compiler enumerate the broken `WorkflowCreateDto` / `WorkflowUpdateDto` / `WorkflowReadDto` call sites rather than listing them. There are 14, across two test files, and they are mechanical — but if a call site exists outside `src/` (a sample, a script, a doc snippet compiled somewhere) the compiler will not find it. `dotnet build SK_P.sln` in Task 8 Step 6 is the backstop.

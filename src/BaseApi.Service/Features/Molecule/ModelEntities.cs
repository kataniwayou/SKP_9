using BaseApi.Core.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;

namespace BaseApi.Service.Features.Molecule;

/// <summary>
/// Every entity table with the types that serve it, found rather than listed: a table's entity class is paired with
/// the <see cref="BaseService{TEntity, TCreate, TUpdate, TRead}"/> subclass serving it, whose type arguments name its
/// create, update and read DTOs. <c>GET /model/fields</c> describes the update DTOs; <c>POST /model/validate</c> runs a
/// change through the same service a <c>PUT</c> or <c>DELETE</c> uses.
/// </summary>
internal static class ModelEntities
{
    private static readonly Lazy<IReadOnlyDictionary<Type, ModelEntity>> ByEntity = new(Scan);

    /// <summary>The entities of the model's tables, by table name.</summary>
    public static IReadOnlyDictionary<string, ModelEntity> ByTable(IModel model) =>
        model.GetEntityTypes()
            .Where(e => e.GetTableName() is not null && ByEntity.Value.ContainsKey(e.ClrType))
            .ToDictionary(e => e.GetTableName()!, e => ByEntity.Value[e.ClrType] with { Table = e.GetTableName()! }, StringComparer.Ordinal);

    private static IReadOnlyDictionary<Type, ModelEntity> Scan()
    {
        var map = new Dictionary<Type, ModelEntity>();
        foreach (var type in typeof(ModelEntities).Assembly.GetTypes().Where(t => t is { IsClass: true, IsAbstract: false }))
        {
            for (var b = type.BaseType; b is not null; b = b.BaseType)
            {
                if (!b.IsGenericType || b.GetGenericTypeDefinition() != typeof(BaseService<,,,>)) continue;
                var a = b.GetGenericArguments();
                map[a[0]] = new ModelEntity("", a[0], a[1], a[2], a[3], b);
                break;
            }
        }
        return map;
    }
}

/// <param name="Table">The entity's table.</param>
/// <param name="Entity">The entity class.</param>
/// <param name="CreateDto">The body a <c>POST</c> sends.</param>
/// <param name="UpdateDto">The body a <c>PUT</c> sends.</param>
/// <param name="ReadDto">The body a read returns.</param>
/// <param name="Service">The closed <c>BaseService</c> type, as the feature registers it in DI.</param>
internal sealed record ModelEntity(string Table, Type Entity, Type CreateDto, Type UpdateDto, Type ReadDto, Type Service);

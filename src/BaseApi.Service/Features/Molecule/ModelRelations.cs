using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Migrations;

namespace BaseApi.Service.Features.Molecule;

/// <summary>
/// Describes the schema's tables and foreign keys from the EF relational model, which is the database's own schema:
/// BaseApi applies every migration at startup, so a running process never describes rules its database lacks.
/// <para>
/// Nothing here names a table, a column or a rule. A table is a <c>link</c> when its primary key is exactly its foreign
/// keys; a key's strength (<see cref="ModelRelationDto.Bond"/>) follows from that, its nullability and its delete action.
/// A migration that adds a table, adds a key or changes a rule changes the description with no edit here.
/// </para>
/// <para>
/// The relational model exists only on a relational provider, so the in-memory provider cannot describe the schema
/// (it also names tables after the classes). Tests describe it from a context configured for Npgsql, which builds the
/// model without connecting.
/// </para>
/// </summary>
internal static class ModelRelations
{
    // The model is built once per process and never changes, so its description is built once too.
    private static readonly ConditionalWeakTable<IModel, ModelRelationsSnapshot> Cache = new();

    public static ModelRelationsSnapshot Describe(IModel model) => Cache.GetValue(model, Build);

    private static ModelRelationsSnapshot Build(IModel model)
    {
        var tables = model.GetRelationalModel().Tables.OrderBy(t => t.Name, StringComparer.Ordinal).ToList();
        var tableDtos = new List<ModelTableDto>();
        var relations = new List<ModelRelationDto>();
        var maps = new List<RelationMap>();
        var shapes = new Dictionary<Type, TableShape>();

        foreach (var table in tables)
        {
            var link = IsLink(table);
            var entityType = table.EntityTypeMappings.Single().TypeBase.ClrType;
            var label = link ? null : table.FindColumn("name");
            tableDtos.Add(new ModelTableDto(table.Name, link ? "link" : "entity", label?.Name));

            // The CLR side of each column, so rows loaded through any provider can be read by column name.
            var columns = table.Columns
                .SelectMany(c => c.PropertyMappings.Select(m => m.Property))
                .Where(p => !p.IsShadowProperty())
                .Select(p => new ColumnShape(p.Name, p.GetTableColumnMappings().Single().Column.Name, p.IsPrimaryKey(), p.IsForeignKey()))
                .ToList();
            shapes[entityType] = new TableShape(table.Name, link, label?.PropertyMappings.Single().Property.Name, columns);

            var cascades = table.ForeignKeyConstraints.Any(f => f.OnDeleteAction == ReferentialAction.Cascade);
            var keyOrder = table.PrimaryKey?.Columns.ToList() ?? [];
            foreach (var fk in table.ForeignKeyConstraints.OrderBy(f => f.Name, StringComparer.Ordinal))
            {
                var nullable = fk.Columns.Any(c => c.IsNullable);
                var bond = link ? (cascades ? 4 : 3) : (nullable ? 2 : 1);
                var side = link ? (keyOrder.IndexOf(fk.Columns[0]) == 0 ? "from" : "to") : null;
                var relation = new ModelRelationDto(
                    fk.Name,
                    table.Name,
                    string.Join(",", fk.Columns.Select(c => c.Name)),
                    fk.PrincipalTable.Name,
                    OnDelete(fk.OnDeleteAction),
                    nullable,
                    bond,
                    side);
                relations.Add(relation);

                var mapped = fk.MappedForeignKeys.First();
                maps.Add(new RelationMap(
                    relation,
                    entityType,
                    mapped.Properties.Select(p => p.Name).ToList(),
                    mapped.PrincipalEntityType.ClrType));
            }
        }

        var dto = new ModelRelationsDto(tableDtos, relations);
        return new ModelRelationsSnapshot(dto, ETagOf(dto), shapes, maps);
    }

    /// <summary>A link table's primary key is exactly its foreign keys: its rows exist only to join two others.</summary>
    internal static bool IsLink(ITable table)
    {
        var fks = table.ForeignKeyConstraints.ToList();
        if (table.PrimaryKey is not { } pk || fks.Count < 2) return false;
        return pk.Columns.ToHashSet().SetEquals(fks.SelectMany(f => f.Columns));
    }

    private static string OnDelete(ReferentialAction action) => action switch
    {
        ReferentialAction.Restrict => "RESTRICT",
        ReferentialAction.Cascade => "CASCADE",
        ReferentialAction.SetNull => "SET NULL",
        ReferentialAction.SetDefault => "SET DEFAULT",
        _ => "NO ACTION",
    };

    // A strong validator for If-None-Match: the description only changes with a migration, so a client keeps it
    // until BaseApi is redeployed with a different schema.
    private static string ETagOf(ModelRelationsDto dto)
    {
        var text = string.Join('\n', dto.Tables.Select(t => t.ToString()).Concat(dto.Relations.Select(r => r.ToString())));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..16].ToLowerInvariant();
    }
}

/// <summary>The description plus what <see cref="MoleculeReader"/> needs to read rows by it.</summary>
internal sealed record ModelRelationsSnapshot(
    ModelRelationsDto Dto,
    string ETag,
    IReadOnlyDictionary<Type, TableShape> Tables,
    IReadOnlyList<RelationMap> Relations);

/// <summary>A table as its entity class sees it.</summary>
/// <param name="Table">The table's name in the database.</param>
/// <param name="IsLink">Whether its primary key is exactly its foreign keys.</param>
/// <param name="LabelProperty">The property mapped to the label column, or null.</param>
/// <param name="Columns">Every column mapped to a CLR property, with that property.</param>
internal sealed record TableShape(string Table, bool IsLink, string? LabelProperty, IReadOnlyList<ColumnShape> Columns);

internal sealed record ColumnShape(string Property, string Column, bool IsPrimaryKey, bool IsForeignKey);

/// <summary>A relation with the entity classes and properties that carry it.</summary>
internal sealed record RelationMap(ModelRelationDto Relation, Type Owner, IReadOnlyList<string> Properties, Type Target);

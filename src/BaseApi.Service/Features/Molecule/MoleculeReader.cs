using System.Reflection;
using BaseApi.Core.Exceptions;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Orchestration.Loading;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;

namespace BaseApi.Service.Features.Molecule;

/// <summary>Reads one workflow's molecule.</summary>
public interface IMoleculeReader
{
    Task<MoleculeDto> ReadAsync(Guid workflowId, CancellationToken ct);
}

/// <summary>
/// One workflow's rows and the foreign-key links between them.
/// <para>
/// <b>The scope is the one thing that knows this schema.</b> Which rows belong to a workflow is
/// <see cref="IWorkflowGraphLoader"/>'s answer, the same step set a start validates: the workflow, every step reachable
/// from its entry steps over the next-step links, their processors and schemas, and the workflow's assignments and caches.
/// </para>
/// <para>
/// Everything after the scope is read through <see cref="ModelRelations"/>: the rows of each in-scope table, a bond for
/// every key column whose target is in scope, and a bond for every link-table row whose two ends are in scope. Each bond
/// is named by its constraint, so a client joins it to its rule with no mapping of its own.
/// </para>
/// </summary>
internal sealed class MoleculeReader : IMoleculeReader
{
    /// <summary>A longer value (a schema definition, a payload, a diagram) is left out of an atom and listed as omitted.</summary>
    public const int MaxValueLength = 200;

    private static readonly MethodInfo LoadMethod =
        typeof(MoleculeReader).GetMethod(nameof(Load), BindingFlags.NonPublic | BindingFlags.Static)!;

    private readonly AppDbContext _db;
    private readonly IWorkflowGraphLoader _loader;
    private readonly IModelRelationsSource _relations;

    public MoleculeReader(AppDbContext db, IWorkflowGraphLoader loader, IModelRelationsSource relations)
    {
        _db = db ?? throw new ArgumentNullException(nameof(db));
        _loader = loader ?? throw new ArgumentNullException(nameof(loader));
        _relations = relations ?? throw new ArgumentNullException(nameof(relations));
    }

    public async Task<MoleculeDto> ReadAsync(Guid workflowId, CancellationToken ct)
    {
        var schema = _relations.Get();
        var scope = await ScopeAsync(workflowId, ct);
        bool InScope(Type type, Guid id) => scope.TryGetValue(type, out var ids) && ids.Contains(id);

        var atoms = new List<MoleculeAtomDto>();
        var rowsByType = new Dictionary<Type, List<object>>();
        foreach (var (type, ids) in scope)
        {
            if (ids.Count == 0 || !schema.Tables.TryGetValue(type, out var shape)) continue;
            var rows = await LoadAsync(type, KeyOf(shape), ids, ct);
            rowsByType[type] = rows;
            atoms.AddRange(rows.Select(row => Atom(shape, row)));
        }

        var bonds = new List<MoleculeBondDto>();

        // A key column of a row: one bond to the row it names, when that row is in scope.
        foreach (var map in schema.Relations.Where(m => !schema.Tables[m.Owner].IsLink))
        {
            if (!rowsByType.TryGetValue(map.Owner, out var rows)) continue;
            var key = KeyOf(schema.Tables[map.Owner]);
            foreach (var row in rows)
            {
                if (Read(row, map.Properties[0]) is Guid to && InScope(map.Target, to))
                    bonds.Add(new MoleculeBondDto(map.Relation.Constraint, null, (Guid)Read(row, key)!, to, [map.Relation.Constraint]));
            }
        }

        // A link-table row: one bond from its first key's row to its second's, when both are in scope.
        foreach (var link in schema.Relations.Where(m => schema.Tables[m.Owner].IsLink).GroupBy(m => m.Owner))
        {
            var from = link.Single(m => m.Relation.LinkSide == "from");
            var to = link.Single(m => m.Relation.LinkSide == "to");
            if (!scope.TryGetValue(from.Target, out var fromIds) || fromIds.Count == 0) continue;
            foreach (var row in await LoadAsync(link.Key, from.Properties[0], fromIds, ct))
            {
                var a = (Guid)Read(row, from.Properties[0])!;
                var b = (Guid)Read(row, to.Properties[0])!;
                if (InScope(to.Target, b))
                    bonds.Add(new MoleculeBondDto(null, schema.Tables[link.Key].Table, a, b, [from.Relation.Constraint, to.Relation.Constraint]));
            }
        }

        return new MoleculeDto(
            workflowId,
            atoms.OrderBy(a => a.Table, StringComparer.Ordinal).ThenBy(a => a.Label, StringComparer.Ordinal).ThenBy(a => a.Id).ToList(),
            bonds.OrderBy(b => b.Constraint ?? b.Link, StringComparer.Ordinal).ThenBy(b => b.From).ThenBy(b => b.To).ToList());
    }

    // The loader's snapshot holds read DTOs; only their ids are kept, by the entity class whose table holds them.
    private async Task<Dictionary<Type, HashSet<Guid>>> ScopeAsync(Guid workflowId, CancellationToken ct)
    {
        using var snapshot = await _loader.LoadL1Async([workflowId], ct);
        if (!snapshot.Workflows.ContainsKey(workflowId))
            throw new NotFoundException(nameof(WorkflowEntity), workflowId);

        return new Dictionary<Type, HashSet<Guid>>
        {
            [typeof(WorkflowEntity)] = [.. snapshot.Workflows.Keys],
            [typeof(StepEntity)] = [.. snapshot.Steps.Keys],
            [typeof(ProcessorEntity)] = [.. snapshot.Processors.Keys],
            [typeof(SchemaEntity)] = [.. snapshot.Schemas.Keys],
            [typeof(AssignmentEntity)] = [.. snapshot.Assignments.Keys],
            [typeof(CacheEntity)] = [.. snapshot.Caches.Keys],
        };
    }

    private static MoleculeAtomDto Atom(TableShape shape, object row)
    {
        var columns = new Dictionary<string, object?>(StringComparer.Ordinal);
        var omitted = new List<string>();
        foreach (var column in shape.Columns.Where(c => !c.IsPrimaryKey && !c.IsForeignKey))
        {
            var value = Read(row, column.Property);
            if (value is string { Length: > MaxValueLength }) { omitted.Add(column.Column); continue; }
            columns[column.Column] = value is Enum e ? e.ToString() : value;
        }
        var label = shape.LabelProperty is { } p ? Read(row, p) as string : null;
        return new MoleculeAtomDto(shape.Table, (Guid)Read(row, KeyOf(shape))!, label, columns, omitted);
    }

    private static string KeyOf(TableShape shape) => shape.Columns.Single(c => c.IsPrimaryKey).Property;

    private static object? Read(object row, string property) => row.GetType().GetProperty(property)!.GetValue(row);

    private Task<List<object>> LoadAsync(Type type, string property, IReadOnlyCollection<Guid> ids, CancellationToken ct) =>
        (Task<List<object>>)LoadMethod.MakeGenericMethod(type).Invoke(null, [_db, property, ids.ToList(), ct])!;

    // The rows of one table whose given key column is one of the ids, untracked.
    private static async Task<List<object>> Load<T>(AppDbContext db, string property, List<Guid> ids, CancellationToken ct)
        where T : class =>
        (await db.Set<T>().AsNoTracking().Where(e => ids.Contains(EF.Property<Guid>(e, property))).ToListAsync(ct))
            .Cast<object>().ToList();
}

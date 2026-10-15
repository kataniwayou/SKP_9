namespace BaseApi.Service.Features.Molecule;

/// <summary>
/// The body of <c>GET /model/relations</c>: every table and every foreign key the database enforces, read from the
/// model at runtime, so a client draws and checks the schema's links without holding any rule of its own.
/// </summary>
public sealed record ModelRelationsDto(IReadOnlyList<ModelTableDto> Tables, IReadOnlyList<ModelRelationDto> Relations);

/// <param name="Table">The table's name in the database.</param>
/// <param name="Kind"><c>entity</c>, or <c>link</c> for a table whose primary key is exactly its foreign keys.</param>
/// <param name="Label">The column that names a row (<c>name</c>), or null when the table has none.</param>
public sealed record ModelTableDto(string Table, string Kind, string? Label);

/// <summary>One foreign key, in the database's own terms.</summary>
/// <param name="Constraint">The constraint's name, which also keys the bonds of <c>GET /workflows/{id}/molecule</c>.</param>
/// <param name="Owner">The table holding the key column.</param>
/// <param name="Column">The key column (comma-joined for a composite key).</param>
/// <param name="Target">The table the key points at.</param>
/// <param name="OnDelete">What a delete of the target row does: RESTRICT, NO ACTION, CASCADE, SET NULL or SET DEFAULT.</param>
/// <param name="Nullable">Whether the key column may be cleared; a NOT NULL key goes only with its row.</param>
/// <param name="Bond">
/// The link's strength, 1 (hardest to break) to 4: 1 a NOT NULL key column of an entity, 2 a nullable one, 3 a link
/// table, 4 a link table that cascades from one end.
/// </param>
/// <param name="LinkSide">On a link table, <c>from</c> for the key listed first in its primary key, <c>to</c> for the other; null otherwise.</param>
public sealed record ModelRelationDto(
    string Constraint,
    string Owner,
    string Column,
    string Target,
    string OnDelete,
    bool Nullable,
    int Bond,
    string? LinkSide);

/// <summary>
/// The body of <c>GET /workflows/{id}/molecule</c>: the workflow's rows and the foreign-key links between them, each link
/// named by its constraint, so a client joins it to <see cref="ModelRelationDto"/> without knowing the schema.
/// </summary>
public sealed record MoleculeDto(Guid WorkflowId, IReadOnlyList<MoleculeAtomDto> Atoms, IReadOnlyList<MoleculeBondDto> Bonds);

/// <summary>One row.</summary>
/// <param name="Table">The row's table, as in <see cref="ModelTableDto.Table"/>.</param>
/// <param name="Id">The row's primary key.</param>
/// <param name="Label">The row's name, or null when its table has no label column.</param>
/// <param name="Columns">
/// The row's own columns by column name: everything but its primary key, its foreign keys (they are the bonds) and
/// values longer than <see cref="MoleculeReader.MaxValueLength"/> characters. An enum comes as its name.
/// </param>
/// <param name="Omitted">The columns left out for length; the CRUD read of the row has them.</param>
public sealed record MoleculeAtomDto(
    string Table,
    Guid Id,
    string? Label,
    IReadOnlyDictionary<string, object?> Columns,
    IReadOnlyList<string> Omitted);

/// <summary>
/// One link between two rows. A key column gives one bond per row, named by its <see cref="Constraint"/>. A link-table
/// row gives one bond named by its <see cref="Link"/> table, carrying both of that table's constraints.
/// </summary>
public sealed record MoleculeBondDto(
    string? Constraint,
    string? Link,
    Guid From,
    Guid To,
    IReadOnlyList<string> Constraints);

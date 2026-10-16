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

/// <summary>
/// The body of <c>GET /model/fields</c>: every entity's writable fields with the rules a write must pass, read from the
/// update validators and the EF model at runtime, so a client checks an edit as BaseApi will without a copy of the rules.
/// </summary>
public sealed record ModelFieldsDto(IReadOnlyList<ModelEntityFieldsDto> Entities);

/// <param name="Table">The entity's table, as in <see cref="ModelTableDto.Table"/>.</param>
/// <param name="Fields">The update DTO's properties, in its order: what a <c>PUT</c> sends.</param>
/// <param name="Unique">The table's unique indexes, each a 409 on a duplicate.</param>
public sealed record ModelEntityFieldsDto(string Table, IReadOnlyList<ModelFieldDto> Fields, IReadOnlyList<ModelUniqueDto> Unique);

/// <summary>One writable field.</summary>
/// <param name="Field">Its JSON name, as the read and update bodies carry it.</param>
/// <param name="Column">The column it is stored in, or null when it is held elsewhere (a link table's rows).</param>
/// <param name="Type">string, guid, enum, integer, number, boolean, datetime, object, or an item type with <c>[]</c> for a list.</param>
/// <param name="Nullable">Whether an update may send null.</param>
/// <param name="StoreType">The column's database type (<c>jsonb</c> holds JSON), or null with no column.</param>
/// <param name="Rules">The validator's rules for it, in the order they run.</param>
/// <param name="Values">For an enum, every value with its name; the rules say which are refused.</param>
public sealed record ModelFieldDto(
    string Field,
    string? Column,
    string Type,
    bool Nullable,
    string? StoreType,
    IReadOnlyList<ModelRuleDto> Rules,
    IReadOnlyList<ModelEnumValueDto>? Values);

/// <summary>One validator rule.</summary>
/// <param name="Kind">
/// <c>required</c> (not null, not empty, not blank), <c>notNull</c>, <c>maxLength</c>, <c>minLength</c>, <c>length</c>
/// (<c>min..max</c>), <c>pattern</c> (a .NET regular expression), <c>enum</c> (a defined value), <c>notEqual</c>,
/// <c>equal</c>, or <c>code</c>: a rule written as code, which only BaseApi can run.
/// </param>
/// <param name="Value">The rule's value: the length, the pattern, the compared value (an enum as its number); else null.</param>
/// <param name="Message">The rule's own message, or null when it uses FluentValidation's default.</param>
/// <param name="Conditional">Whether it applies only under a condition, such as only when the field is given.</param>
public sealed record ModelRuleDto(string Kind, string? Value, string? Message, bool Conditional);

public sealed record ModelEnumValueDto(long Value, string Name);

/// <param name="Index">The unique index's name in the database.</param>
/// <param name="Fields">Its fields (a column name where no field maps to it).</param>
/// <param name="Filter">The index's SQL filter, when it covers only some rows; null for every row.</param>
public sealed record ModelUniqueDto(string Index, IReadOnlyList<string> Fields, string? Filter);

/// <summary>The body of <c>POST /model/validate</c>: the changes, in the order they would be sent.</summary>
public sealed record ModelChangesDto(IReadOnlyList<ModelChangeDto> Changes);

/// <summary>One change.</summary>
/// <param name="Op"><c>update</c> (a <c>PUT</c>) or <c>delete</c> (a <c>DELETE</c>).</param>
/// <param name="Table">The entity's table, as <c>GET /model/fields</c> names it.</param>
/// <param name="Id">The row's id.</param>
/// <param name="Row">For an update, the body a <c>PUT</c> would send; absent for a delete.</param>
public sealed record ModelChangeDto(string Op, string Table, Guid Id, System.Text.Json.JsonElement? Row);

/// <summary>The dry run's answer: whether every change passed, and each change's result in order.</summary>
public sealed record ModelValidateResultDto(bool Ok, IReadOnlyList<ModelChangeResultDto> Results);

/// <param name="Index">The change's place in the request.</param>
/// <param name="Op">The change's op, as sent.</param>
/// <param name="Table">The change's table, as sent.</param>
/// <param name="Id">The change's row id, as sent.</param>
/// <param name="Ok">Whether it passed, on the state the changes before it left.</param>
/// <param name="Status">What the real call would answer: 200 or 204, else the problem's status.</param>
/// <param name="Problem">The problem the real call would answer (its <c>errors</c>, <c>detail</c>, <c>field</c>…), or null.</param>
public sealed record ModelChangeResultDto(int Index, string Op, string Table, Guid Id, bool Ok, int Status, System.Text.Json.JsonElement? Problem);

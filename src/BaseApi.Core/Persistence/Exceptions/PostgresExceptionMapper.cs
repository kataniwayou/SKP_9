using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace BaseApi.Core.Persistence.Exceptions;

/// <summary>
/// Translates an EF Core <see cref="DbUpdateException"/> wrapping a <see cref="PostgresException"/>
/// into an HTTP-friendly status, detail and column triple. A pure helper — no dependency injection,
/// nothing async, unit-testable in isolation.
///
/// <para>
/// <b>SQLSTATE coverage:</b> <c>23503</c> (foreign key violation) and <c>23001</c> (restrict
/// violation) map to 422; <c>23505</c> (unique violation) maps to 409. An unmapped SQLSTATE returns
/// false, so the caller falls through to the catch-all 500 — and the stack is still logged, which is
/// how an unmapped SQLSTATE gets discovered.
/// </para>
///
/// <para>
/// <b>Both foreign-key SQLSTATEs are required — they are directional, not alternatives.</b> Postgres
/// raises 23503 when an insert or update references a row that does not exist, but 23001 when a
/// delete, or a key update, is refused by an <c>ON DELETE RESTRICT</c> foreign key. EF Core's
/// restrict delete behaviour emits a literal <c>ON DELETE RESTRICT</c>, so every
/// delete-blocked-by-reference in this schema arrives as 23001; only <c>ON DELETE NO ACTION</c> would
/// arrive as 23503. Handling 23503 alone left every restrict constraint returning 500 instead of the
/// contracted 422, on the very constraints whose insert direction mapped correctly. The two details
/// are deliberately opposite in meaning: 23503 says the supplied value references nothing, 23001 says
/// the target is still referenced.
/// </para>
///
/// <para>
/// <b>Constraint-name convention:</b> foreign keys are named <c>fk_&lt;owner&gt;_&lt;column&gt;</c>
/// and unique constraints <c>uq_&lt;owner&gt;_&lt;column&gt;</c>, where the owner is the owning table
/// or its singular. The extractor keeps the full column name including any <c>_id</c> suffix, so the
/// detail message lines up with the DTO field the caller actually sent.
/// </para>
///
/// <para>
/// <b>Information-disclosure guard:</b> the response detail carries only the extracted column name.
/// The exception's message text, detail, table name and schema name never appear in the HTTP body.
/// Constraint names and column names are accepted risk, being part of the published API surface. The
/// table name is read, to anchor the column extraction, but never emitted — and the exception's
/// detail field is unusable regardless: Npgsql redacts it unless error detail is explicitly enabled,
/// and on a restrict violation it names the referenced table's key column rather than the offending
/// foreign-key column.
/// </para>
/// </summary>
public static class PostgresExceptionMapper
{
    // Shape check applied to whatever survives the prefix strip in ExtractColumn: a snake_case
    // identifier and nothing else. This is a sanity gate, not the parser — the parser anchors on the
    // table name, because a constraint name alone cannot be split reliably when both segments may
    // contain underscores.
    private static readonly Regex ColumnRegex = new(
        @"^[a-z0-9]+(_[a-z0-9]+)*$",
        RegexOptions.Compiled);

    /// <summary>
    /// Attempts to map a <see cref="DbUpdateException"/> containing a <see cref="PostgresException"/>
    /// to an HTTP status code, a detail string and the offending column name.
    ///
    /// <para>
    /// Constraint names must follow the <c>fk_&lt;owner&gt;_&lt;column&gt;</c> and
    /// <c>uq_&lt;owner&gt;_&lt;column&gt;</c> convention, where the owner is the owning table or its
    /// singular. Owners containing underscores are fully supported. A name that does not satisfy the
    /// convention yields a null column and a generic detail, never a guessed column.
    /// </para>
    /// </summary>
    public static bool TryMap(
        DbUpdateException ex,
        out int httpStatus,
        out string detail,
        out string? columnName)
    {
        httpStatus = StatusCodes.Status500InternalServerError;
        detail = string.Empty;
        columnName = null;

        if (ex.InnerException is not PostgresException pgEx) return false;

        switch (pgEx.SqlState)
        {
            case "23503":  // foreign key violation — an insert or update pointed at a row that is not there
                httpStatus = StatusCodes.Status422UnprocessableEntity;
                columnName = ExtractColumn("fk", pgEx);
                detail = columnName is not null
                    ? $"Foreign key violation: {columnName} references a non-existent record."
                    : "Foreign key constraint violated.";
                return true;

            case "23001":  // restrict violation — a delete or update blocked by ON DELETE RESTRICT
                httpStatus = StatusCodes.Status422UnprocessableEntity;
                columnName = ExtractColumn("fk", pgEx);
                // Deliberately not the 23503 wording. That case means the value supplied points at
                // nothing; this one is its mirror image — the row exists and is still pointed at,
                // which is exactly why it cannot be removed.
                detail = columnName is not null
                    ? $"Foreign key violation: this record is still referenced via {columnName} and cannot be deleted."
                    : "Foreign key constraint violated: this record is still referenced by existing records and cannot be deleted.";
                return true;

            case "23505":  // unique violation
                httpStatus = StatusCodes.Status409Conflict;
                columnName = ExtractColumn("uq", pgEx);
                detail = columnName is not null
                    ? $"Unique constraint violation: {columnName} already exists."
                    : "Unique constraint violated.";
                return true;

            default:
                return false;  // unknown SQLSTATE — the caller falls through to the catch-all
        }
    }

    /// <summary>
    /// Extracts the offending column from a constraint name by stripping the
    /// <c>{kind}_{owner}_</c> prefix, where the owner comes from
    /// <see cref="PostgresException.TableName"/> rather than from a regex over the constraint name.
    ///
    /// <para>
    /// <b>Why the name cannot be parsed on its own.</b> Both halves of
    /// <c>fk_&lt;owner&gt;_&lt;column&gt;</c> may contain underscores — for example
    /// <c>fk_workflow_entry_steps_step_id</c> is <c>workflow_entry_steps</c> plus <c>step_id</c> — so
    /// no regex can place the boundary. Anchoring on the table removes the ambiguity: everything
    /// after the known owner prefix is the column.
    /// </para>
    ///
    /// <para>
    /// <b>Both foreign-key directions supply the same anchor.</b> Postgres populates the error's
    /// table field with the constraint's own referencing table in both directions: an inserting
    /// 23503 and a deleting 23001 on the same constraint both report the referencing table, even
    /// though the 23001 message text names the referenced one. So one rule works for both, whereas a
    /// strip-the-referenced-table rule would work for neither.
    /// </para>
    ///
    /// <para>
    /// <b>Singular fallback.</b> Junction tables name themselves exactly, while entity tables use the
    /// singular, so the exact table name is tried first and its s-stripped singular second.
    /// </para>
    ///
    /// <para>
    /// <b>Fails closed.</b> If the table field is absent, the constraint carries no recognizable owner
    /// prefix, or the remainder is not a snake_case identifier, this returns null and the caller emits
    /// a column-less detail. A wrong column name in a 422 is worse than none — it points the caller at
    /// a field that is not the problem — so guessing is deliberately not a fallback.
    /// </para>
    /// </summary>
    private static string? ExtractColumn(string kind, PostgresException pgEx)
    {
        var constraintName = pgEx.ConstraintName;
        var tableName = pgEx.TableName;
        if (string.IsNullOrEmpty(constraintName) || string.IsNullOrEmpty(tableName)) return null;

        foreach (var owner in OwnerCandidates(tableName))
        {
            var prefix = $"{kind}_{owner}_";
            if (!constraintName.StartsWith(prefix, StringComparison.Ordinal)) continue;

            var column = constraintName[prefix.Length..];
            if (ColumnRegex.IsMatch(column)) return column;
        }

        return null;
    }

    /// <summary>
    /// The table spellings a constraint name may legitimately use as its owner segment: the table
    /// itself, then its naive singular. Order matters — the exact match wins, so a table that
    /// genuinely ends in <c>s</c> is never mangled when its constraints spell it out in full.
    /// </summary>
    private static IEnumerable<string> OwnerCandidates(string tableName)
    {
        yield return tableName;
        if (tableName.Length > 1 && tableName.EndsWith('s')) yield return tableName[..^1];
    }
}

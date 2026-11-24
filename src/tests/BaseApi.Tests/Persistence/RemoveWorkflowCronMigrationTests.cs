using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Xunit;

namespace BaseApi.Tests.Persistence;

/// <summary>
/// A workflow has no cron (2026-11-24): the migration moves each workflow's cron onto its entry steps that had none,
/// then drops the column. The copy must run before the drop, or the crons are lost.
/// </summary>
public sealed class RemoveWorkflowCronMigrationTests
{
    private const string Previous = "20261124120000_AddEntryStepCron";
    private const string ThisOne = "20261124180000_RemoveWorkflowCron";

    private static string Script(string from, string to)
    {
        using var db = Support.NpgsqlModel.Context();
        return db.GetService<IMigrator>().GenerateScript(from, to);
    }

    [Fact]
    public void MigrationCopiesANonBlankWorkflowCronOntoEntriesWithoutOne()
    {
        var up = Script(Previous, ThisOne);

        const string copy = "UPDATE workflow_entry_steps e SET cron_expression = w.cron_expression FROM workflows w " +
                            "WHERE e.workflow_id = w.id AND e.cron_expression IS NULL AND w.cron_expression IS NOT NULL " +
                            "AND btrim(w.cron_expression) <> '';";
        const string drop = "ALTER TABLE workflows DROP COLUMN cron_expression;";
        var copyAt = up.IndexOf(copy, StringComparison.Ordinal);
        var dropAt = up.IndexOf(drop, StringComparison.Ordinal);

        Assert.True(copyAt >= 0, up);
        Assert.True(dropAt > copyAt, up);
        Assert.DoesNotContain("workflow_entry_steps DROP", up);
    }

    [Fact]
    public void DownReaddsTheWorkflowCronAsANullableBoundedColumn()
    {
        var down = Script(ThisOne, Previous);

        Assert.Contains("ALTER TABLE workflows ADD cron_expression character varying(120);", down);
    }
}

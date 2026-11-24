using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <summary>
    /// A workflow has no cron (2026-11-24): its entry steps carry the whole schedule. Each workflow's cron is first
    /// copied onto its entry steps that have none of their own, so every schedule that ran still runs, and only then
    /// is the workflows column dropped. Down re-adds the column empty; the copied entry crons stay where they are.
    /// </summary>
    public partial class RemoveWorkflowCron : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // before the drop, or the crons are gone
            migrationBuilder.Sql(
                "UPDATE workflow_entry_steps e SET cron_expression = w.cron_expression FROM workflows w " +
                "WHERE e.workflow_id = w.id AND e.cron_expression IS NULL AND w.cron_expression IS NOT NULL;");

            migrationBuilder.DropColumn(
                name: "cron_expression",
                table: "workflows");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "cron_expression",
                table: "workflows",
                type: "character varying(120)",
                maxLength: 120,
                nullable: true);
        }
    }
}

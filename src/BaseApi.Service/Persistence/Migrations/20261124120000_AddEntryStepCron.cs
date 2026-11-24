using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <summary>
    /// An entry step may carry its own cron: a nullable column on the workflow_entry_steps junction.
    /// Nothing is backfilled here. Since 20261124180000_RemoveWorkflowCron (which copies the workflow cron onto entries
    /// without one, then drops it) there is no workflow cron to fall back to: null means the step is not scheduled.
    /// </summary>
    public partial class AddEntryStepCron : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "cron_expression",
                table: "workflow_entry_steps",
                type: "character varying(120)",
                maxLength: 120,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "cron_expression",
                table: "workflow_entry_steps");
        }
    }
}

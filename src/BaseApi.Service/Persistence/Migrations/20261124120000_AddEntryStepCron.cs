using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <summary>
    /// An entry step may carry its own cron: a nullable column on the workflow_entry_steps junction.
    /// Null means the step follows the workflow's cron; nothing is backfilled.
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

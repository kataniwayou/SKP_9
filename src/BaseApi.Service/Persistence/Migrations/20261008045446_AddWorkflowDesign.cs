using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddWorkflowDesign : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "design",
                table: "workflows",
                type: "jsonb",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "design",
                table: "workflows");
        }
    }
}

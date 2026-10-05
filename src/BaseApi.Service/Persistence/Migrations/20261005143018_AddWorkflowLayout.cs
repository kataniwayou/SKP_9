using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddWorkflowLayout : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "layout",
                table: "workflows",
                type: "jsonb",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "layout",
                table: "workflows");
        }
    }
}

using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <summary>
    /// Optional board locations (Acto): where schemas and processors are drawn. Null means never placed.
    /// Four nullable double columns; nothing is backfilled here.
    /// </summary>
    public partial class AddSchemaProcessorLocations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<double>(
                name: "board_x",
                table: "schemas",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "board_y",
                table: "schemas",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "board_x",
                table: "processors",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "board_y",
                table: "processors",
                type: "double precision",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "board_x",
                table: "schemas");

            migrationBuilder.DropColumn(
                name: "board_y",
                table: "schemas");

            migrationBuilder.DropColumn(
                name: "board_x",
                table: "processors");

            migrationBuilder.DropColumn(
                name: "board_y",
                table: "processors");
        }
    }
}

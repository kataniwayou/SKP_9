using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <summary>
    /// Optional board locations (Acto): where steps, caches and workflows are drawn. Null means never placed.
    /// Six nullable double columns; nothing is backfilled here.
    /// </summary>
    public partial class AddBoardLocations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<double>(
                name: "board_x",
                table: "steps",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "board_y",
                table: "steps",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "board_x",
                table: "caches",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "board_y",
                table: "caches",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "board_x",
                table: "workflows",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "board_y",
                table: "workflows",
                type: "double precision",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "board_x",
                table: "steps");

            migrationBuilder.DropColumn(
                name: "board_y",
                table: "steps");

            migrationBuilder.DropColumn(
                name: "board_x",
                table: "caches");

            migrationBuilder.DropColumn(
                name: "board_y",
                table: "caches");

            migrationBuilder.DropColumn(
                name: "board_x",
                table: "workflows");

            migrationBuilder.DropColumn(
                name: "board_y",
                table: "workflows");
        }
    }
}

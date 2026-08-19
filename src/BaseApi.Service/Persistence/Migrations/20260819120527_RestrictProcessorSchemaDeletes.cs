using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class RestrictProcessorSchemaDeletes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_processor_config_schema_id",
                table: "processors");

            migrationBuilder.DropForeignKey(
                name: "fk_processor_input_schema_id",
                table: "processors");

            migrationBuilder.DropForeignKey(
                name: "fk_processor_output_schema_id",
                table: "processors");

            migrationBuilder.AddForeignKey(
                name: "fk_processor_config_schema_id",
                table: "processors",
                column: "config_schema_id",
                principalTable: "schemas",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "fk_processor_input_schema_id",
                table: "processors",
                column: "input_schema_id",
                principalTable: "schemas",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);

            migrationBuilder.AddForeignKey(
                name: "fk_processor_output_schema_id",
                table: "processors",
                column: "output_schema_id",
                principalTable: "schemas",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_processor_config_schema_id",
                table: "processors");

            migrationBuilder.DropForeignKey(
                name: "fk_processor_input_schema_id",
                table: "processors");

            migrationBuilder.DropForeignKey(
                name: "fk_processor_output_schema_id",
                table: "processors");

            migrationBuilder.AddForeignKey(
                name: "fk_processor_config_schema_id",
                table: "processors",
                column: "config_schema_id",
                principalTable: "schemas",
                principalColumn: "id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "fk_processor_input_schema_id",
                table: "processors",
                column: "input_schema_id",
                principalTable: "schemas",
                principalColumn: "id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "fk_processor_output_schema_id",
                table: "processors",
                column: "output_schema_id",
                principalTable: "schemas",
                principalColumn: "id",
                onDelete: ReferentialAction.SetNull);
        }
    }
}

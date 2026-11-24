using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <summary>
    /// A cache's items become rows (2026-11-24): one <c>cache_items</c> row per key instead of one <c>jsonb</c>
    /// document on <c>caches</c>, so a dictionary is no longer capped as a whole. The table is created and every
    /// stored pair copied into it before the column is dropped — in the other order the dictionaries are lost.
    /// A stored key longer than 256 characters fails the copy, and with it the migration, rather than being cut.
    /// Down rebuilds each document from its rows before dropping the table.
    /// </summary>
    public partial class CacheItemsTable : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "cache_items",
                columns: table => new
                {
                    cache_id = table.Column<Guid>(type: "uuid", nullable: false),
                    key = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: false),
                    value = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_cache_items", x => new { x.cache_id, x.key });
                    table.ForeignKey(
                        name: "fk_cache_items_cache_id",
                        column: x => x.cache_id,
                        principalTable: "caches",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            // before the drop, or the items are gone; the validator held every stored value to a string
            migrationBuilder.Sql(
                "INSERT INTO cache_items (cache_id, key, value) " +
                "SELECT c.id, e.key, e.value FROM caches c CROSS JOIN LATERAL jsonb_each_text(c.items) e;");

            migrationBuilder.DropColumn(
                name: "items",
                table: "caches");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "items",
                table: "caches",
                type: "jsonb",
                nullable: false,
                defaultValue: "{}");

            // before the drop, or the items are gone
            migrationBuilder.Sql(
                "UPDATE caches c SET items = COALESCE(" +
                "(SELECT jsonb_object_agg(i.key, i.value) FROM cache_items i WHERE i.cache_id = c.id), '{}'::jsonb);");

            migrationBuilder.DropTable(
                name: "cache_items");
        }
    }
}

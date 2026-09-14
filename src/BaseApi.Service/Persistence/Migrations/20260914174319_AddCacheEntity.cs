using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddCacheEntity : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "caches",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    root = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    items = table.Column<string>(type: "jsonb", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    version = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    created_by = table.Column<string>(type: "text", nullable: true),
                    updated_by = table.Column<string>(type: "text", nullable: true),
                    description = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_caches", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "workflow_caches",
                columns: table => new
                {
                    workflow_id = table.Column<Guid>(type: "uuid", nullable: false),
                    cache_id = table.Column<Guid>(type: "uuid", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_workflow_caches", x => new { x.workflow_id, x.cache_id });
                    table.ForeignKey(
                        name: "fk_workflow_caches_cache_id",
                        column: x => x.cache_id,
                        principalTable: "caches",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "fk_workflow_caches_workflow_id",
                        column: x => x.workflow_id,
                        principalTable: "workflows",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "uq_cache_root",
                table: "caches",
                column: "root",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_workflow_caches_cache_id",
                table: "workflow_caches",
                column: "cache_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "workflow_caches");

            migrationBuilder.DropTable(
                name: "caches");
        }
    }
}

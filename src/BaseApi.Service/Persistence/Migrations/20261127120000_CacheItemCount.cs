using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <summary>
    /// A stored item count on each cache, so a listing never touches the item rows. Backfilled from the
    /// rows already there.
    /// </summary>
    public partial class CacheItemCount : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "item_count",
                table: "caches",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.Sql(
                "UPDATE caches c SET item_count = (SELECT count(*) FROM cache_items i WHERE i.cache_id = c.id)");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "item_count",
                table: "caches");
        }
    }
}

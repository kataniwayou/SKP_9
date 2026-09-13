using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BaseApi.Service.Persistence.Migrations
{
    /// <summary>
    /// Replaces the outright unique index on <c>source_hash</c> with the pair that makes
    /// <c>(source_hash, instance_id)</c> unique while counting "no instance" as a value — two partial
    /// indexes rather than one composite, for the reasons in <c>ProcessorEntityConfiguration</c>.
    ///
    /// <para>
    /// <b>It needs no backfill.</b> The index being dropped already guaranteed one row per hash, and
    /// the new column arrives null on every existing row, so all of them land in
    /// <c>uq_processor_source_hash</c>'s filtered set and satisfy it unchanged. The window between the
    /// drop and the create is inside the migration's transaction.
    /// </para>
    ///
    /// <para>
    /// <b>Down is not always available, by nature rather than by omission.</b> It restores an
    /// unconditional unique index on <c>source_hash</c>, which fails if any build has been registered
    /// more than once by the time it runs — which is the whole point of the change. Reversing it means
    /// deleting the per-replica rows first.
    /// </para>
    /// </summary>
    public partial class AddProcessorInstanceId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "uq_processor_source_hash",
                table: "processors");

            migrationBuilder.AddColumn<string>(
                name: "instance_id",
                table: "processors",
                type: "character varying(200)",
                maxLength: 200,
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "uq_processor_instance_id",
                table: "processors",
                columns: new[] { "source_hash", "instance_id" },
                unique: true,
                filter: "instance_id IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "uq_processor_source_hash",
                table: "processors",
                column: "source_hash",
                unique: true,
                filter: "instance_id IS NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "uq_processor_instance_id",
                table: "processors");

            migrationBuilder.DropIndex(
                name: "uq_processor_source_hash",
                table: "processors");

            migrationBuilder.DropColumn(
                name: "instance_id",
                table: "processors");

            migrationBuilder.CreateIndex(
                name: "uq_processor_source_hash",
                table: "processors",
                column: "source_hash",
                unique: true);
        }
    }
}

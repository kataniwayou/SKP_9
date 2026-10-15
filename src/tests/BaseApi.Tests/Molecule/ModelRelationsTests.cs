using BaseApi.Service;
using BaseApi.Service.Features.Molecule;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Molecule;

/// <summary>
/// Pins the schema description <c>GET /model/relations</c> serves. The relational model exists only on a relational
/// provider, so the context is configured for Npgsql; building the model never connects.
/// </summary>
public sealed class ModelRelationsTests
{
    internal static AppDbContext NpgsqlModelContext() =>
        new(new DbContextOptionsBuilder<AppDbContext>().UseNpgsql("Host=unused;Database=unused").Options);

    private static ModelRelationsDto Describe()
    {
        using var db = NpgsqlModelContext();
        return ModelRelations.Describe(db.Model).Dto;
    }

    [Fact]
    public void DescribesEveryForeignKeyWithItsRuleNullabilityAndBond()
    {
        // Five key columns and four link tables of two keys each. CASCADE only where a workflow owns its link rows;
        // the processor's three schema keys are the only nullable ones (RESTRICT since 20260819120527).
        var expected = new[]
        {
            new ModelRelationDto("fk_assignment_step_id", "assignments", "step_id", "steps", "RESTRICT", false, 1, null),
            new ModelRelationDto("fk_processor_config_schema_id", "processors", "config_schema_id", "schemas", "RESTRICT", true, 2, null),
            new ModelRelationDto("fk_processor_input_schema_id", "processors", "input_schema_id", "schemas", "RESTRICT", true, 2, null),
            new ModelRelationDto("fk_processor_output_schema_id", "processors", "output_schema_id", "schemas", "RESTRICT", true, 2, null),
            new ModelRelationDto("fk_step_next_steps_next_step_id", "step_next_steps", "next_step_id", "steps", "RESTRICT", false, 3, "to"),
            new ModelRelationDto("fk_step_next_steps_step_id", "step_next_steps", "step_id", "steps", "RESTRICT", false, 3, "from"),
            new ModelRelationDto("fk_step_processor_id", "steps", "processor_id", "processors", "RESTRICT", false, 1, null),
            new ModelRelationDto("fk_workflow_assignments_assignment_id", "workflow_assignments", "assignment_id", "assignments", "RESTRICT", false, 4, "to"),
            new ModelRelationDto("fk_workflow_assignments_workflow_id", "workflow_assignments", "workflow_id", "workflows", "CASCADE", false, 4, "from"),
            new ModelRelationDto("fk_workflow_caches_cache_id", "workflow_caches", "cache_id", "caches", "RESTRICT", false, 4, "to"),
            new ModelRelationDto("fk_workflow_caches_workflow_id", "workflow_caches", "workflow_id", "workflows", "CASCADE", false, 4, "from"),
            new ModelRelationDto("fk_workflow_entry_steps_step_id", "workflow_entry_steps", "step_id", "steps", "RESTRICT", false, 4, "to"),
            new ModelRelationDto("fk_workflow_entry_steps_workflow_id", "workflow_entry_steps", "workflow_id", "workflows", "CASCADE", false, 4, "from"),
        };

        Assert.Equal(
            expected.OrderBy(r => r.Constraint, StringComparer.Ordinal),
            Describe().Relations.OrderBy(r => r.Constraint, StringComparer.Ordinal));
    }

    [Fact]
    public void ATableIsALinkExactlyWhenItsPrimaryKeyIsItsForeignKeys()
    {
        var expected = new[]
        {
            new ModelTableDto("assignments", "entity", "name"),
            new ModelTableDto("caches", "entity", "name"),
            new ModelTableDto("processors", "entity", "name"),
            new ModelTableDto("schemas", "entity", "name"),
            new ModelTableDto("step_next_steps", "link", null),
            new ModelTableDto("steps", "entity", "name"),
            new ModelTableDto("workflow_assignments", "link", null),
            new ModelTableDto("workflow_caches", "link", null),
            new ModelTableDto("workflow_entry_steps", "link", null),
            new ModelTableDto("workflows", "entity", "name"),
        };

        Assert.Equal(expected, Describe().Tables);
    }

    [Fact]
    public void NoForeignKeyInTheModelIsLeftOut()
    {
        // The generic guard: a key added by a future migration is described without any edit to ModelRelations.
        using var db = NpgsqlModelContext();
        var inModel = db.Model.GetEntityTypes().SelectMany(e => e.GetForeignKeys()).Count();

        Assert.Equal(inModel, ModelRelations.Describe(db.Model).Dto.Relations.Count);
    }

    [Fact]
    public void TheDescriptionIsBuiltOncePerModelUnderAStableETag()
    {
        using var a = NpgsqlModelContext();
        using var b = NpgsqlModelContext();

        var first = ModelRelations.Describe(a.Model);
        var second = ModelRelations.Describe(b.Model);

        Assert.Same(first, second); // one model per context type and provider, so one description
        Assert.Matches("^[0-9a-f]{16}$", first.ETag);
    }
}

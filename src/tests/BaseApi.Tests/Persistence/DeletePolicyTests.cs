using BaseApi.Service;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Workflow;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace BaseApi.Tests.Persistence;

/// <summary>
/// Pins the delete policy of every foreign key in the model. These are model-metadata assertions rather
/// than behavioural ones because the in-memory provider does not enforce referential integrity at all —
/// a delete test against it would pass no matter what the configuration said.
/// <para>
/// The policy is the schema's integrity contract: a reference from a live row must block the delete, so
/// nothing is left pointing at something that is gone. The one exception used to be the processor's
/// three schema references, which nulled the column instead — deleting a schema silently stripped the
/// contract off every processor using it, with nothing surfaced to the caller.
/// </para>
/// </summary>
public sealed class DeletePolicyTests
{
    private static AppDbContext NewContext() =>
        new(new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase($"delete-policy-{Guid.NewGuid():N}")
            .Options);

    [Theory]
    [InlineData(nameof(ProcessorEntity.InputSchemaId))]
    [InlineData(nameof(ProcessorEntity.OutputSchemaId))]
    [InlineData(nameof(ProcessorEntity.ConfigSchemaId))]
    public void ADeletedSchemaIsBlockedByAProcessorThatReferencesIt(string property)
    {
        using var db = NewContext();

        var fk = db.Model.FindEntityType(typeof(ProcessorEntity))!
            .GetForeignKeys()
            .Single(f => f.Properties.Any(p => p.Name == property));

        Assert.Equal(DeleteBehavior.Restrict, fk.DeleteBehavior);
    }

    [Fact]
    public void NoForeignKeyInTheModelNullsOutItsColumnOnDelete()
    {
        // The blanket form of the rule above: a silent SetNull anywhere in this model would mean a delete
        // that quietly rewrites rows the caller never named.
        using var db = NewContext();

        var offenders = db.Model.GetEntityTypes()
            .SelectMany(e => e.GetForeignKeys())
            .Where(f => f.DeleteBehavior is DeleteBehavior.SetNull or DeleteBehavior.ClientSetNull)
            .Select(f => $"{f.DeclaringEntityType.ShortName()}.{string.Join('+', f.Properties.Select(p => p.Name))}")
            .ToList();

        Assert.Empty(offenders);
    }

    [Fact]
    public void TheJunctionsStillCascadeFromTheirOwningWorkflow()
    {
        // Restrict must not be applied indiscriminately: the workflow owns its junction rows, so deleting
        // a workflow has to take them with it rather than be blocked by them.
        using var db = NewContext();

        foreach (var junction in new[] { typeof(WorkflowEntrySteps), typeof(WorkflowAssignments) })
        {
            var toWorkflow = db.Model.FindEntityType(junction)!
                .GetForeignKeys()
                .Single(f => f.Properties.Any(p => p.Name == nameof(WorkflowEntrySteps.WorkflowId)));

            Assert.Equal(DeleteBehavior.Cascade, toWorkflow.DeleteBehavior);
        }
    }
}

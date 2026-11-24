using System.Text.Json;
using BaseApi.Service.Features.Cache;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using BaseApi.Service.Features.Workflow.Design;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

public sealed class DesignFieldsTests
{
    private static Dictionary<string, JsonElement> F(string json) => JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    [Fact]
    public void WorkflowFieldsReplaceOnlyWhatIsSentAndNullClearsANullableOne()
    {
        var errors = new List<FieldError>();
        var dto = DesignFields.Apply(new WorkflowUpdateDto("wf", "1.0.0", "d", [Guid.NewGuid()], null, null),
            F("""{"name":"orders","description":null}"""), errors);

        Assert.Empty(errors);
        Assert.Equal(("orders", "1.0.0", (string?)null), (dto.Name, dto.Version, dto.Description));
    }

    [Fact]
    public void TheDesignPathRefusesCronExpressionAsUnknown()
    {
        // a workflow has no cron (2026-11-24): its entry steps carry the schedule
        var errors = new List<FieldError>();
        var dto = DesignFields.Apply(new WorkflowUpdateDto("wf", "1.0.0", "d", [Guid.NewGuid()], null, null),
            F("""{"cronExpression":"0 0 * * *"}"""), errors);

        Assert.Equal([new FieldError("cronExpression", "Unknown field 'cronExpression'.")], errors);
        Assert.Equal(("wf", "1.0.0", "d"), (dto.Name, dto.Version, dto.Description));

        var created = CreateWorkflowStage.FieldsOf(new DesignNewWorkflowDto(F("""{"name":"wf","cronExpression":"0 0 * * *"}""")), errors = []);
        Assert.Equal([new FieldError("cronExpression", "Unknown field 'cronExpression'.")], errors);
        Assert.Equal("wf", created.Name);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("\"\"")]
    [InlineData("\"  \"")]
    public void TheDesignPathIgnoresANullCronExpression(string value)
    {
        // WorkflowStudio (out of scope, not redeployed) still sends the field, usually as null, on a new-workflow save
        var stored = new WorkflowUpdateDto("wf", "1.0.0", "d", [Guid.NewGuid()], null, null);
        var errors = new List<FieldError>();
        var updated = DesignFields.Apply(stored, F($$"""{"cronExpression":{{value}}}"""), errors);

        Assert.Empty(errors);
        Assert.Equal(stored, updated);

        var created = CreateWorkflowStage.FieldsOf(
            new DesignNewWorkflowDto(F($$"""{"name":"orders","version":"1.0.0","description":null,"cronExpression":{{value}}}""")), errors);

        Assert.Empty(errors);
        Assert.Equal(("orders", "1.0.0", (string?)null), (created.Name, created.Version, created.Description));
    }

    [Fact]
    public void AStepsEntryConditionIsAWholeNumber()
    {
        var errors = new List<FieldError>();
        var dto = DesignFields.Apply(new StepUpdateDto("s", "1.0.0", null, Guid.NewGuid(), null, StepEntryCondition.PreviousCompleted),
            F("""{"entryCondition":4,"description":"x"}"""), errors);

        Assert.Empty(errors);
        Assert.Equal((StepEntryCondition)4, dto.EntryCondition);
        Assert.Equal("x", dto.Description);
    }

    [Fact]
    public void AnUnknownFieldAndAValueOfTheWrongTypeAreErrorsOnThoseFields()
    {
        var errors = new List<FieldError>();
        DesignFields.Apply(new CacheUpdateDto("c", "1.0.0", null, "root", "{}"), F("""{"colour":"red","root":7}"""), errors);

        Assert.Equal(["colour", "root"], errors.Select(e => e.Field!).OrderBy(f => f, StringComparer.Ordinal));
    }

    [Fact]
    public void AProcessorSlotIsClearedByNullAndNeverPointedByAField()
    {
        var (input, output, config) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var errors = new List<FieldError>();
        var dto = DesignFields.Apply(new ProcessorUpdateDto("p", "1.0.0", null, "hash", null, input, output, config),
            F($$"""{"inputSchemaId":null,"configSchemaId":"{{Guid.NewGuid()}}"}"""), errors);

        Assert.Equal(["configSchemaId"], errors.Select(e => e.Field!));
        Assert.Equal(((Guid?)null, (Guid?)output, (Guid?)config), (dto.InputSchemaId, dto.OutputSchemaId, dto.ConfigSchemaId));
    }

    [Theory]
    [InlineData("SourceHash", "sourceHash")]
    [InlineData("source_hash", "sourceHash")]
    [InlineData("EntryStepIds", "entryStepIds")]
    [InlineData("root", "root")]
    public void FieldNamesAreTheStudiosCamelCase(string from, string expected) => Assert.Equal(expected, DesignFields.FieldOf(from));
}

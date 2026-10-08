using System.Text.Json;
using BaseApi.Service.Features.Cache;
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
        var dto = DesignFields.Apply(new WorkflowUpdateDto("wf", "1.0.0", "d", [Guid.NewGuid()], null, null, "0 0 * * *"),
            F("""{"name":"orders","cronExpression":null}"""), errors);

        Assert.Empty(errors);
        Assert.Equal(("orders", "1.0.0", "d", (string?)null), (dto.Name, dto.Version, dto.Description, dto.CronExpression));
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

    [Theory]
    [InlineData("SourceHash", "sourceHash")]
    [InlineData("source_hash", "sourceHash")]
    [InlineData("EntryStepIds", "entryStepIds")]
    [InlineData("root", "root")]
    public void FieldNamesAreTheStudiosCamelCase(string from, string expected) => Assert.Equal(expected, DesignFields.FieldOf(from));
}

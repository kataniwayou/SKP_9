using System.Text.Json;
using BaseApi.Service.Features.Workflow.Design;
using FluentValidation;
using Xunit;

namespace BaseApi.Tests.WorkflowGraph;

/// <summary>Spec §4.3: only a body that is not a design at all is a 400.</summary>
public sealed class DesignShapeTests
{
    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();
    private static DesignSaveRequest Empty() => new(null, null, null, null, null, null, Json("{}"));

    [Fact]
    public void AnEmptyDesignWithALayoutIsWellFormed() =>
        Assert.Null(Record.Exception(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty())));

    [Fact]
    public void AMissingLayoutOrOneThatIsNotAnObjectIsMalformed()
    {
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with { Layout = null }));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with { Layout = Json("[]") }));
    }

    [Fact]
    public void TheSameStepTwiceIsMalformed()
    {
        var id = Guid.NewGuid();
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Steps = [new DesignStepDto(id, null, null, null), new DesignStepDto(id, null, null, null)],
        }));
    }

    [Fact]
    public void AnUnknownOpAndTwoOpsForOneStepAreMalformed()
    {
        var step = Guid.NewGuid();
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Assignments = [new DesignAssignmentDto("rename", Guid.NewGuid(), step, null, null)],
        }));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Assignments = [new DesignAssignmentDto("delete", Guid.NewGuid(), step, null, null), new DesignAssignmentDto("create", Guid.NewGuid(), step, null, null)],
        }));
    }

    [Fact]
    public void ASlotThatIsNotOneOfTheThreeOrNamesACopyTheBodyDoesNotCarryIsMalformed()
    {
        var copy = Guid.NewGuid();
        var schemas = new List<DesignSchemaDto> { new(copy, "s", "1.0.0", null, "{}") };
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Schemas = schemas, Processors = [new DesignProcessorDto(Guid.NewGuid(), null, new() { ["side"] = copy })],
        }));
        Assert.Throws<ValidationException>(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Processors = [new DesignProcessorDto(Guid.NewGuid(), null, new() { ["config"] = copy })],
        }));
        Assert.Null(Record.Exception(() => DesignShape.ThrowIfMalformed(Guid.NewGuid(), Empty() with
        {
            Schemas = schemas, Processors = [new DesignProcessorDto(Guid.NewGuid(), null, new() { ["config"] = copy })],
        })));
    }
}

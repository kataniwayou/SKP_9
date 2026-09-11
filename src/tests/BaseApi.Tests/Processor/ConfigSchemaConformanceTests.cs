using BaseProcessor.Core.Startup;
using Xunit;

namespace BaseApi.Tests.Processor;

/// <summary>
/// The check the config definition is fetched FOR: a registered row must describe the record a
/// payload is finally bound to. BaseApi validates a step's payload against that row at orchestration
/// start — nothing checked the row itself until now, so a row written against the wrong record
/// rejected payloads the processor would have accepted, with a 422 naming the assignment.
/// </summary>
public sealed class ConfigSchemaConformanceTests
{
    private const string ExpanderRow = """
        {"type":"object","required":[],
         "properties":{"maxDepth":{"type":"integer","minimum":1}},
         "additionalProperties":false}
        """;

    [Fact]
    public void TheRegisteredExpanderRowDescribesItsRecord()
    {
        // maxDepth is optional because ArchiveExpanderConfig gives it a default, and the row says so.
        Assert.Empty(ConfigSchemaConformance.Check(
            typeof(global::Processor.ArchiveExpander.ArchiveExpanderConfig), ExpanderRow));
    }

    [Fact]
    public void TheRegisteredPersisterRowDescribesItsRecord()
    {
        // folderPath is REQUIRED though FolderPath is declared string?. The nullability is a
        // deserialization concern — a malformed payload must be diagnosable rather than throw — so
        // the signal for optional is the DEFAULT, and this parameter has none.
        Assert.Empty(ConfigSchemaConformance.Check(
            typeof(global::Processor.FilePersister.FilePersisterConfig),
            """
            {"type":"object","required":["folderPath"],
             "properties":{"folderPath":{"type":"string","minLength":1}},
             "additionalProperties":false}
            """));
    }

    [Fact]
    public void TheRegisteredCollapserRowDescribesItsEmptyRecord()
    {
        // ArchiveCollapserConfig is a marker with no fields, so describing it means declaring none.
        Assert.Empty(ConfigSchemaConformance.Check(
            typeof(global::Processor.ArchiveCollapser.ArchiveCollapserConfig),
            """{"type":"object","required":[],"properties":{},"additionalProperties":false}"""));
    }

    [Fact]
    public void APropertyMissingFromTheRowIsAMismatch()
    {
        // THE HOLE THIS CLOSES. A schema cannot reject a key it does not describe, so a record
        // property absent from the row is a payload field nothing validates.
        var problems = ConfigSchemaConformance.Check(
            typeof(global::Processor.ArchiveExpander.ArchiveExpanderConfig),
            """{"type":"object","required":[],"properties":{},"additionalProperties":false}""");

        Assert.Contains(problems, x => x.Contains("maxDepth") && x.Contains("missing from the schema"));
    }

    [Fact]
    public void APascalCaseKeyIsAMismatchEvenThoughTheBinderWouldTakeIt()
    {
        // ProcessorConfig.SerializerOptions binds case-insensitively, so {"MaxDepth":4} reaches the
        // record — but a JSON Schema property name is case-sensitive, so that payload would NOT
        // validate. The check holds a row to camelCase rather than to what the binder tolerates.
        var problems = ConfigSchemaConformance.Check(
            typeof(global::Processor.ArchiveExpander.ArchiveExpanderConfig),
            """
            {"type":"object","required":[],
             "properties":{"MaxDepth":{"type":"integer"}},"additionalProperties":false}
            """);

        Assert.Contains(problems, x => x.Contains("'maxDepth'") && x.Contains("missing from the schema"));
        Assert.Contains(problems, x => x.Contains("'MaxDepth'") && x.Contains("not on"));
    }

    [Fact]
    public void ARequiredFlagThatContradictsTheDefaultIsAMismatch()
    {
        var problems = ConfigSchemaConformance.Check(
            typeof(global::Processor.ArchiveExpander.ArchiveExpanderConfig),
            """
            {"type":"object","required":["maxDepth"],
             "properties":{"maxDepth":{"type":"integer"}},"additionalProperties":false}
            """);

        Assert.Contains(problems, x => x.Contains("has a default") && x.Contains("requires it"));
    }

    [Fact]
    public void AWrongTypeFamilyIsAMismatch()
    {
        var problems = ConfigSchemaConformance.Check(
            typeof(global::Processor.ArchiveExpander.ArchiveExpanderConfig),
            """
            {"type":"object","required":[],
             "properties":{"maxDepth":{"type":"string"}},"additionalProperties":false}
            """);

        Assert.Contains(problems, x => x.Contains("binds as 'integer'"));
    }

    [Fact]
    public void ADefinitionThatIsNotJsonIsReportedRatherThanThrown()
    {
        // It must not throw out of the startup loop: a malformed row is a registration fault to be
        // reported, not an unhandled exception in a BackgroundService.
        var problems = ConfigSchemaConformance.Check(
            typeof(global::Processor.ArchiveExpander.ArchiveExpanderConfig), "{not json");

        Assert.Contains(problems, x => x.Contains("not JSON"));
    }
}

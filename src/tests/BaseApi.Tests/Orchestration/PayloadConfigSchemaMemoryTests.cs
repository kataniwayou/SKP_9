using System.Collections;
using System.Reflection;
using System.Text.Json;
using BaseApi.Service.Features.Assignment;
using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Validation;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Schema;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using BaseApi.Tests.Support;
using Json.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace BaseApi.Tests.Orchestration;

/// <summary>
/// The API-side half of the 2026-11-28 schema-registry leak. <c>PayloadConfigSchemaValidator</c>
/// parsed each config schema it read with <c>JsonSchema.FromText</c>, and every parse stayed in
/// <c>SchemaRegistry.Global</c> for the life of the process: one per schema per start or validation.
/// It now goes through <see cref="JsonSchemaConfig.Parse"/>, the mirror of the processor fix.
/// <para>
/// <b>In the serialised collection on purpose</b>, like <c>ProcessorJsonSchemaValidatorMemoryTests</c>:
/// <c>SchemaRegistry.Global</c> is process-wide, and a parallel class parsing schemas would move the
/// count.
/// </para>
/// </summary>
[Collection(EnvironmentCollection.Name)]
public sealed class PayloadConfigSchemaMemoryTests
{
    private static readonly DateTime T = new(2026, 11, 28, 12, 0, 0, DateTimeKind.Utc);

    private const string RequiresHandler = """{"type": "object", "required": ["handler"], "properties": {"handler": {"type": "string"}}}""";

    /// <summary>
    /// How many schemas the library's global registry holds. Private library state, read by
    /// reflection; an upgrade that renames the field fails here by name rather than letting the
    /// leak tests pass on a zero they never measured.
    /// </summary>
    private static int GlobalRegistrations()
    {
        var field = typeof(SchemaRegistry).GetField("_registered", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.True(field is not null,
            "SchemaRegistry._registered is gone (a JsonSchema.Net upgrade?): find what now holds the global registrations");
        return Assert.IsAssignableFrom<ICollection>(field!.GetValue(SchemaRegistry.Global)).Count;
    }

    /// <summary>
    /// A workflow whose one step's processor has <paramref name="definition"/> as its config schema,
    /// with a payload linked (conforming or not) so both the conformance and the missing-payload walks
    /// parse the schema.
    /// </summary>
    private static WorkflowGraphSnapshot Snapshot(string definition, string payload)
    {
        var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
        var (schema, processor, step, assignment, workflow) =
            (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        snapshot.Schemas[schema] = new SchemaReadDto(schema, "cfg", "1.0.0", null, definition, T, T, null, null);
        snapshot.Processors[processor] = new ProcessorReadDto(processor, "p", "1.0.0", null, "hash", null, null, null, schema, T, T, null, null);
        snapshot.Steps[step] = new StepReadDto(step, "s", "1.0.0", null, processor, [], StepEntryCondition.PreviousCompleted, T, T, null, null);
        snapshot.Assignments[assignment] = new AssignmentReadDto(assignment, "asg", "1.0.0", null, step, payload, T, T, null, null);
        snapshot.Workflows[workflow] = new WorkflowReadDto(workflow, "wf", "1.0.0", null, [step], [assignment], [], T, T, null, null);
        return snapshot;
    }

    [Fact]
    public void RepeatedValidationAddsNothingToTheGlobalRegistry()
    {
        var validator = new PayloadConfigSchemaValidator();
        var good = Snapshot(RequiresHandler, """{"handler": "Acme"}""");
        var bad = Snapshot(RequiresHandler, """{"handler": 7}""");
        validator.Collect(good);   // warm: the one parse of this definition happens here
        var before = GlobalRegistrations();

        for (var i = 0; i < 500; i++)
        {
            Assert.Empty(validator.Collect(good));
            Assert.Single(validator.Collect(bad));
        }

        // Before the fix: 2,000 (two parses a Collect, 1,000 Collects).
        Assert.Equal(before, GlobalRegistrations());
    }

    [Fact]
    public void AFirstParseDoesNotRegisterGloballyEither()
    {
        var before = GlobalRegistrations();

        for (var i = 0; i < 20; i++)
        {
            JsonSchemaConfig.Parse($$"""{"type":"object","required":["k{{i}}"]}""");
        }

        Assert.Equal(before, GlobalRegistrations());
    }

    [Fact]
    public void TheCacheIsBoundedAndStillRightPastTheBound()
    {
        using var empty = JsonDocument.Parse("{}");
        for (var i = 0; i < JsonSchemaConfig.MaxCachedDefinitions * 2; i++)
        {
            var schema = JsonSchemaConfig.Parse($$"""{"type":"object","required":["k{{i}}"]}""");
            Assert.False(schema.Evaluate(empty.RootElement, JsonSchemaConfig.DefaultOptions).IsValid);
            Assert.InRange(JsonSchemaConfig.CachedDefinitionCount, 1, JsonSchemaConfig.MaxCachedDefinitions);
        }
    }

    [Fact]
    public void TheSameDefinitionIsParsedOnce()
    {
        var definition = $$"""{"type":"object","required":["{{Guid.NewGuid():N}}"]}""";

        Assert.Same(JsonSchemaConfig.Parse(definition), JsonSchemaConfig.Parse(definition));
    }

    [Fact]
    public void AnInvalidDefinitionStillThrowsAndIsNotCached()
    {
        var cached = JsonSchemaConfig.CachedDefinitionCount;

        // Parse throws what FromText throws, uncached, so a retry parses again rather than serving a failure.
        Assert.ThrowsAny<Exception>(() => JsonSchemaConfig.Parse("[1,2]"));
        Assert.True(JsonSchemaConfig.CachedDefinitionCount <= cached);

        // Malformed JSON is the failure Collect reports as a problem (it catches JsonException; a row
        // that is JSON but not a schema cannot be saved, the meta-schema check refuses it).
        var problem = Assert.Single(new PayloadConfigSchemaValidator().Collect(Snapshot("{not json", """{"handler": "Acme"}""")));
        Assert.Equal("payloadConfigSchema", problem.Gate);
        var offending = Assert.IsType<PayloadConfigSchemaOffending>(problem.Offending);
        Assert.Contains(offending.errors, e => e.Contains("is not a valid JSON Schema", StringComparison.Ordinal));
    }

    [Fact]
    public void AnExternalReferenceIsStillRefused()
    {
        // The own registry carries the same no-op Fetch as the global one, so an external $ref cannot
        // be resolved and is reported as a problem rather than fetched.
        const string remote = """{"$ref":"https://example.invalid/schema.json"}""";

        var problems = new PayloadConfigSchemaValidator().Collect(Snapshot(remote, """{"handler": "Acme"}"""));

        Assert.NotEmpty(problems);
    }
}

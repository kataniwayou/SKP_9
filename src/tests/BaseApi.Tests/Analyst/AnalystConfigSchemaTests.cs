using System.Text;
using BaseProcessor.Core.Startup;
using BaseProcessor.Core.Validation;
using Processor.Analyst;
using Xunit;

namespace BaseApi.Tests.Analyst;

public sealed class AnalystConfigSchemaTests
{
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "analyst-config.json"));

    // F3: these must be real PanelRegistry ids -- "arrival-mean" was renamed to
    // "consumer-duration-mean" while the id was still free to rename (see PanelRegistryTests.
    // TheOldArrivalMeanIdIsGone), and this payload's entire purpose is being right before the
    // schema row is POSTed, which makes a fictitious panel id here worse than merely wrong.
    private const string Valid = """
        {"targetWorkflowId":"11111111-1111-1111-1111-111111111111","windowMinutes":360,
         "prompt":"Look for drift.","panelSet":["queue-wait","consumer-duration-mean"],
         "maxIterations":20,"maxTokens":120000,"wallClockSeconds":300}
        """;

    [Fact]
    public void TheSchemaDescribesTheConfigRecord()
    {
        // The same check ProcessorStartupOrchestrator runs at startup, run here so a mismatch fails
        // the build rather than leaving a replica published UNHEALTHY. camelCase is pinned: the
        // binder is case-insensitive but a JSON Schema property name is not.
        var problems = ConfigSchemaConformance.Check(typeof(AnalystConfig), Definition());

        Assert.Empty(problems);
    }

    [Fact]
    public void AWellFormedPayloadValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(Valid), out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void APayloadWithNoPromptIsRejected()
    {
        // The publish-time rejection that matters most: PayloadConfigSchemaValidator runs this in
        // BaseApi's OrchestrationService, so an operator who forgets the prompt is refused while
        // they are still at the screen rather than at 3am.
        const string noPrompt = """
            {"targetWorkflowId":"11111111-1111-1111-1111-111111111111","windowMinutes":360,
             "panelSet":["queue-wait"],"maxIterations":20,"maxTokens":120000,"wallClockSeconds":300}
            """;

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(noPrompt), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AnEmptyPromptIsRejected()
    {
        var empty = Valid.Replace("Look for drift.", "");

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(empty), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AnEmptyPanelSetIsRejected()
    {
        // An agent with no panels can neither find anything nor honestly report nothing: every
        // dispatch would end Failed at the validate stage. Refuse it at publish instead.
        var empty = Valid.Replace("""["queue-wait","consumer-duration-mean"]""", "[]");

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(empty), out _);

        Assert.False(ok);
    }

    [Fact]
    public void APascalCasePayloadIsRejected()
    {
        // ProcessorConfig.SerializerOptions binds case-insensitively, so a PascalCase payload would
        // reach the record - but a JSON Schema property name is case-sensitive, so it must not
        // validate. This pinning is what keeps the two halves from drifting.
        var pascal = Valid.Replace("\"prompt\"", "\"Prompt\"");

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(pascal), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AnUnknownPropertyIsRejected()
    {
        // additionalProperties:false. A payload carrying a property the record does not declare
        // binds silently to nothing (UnmappedMemberHandling is Skip), which is indistinguishable
        // from a field nobody set - so the schema is the only place that can catch a typo.
        var extra = Valid.Replace("\"windowMinutes\":360", "\"windowMinutes\":360,\"modelId\":\"x\"");

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(extra), out _);

        Assert.False(ok);
    }

    [Fact]
    public void AMalformedTargetWorkflowIdIsRejected()
    {
        // format:uuid is documentation only - ProcessorJsonSchemaValidator's EvaluationOptions do
        // not set RequireFormatValidation, so the library treats "format" as an annotation and lets
        // any string through. pattern is the keyword that actually enforces UUID shape here; without
        // it a malformed id would sail past the schema layer and fail later as an ungraceful Guid
        // deserialization error instead of the clean 422 this layer exists to give.
        var malformed = Valid.Replace(
            "\"targetWorkflowId\":\"11111111-1111-1111-1111-111111111111\"",
            "\"targetWorkflowId\":\"not-a-uuid-at-all\"");

        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(), Encoding.UTF8.GetBytes(malformed), out var errors);

        // Confirmed empirically (not just asserted) that this fails for the reason it claims: the
        // errors list names "pattern", not "format" or anything else - see task-3-report.md.
        Assert.False(ok);
        Assert.Contains(errors, e => e.Contains("pattern"));
    }
}

using System.Text;
using BaseProcessor.Core.Startup;
using BaseProcessor.Core.Validation;
using Processor.Napole;
using Xunit;

namespace BaseApi.Tests.Napole;

public sealed class NapoleConfigSchemaTests
{
    private static string Definition()
        => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Schemas", "napole-config.json"));

    private static bool Validates(string payload)
        => ProcessorJsonSchemaValidator.TryValidate(Definition(), Encoding.UTF8.GetBytes(payload), out _);

    [Fact]
    public void TheSchemaDescribesTheConfigRecord()
    {
        // The check ProcessorStartupOrchestrator runs at startup, here so a mismatch fails the build.
        Assert.Empty(ConfigSchemaConformance.Check(typeof(NapoleConfig), Definition()));
    }

    [Fact]
    public void AWellFormedPayloadValidates()
    {
        var ok = ProcessorJsonSchemaValidator.TryValidate(
            Definition(),
            Encoding.UTF8.GetBytes("""{"watchedWorkflowId":"8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02","windowMinutes":10}"""),
            out var errors);

        Assert.True(ok, string.Join("; ", errors));
    }

    [Fact]
    public void APayloadWithAnyOtherFieldIsRejected()
    {
        // The payload is the target and the time frame and nothing else (spec §5): the lag, the
        // trail and the dimensions are the pod's, and a payload naming one would silently do nothing.
        Assert.False(Validates(
            """{"watchedWorkflowId":"8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02","windowMinutes":10,"lagSeconds":60}"""));
    }

    [Fact]
    public void AWindowBelowOneIsRejected()
    {
        Assert.False(Validates("""{"watchedWorkflowId":"8cfdbcdb-a7e0-4a7d-9b4d-e4120ccacf02","windowMinutes":0}"""));
    }

    [Fact]
    public void APayloadWithNoWorkflowIsRejected()
    {
        Assert.False(Validates("""{"windowMinutes":10}"""));
    }

    [Fact]
    public void AWorkflowThatIsNoGuidIsRejected()
    {
        Assert.False(Validates("""{"watchedWorkflowId":"split-chain","windowMinutes":10}"""));
    }
}

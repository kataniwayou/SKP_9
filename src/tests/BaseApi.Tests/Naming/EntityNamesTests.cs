using System.Text;
using System.Text.Json;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class EntityNamesTests
{
    private static readonly Guid Id = Guid.Parse("208cba76-d635-4721-9aff-a7f22ee09224");

    [Fact]
    public void FormatsNameVersionAndTheLastTwoGuidGroups() =>
        Assert.Equal("analyst-monitor_1.0.0-9aff-a7f22ee09224", EntityNames.Format("analyst-monitor", "1.0.0", Id));

    [Fact]
    public void TheFallbackIsTheSuffixAlone() =>
        Assert.Equal("9aff-a7f22ee09224", EntityNames.Fallback(Id));

    [Fact]
    public void AFullNameEndsWithItsOwnFallbackSoOneWildcardMatchesBoth() =>
        Assert.EndsWith("-" + EntityNames.Fallback(Id), EntityNames.Format("x", "2.0.0", Id), StringComparison.Ordinal);

    [Fact]
    public void TheNameKeyIsItsOwnNamespace() =>
        Assert.Equal("skp:name:208cba76-d635-4721-9aff-a7f22ee09224", L2ProjectionKeys.Name(Id));

    [Fact]
    public void ReadsTheThreeIdsFromStringAndByteHeaders()
    {
        var w = Guid.NewGuid();
        var s = Guid.NewGuid();
        var headers = new Dictionary<string, object?>
        {
            [MessageIdHeaders.WorkflowId] = w.ToString("D"),
            [MessageIdHeaders.StepId] = Encoding.UTF8.GetBytes(s.ToString("D")),
        };

        var ids = MessageIdHeaders.ReadIds(headers);

        Assert.Equal(w, ids.WorkflowId);
        Assert.Equal(s, ids.StepId);
        Assert.Equal(Guid.Empty, ids.ProcessorId);
    }

    [Fact]
    public void ReadsNothingFromNoHeaders()
    {
        Assert.Equal((Guid.Empty, Guid.Empty, Guid.Empty), MessageIdHeaders.ReadIds(null));
        Assert.Equal((Guid.Empty, Guid.Empty, Guid.Empty),
            MessageIdHeaders.ReadIds(new Dictionary<string, object?> { [MessageIdHeaders.WorkflowId] = "not-a-guid" }));
    }

    [Fact]
    public void AWorkflowL1WithoutNamesStillDeserializes()
    {
        const string json = """
            {"WorkflowId":"208cba76-d635-4721-9aff-a7f22ee09224","EntryStepIds":[],"Cron":null,"Steps":[],"Caches":[]}
            """;

        var definition = JsonSerializer.Deserialize<WorkflowL1>(json, MessagingJson.Options);

        Assert.NotNull(definition);
        Assert.Null(definition.Names);
    }

    [Fact]
    public void NamesRoundTripKeyedById()
    {
        var definition = new WorkflowL1(Id, [], null, [], [], new Dictionary<Guid, string> { [Id] = "wf_1.0.0-9aff-a7f22ee09224" });

        var back = JsonSerializer.Deserialize<WorkflowL1>(
            JsonSerializer.Serialize(definition, MessagingJson.Options), MessagingJson.Options);

        Assert.Equal("wf_1.0.0-9aff-a7f22ee09224", back!.Names![Id]);
    }
}

using BaseProcessor.Core.Identity;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class ProcessorContextTests
{
    private static ProcessorIdentityFound Found(
        Guid? input = null, Guid? output = null, Guid? config = null) =>
        new(Guid.NewGuid(), input, output, config, "sample", "1.0.0");

    [Fact]
    public void StartsEmpty()
    {
        var context = new ProcessorContext();

        Assert.Null(context.Identity);
        Assert.False(context.IsHealthy);
    }

    [Fact]
    public void SetIdentityPublishesEveryFieldAsOneSnapshot()
    {
        var input = Guid.NewGuid();
        var found = Found(input: input);
        var context = new ProcessorContext();

        context.SetIdentity(found);

        // One read yields every field. There is no state in which Id is visible but Name is not,
        // which is the whole point of the snapshot.
        var identity = Assert.IsType<ProcessorIdentity>(context.Identity);
        Assert.Equal(found.Id, identity.Id);
        Assert.Equal(input, identity.InputSchemaId);
        Assert.Null(identity.OutputSchemaId);
        Assert.Null(identity.ConfigSchemaId);
        Assert.Equal("sample", identity.Name);
        Assert.Equal("1.0.0", identity.Version);
        Assert.Null(identity.InputDefinition);
    }

    [Fact]
    public void SetIdentityRejectsNull()
    {
        var context = new ProcessorContext();

        Assert.Throws<ArgumentNullException>(() => context.SetIdentity(null!));
    }

    [Fact]
    public void SetDefinitionRoutesBySchemaId()
    {
        var input = Guid.NewGuid();
        var config = Guid.NewGuid();
        var context = new ProcessorContext();
        context.SetIdentity(Found(input: input, config: config));

        context.SetDefinition(input, "{\"type\":\"object\"}");
        context.SetDefinition(config, "{\"type\":\"string\"}");

        var identity = context.Identity!;
        Assert.Equal("{\"type\":\"object\"}", identity.InputDefinition);
        Assert.Equal("{\"type\":\"string\"}", identity.ConfigDefinition);
        Assert.Null(identity.OutputDefinition);
    }

    [Fact]
    public void SetDefinitionFillsEverySlotSharingTheSchemaId()
    {
        // Independent ifs, not else-if: when two roles share one schema id, a single fetch populates
        // both slots rather than leaving the second null and stalling Gate A.
        var shared = Guid.NewGuid();
        var context = new ProcessorContext();
        context.SetIdentity(Found(input: shared, config: shared));

        context.SetDefinition(shared, "{}");

        var identity = context.Identity!;
        Assert.Equal("{}", identity.InputDefinition);
        Assert.Equal("{}", identity.ConfigDefinition);
    }

    [Fact]
    public void SetDefinitionForAnUnknownSchemaIdChangesNothing()
    {
        var input = Guid.NewGuid();
        var context = new ProcessorContext();
        context.SetIdentity(Found(input: input));

        context.SetDefinition(Guid.NewGuid(), "{}");

        Assert.Null(context.Identity!.InputDefinition);
    }

    [Fact]
    public void SetDefinitionBeforeIdentityThrows()
    {
        // Loop B only runs once Loop A has resolved. Swallowing an out-of-order call would leave
        // ConfigDefinition null, which Gate A reads as "no config schema, skip" — so the processor
        // would go healthy without ever validating its config.
        var context = new ProcessorContext();

        Assert.Throws<InvalidOperationException>(() => context.SetDefinition(Guid.NewGuid(), "{}"));
    }

    [Fact]
    public void AnAlreadyReadSnapshotIsNotMutatedByALaterDefinition()
    {
        // The snapshot is immutable and replaced wholesale, so a reader that captured it keeps a
        // consistent view rather than watching fields appear underneath it.
        var input = Guid.NewGuid();
        var context = new ProcessorContext();
        context.SetIdentity(Found(input: input));
        var captured = context.Identity!;

        context.SetDefinition(input, "{}");

        Assert.Null(captured.InputDefinition);
        Assert.Equal("{}", context.Identity!.InputDefinition);
    }

    [Fact]
    public void MarkHealthyIsIdempotent()
    {
        var context = new ProcessorContext();

        context.MarkHealthy();
        context.MarkHealthy();

        Assert.True(context.IsHealthy);
    }
}

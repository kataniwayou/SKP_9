using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Processor;

public sealed class DeterministicIdTests
{
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid E = Guid.Parse("55555555-5555-5555-5555-555555555555");

    [Fact]
    public void TheSameSeedAlwaysProducesTheSameId()
    {
        // This is the property the whole redelivery model rests on: a replayed dispatch writes to the
        // key it wrote the first time, so the second write is a rewrite rather than a second branch.
        var first  = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);
        var second = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);

        Assert.Equal(first, second);
    }

    [Fact]
    public void EachBranchInAFanOutGetsItsOwnId()
    {
        var branch0 = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);
        var branch1 = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 1);
        var branch2 = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 2);

        Assert.Equal(3, new[] { branch0, branch1, branch2 }.Distinct().Count());
    }

    [Fact]
    public void TheMessageIdAndTheExecutionIdDifferForOneBranch()
    {
        // Both derive from the same seed, so without the purpose discriminator a branch's execution id
        // would equal its message id — two different things silently sharing one value.
        var message   = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);
        var execution = DeterministicId.From(DeterministicId.ExecutionPurpose, C, S, E, 0);

        Assert.NotEqual(message, execution);
    }

    [Fact]
    public void DifferentHopsProduceDifferentIds()
    {
        var hopA = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);
        var hopB = DeterministicId.From(DeterministicId.MessagePurpose, C, S,
                                        Guid.Parse("66666666-6666-6666-6666-666666666666"), 0);

        Assert.NotEqual(hopA, hopB);
    }

    [Fact]
    public void TwoSourceStepsInOneWorkflowGetDistinctIds()
    {
        // A source step's EntryId is Guid.Empty, so the step id has to carry the uniqueness between
        // two different source steps firing under one correlation.
        var stepA = DeterministicId.From(DeterministicId.MessagePurpose, C, S, Guid.Empty, 0);
        var stepB = DeterministicId.From(DeterministicId.MessagePurpose, C,
                                         Guid.Parse("77777777-7777-7777-7777-777777777777"), Guid.Empty, 0);

        Assert.NotEqual(stepA, stepB);
    }

    [Fact]
    public void OneSourceStepGetsANewIdOnEveryFiring()
    {
        // The property the type's own doc comment rests on, and the one that actually matters in
        // production: a source step's StepId is fixed by the workflow definition and its EntryId is
        // always Guid.Empty, so the per-fire CorrelationId is the ONLY field distinguishing today's
        // firing from tomorrow's. If it ever stopped feeding the hash, every firing of a source step
        // would write the same key — and each run would silently overwrite the last.
        var firstFiring  = DeterministicId.From(DeterministicId.MessagePurpose, C, S, Guid.Empty, 0);
        var secondFiring = DeterministicId.From(
            DeterministicId.MessagePurpose,
            Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), S, Guid.Empty, 0);

        Assert.NotEqual(firstFiring, secondFiring);
    }

    [Fact]
    public void NeverProducesTheEmptyGuid()
    {
        // Guid.Empty is a sentinel everywhere in this system — a source step, a step with no output
        // key. A derived id colliding with it would be read as "not applicable".
        var id = DeterministicId.From(DeterministicId.MessagePurpose, Guid.Empty, Guid.Empty, Guid.Empty, 0);

        Assert.NotEqual(Guid.Empty, id);
    }

    [Fact]
    public void IsAWellFormedVersion5Uuid()
    {
        var id = DeterministicId.From(DeterministicId.MessagePurpose, C, S, E, 0);
        var bytes = id.ToByteArray();

        // .NET lays the first three fields out little-endian, so the version nibble lives in byte 7
        // and the variant bits in byte 8 of the in-memory array.
        Assert.Equal(0x50, bytes[7] & 0xF0);
        Assert.Equal(0x80, bytes[8] & 0xC0);
    }
}

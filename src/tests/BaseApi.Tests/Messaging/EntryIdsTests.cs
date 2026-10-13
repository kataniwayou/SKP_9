using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Xunit;

namespace BaseApi.Tests.Messaging;

public sealed class EntryIdsTests
{
    private static readonly Guid W = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid S = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid N = Guid.Parse("33333333-3333-3333-3333-333333333333");
    private static readonly Guid C = Guid.Parse("44444444-4444-4444-4444-444444444444");
    private static readonly Guid X = Guid.Parse("55555555-5555-5555-5555-555555555555");
    private static readonly Guid In = Guid.Parse("66666666-6666-6666-6666-666666666666");

    [Fact]
    public void ABranchWithAnInputKeyIsDerivedFromThatKeyAndTheExecution()
    {
        // §5.1 row 1: the input key is unique per run, which separates the two runs of a fan-in step,
        // a diamond and a loop — so the workflow and step ids add nothing and are not inputs.
        Assert.Equal(EntryIds.Branch(In, W, S, X), EntryIds.Branch(In, Guid.NewGuid(), Guid.NewGuid(), X));
        Assert.NotEqual(EntryIds.Branch(In, W, S, X), EntryIds.Branch(In, W, S, N));
    }

    [Fact]
    public void AnEntryBranchIsDerivedFromTheWorkflowTheStepAndTheExecution()
    {
        // §5.1 row 2: no input key, so the lineage is all there is.
        Assert.Equal(EntryIds.Branch(Guid.Empty, W, S, X), EntryIds.Branch(Guid.Empty, W, S, X));
        Assert.NotEqual(EntryIds.Branch(Guid.Empty, W, S, X), EntryIds.Branch(Guid.Empty, W, N, X));
    }

    [Fact]
    public void ASuccessorIsDerivedFromItsPredecessorsKeyAndItsOwnStep()
    {
        Assert.Equal(EntryIds.Successor(In, C, S, N), EntryIds.Successor(In, Guid.NewGuid(), Guid.NewGuid(), N));
        Assert.NotEqual(EntryIds.Successor(In, C, S, N), EntryIds.Successor(In, C, S, W));
    }

    [Fact]
    public void AnEntryStepsSuccessorIsDerivedFromTheRun()
    {
        // §5.2 row 2: an entry step's Failed or Cancelled outcome names Guid.Empty, and an entry step
        // is dispatched once per fire, so the correlation id makes the key unique.
        Assert.NotEqual(EntryIds.Successor(Guid.Empty, C, S, N), EntryIds.Successor(Guid.Empty, X, S, N));
    }

    [Fact]
    public void TheFormulasNeverMeet()
    {
        // A purpose tag separates them: Branch(a, b) and Successor(a, b) hash different names.
        Assert.NotEqual(EntryIds.Branch(In, W, S, X), EntryIds.Successor(In, C, S, X));
    }

    [Fact]
    public void TheHandoffSourceIsTheEntryIdWhenThereIsOne()
    {
        Assert.Equal(In, EntryIds.HandoffSource(In, C, S));
        Assert.NotEqual(Guid.Empty, EntryIds.HandoffSource(Guid.Empty, C, S));
        Assert.NotEqual(EntryIds.HandoffSource(Guid.Empty, C, S), EntryIds.HandoffSource(Guid.Empty, X, S));
    }

    [Fact]
    public void TheHandoffSetLivesBesideTheData()
        => Assert.Equal($"skp:handoff:{In:D}", L2ProjectionKeys.ExecutionHandoffs(In));
}

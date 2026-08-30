using BaseApi.Service.Features.Step;
using Xunit;

namespace BaseApi.Tests.Validation;

/// <summary>
/// That both step validators reject <see cref="StepEntryCondition.PreviousProcessing"/>, and accept
/// every other defined member.
/// <para>
/// <b>Nothing in the system reports a "still processing" result</b> — a step reaches exactly one of
/// completed, failed or cancelled — so a successor gated on 0 can never be entered.
/// <c>StepAdvancement</c> will simply never match it, which means the defect is silent: the workflow
/// runs, the branch never fires, and no record anywhere says why. Rejecting it at the write is the
/// only place the caller can still be told.
/// </para>
/// <para>
/// <b>The second reason is binding, and it is the one that makes this reachable by accident.</b>
/// The step DTOs are positional records with no <c>required</c> modifier, so a JSON body that omits
/// <c>entryCondition</c> binds it to the enum's C# default — which is <c>PreviousProcessing</c>, not
/// the <c>PreviousCompleted</c> that <c>StepEntity</c>'s field initializer suggests. The initializer
/// is overwritten by the mapper before it ever reaches the store. So the dead value was not merely
/// available to a caller who asked for it; it was what a caller got by saying nothing.
/// </para>
/// </summary>
public sealed class StepEntryConditionValidationTests
{
    private static StepCreateDto Create(StepEntryCondition condition) =>
        new("step", "1.0.0", null, Guid.NewGuid(), null, condition);

    private static StepUpdateDto Update(StepEntryCondition condition) =>
        new("step", "1.0.0", null, Guid.NewGuid(), null, condition);

    [Fact]
    public void CreateRejectsPreviousProcessing()
    {
        var result = new StepCreateDtoValidator()
            .Validate(Create(StepEntryCondition.PreviousProcessing));

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.PropertyName == nameof(StepCreateDto.EntryCondition));
    }

    [Fact]
    public void UpdateRejectsPreviousProcessing()
    {
        var result = new StepUpdateDtoValidator()
            .Validate(Update(StepEntryCondition.PreviousProcessing));

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.PropertyName == nameof(StepUpdateDto.EntryCondition));
    }

    /// <summary>
    /// The binding case, stated as the enum's default rather than as a literal 0 — this is what an
    /// omitted <c>entryCondition</c> produces, and pinning it here means a future change to the
    /// enum's zero value shows up as this test rather than as a silently dead step.
    /// </summary>
    [Fact]
    public void TheEnumDefaultIsTheRejectedValue()
    {
        Assert.Equal(StepEntryCondition.PreviousProcessing, default);

        Assert.False(new StepCreateDtoValidator().Validate(Create(default)).IsValid);
    }

    [Theory]
    [InlineData(StepEntryCondition.PreviousCompleted)]
    [InlineData(StepEntryCondition.PreviousFailed)]
    [InlineData(StepEntryCondition.PreviousCancelled)]
    [InlineData(StepEntryCondition.Always)]
    [InlineData(StepEntryCondition.Never)]
    public void EveryOtherDefinedMemberIsAccepted(StepEntryCondition condition)
    {
        // Never included deliberately. It is a legitimate stored value on both paths — a dead edge on
        // a successor, and the operator's freeze on an entry step — so a rule that swept up "values
        // that never enter" alongside PreviousProcessing would take the freeze with it.
        Assert.True(new StepCreateDtoValidator().Validate(Create(condition)).IsValid);
        Assert.True(new StepUpdateDtoValidator().Validate(Update(condition)).IsValid);
    }

    [Fact]
    public void AnUndefinedValueIsStillRejected()
    {
        var result = new StepCreateDtoValidator().Validate(Create((StepEntryCondition)99));

        Assert.False(result.IsValid);
        Assert.Contains(result.Errors, e => e.PropertyName == nameof(StepCreateDto.EntryCondition));
    }
}

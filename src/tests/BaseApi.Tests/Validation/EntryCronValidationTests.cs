using BaseApi.Service.Features.Workflow;
using Xunit;

namespace BaseApi.Tests.Validation;

/// <summary>
/// The per-entry-step cron map on the workflow DTOs: every value must parse as a 5- or 6-field cron,
/// and every key must name one of the workflow's own entry steps.
/// </summary>
public sealed class EntryCronValidationTests
{
    private static readonly Guid A = Guid.NewGuid();
    private static readonly Guid B = Guid.NewGuid();

    private static WorkflowCreateDto Create(Dictionary<Guid, string>? crons) =>
        new("wf", "1.0.0", null, [A, B], null, null, null, EntryCrons: crons);

    private static WorkflowUpdateDto Update(Dictionary<Guid, string>? crons) =>
        new("wf", "1.0.0", null, [A, B], null, null, null, EntryCrons: crons);

    [Fact]
    public void AnUnparseableEntryCronIsRefused()
    {
        var create = new WorkflowCreateDtoValidator().Validate(Create(new() { [B] = "every ten seconds" }));
        var update = new WorkflowUpdateDtoValidator().Validate(Update(new() { [B] = "every ten seconds" }));

        Assert.Contains(create.Errors, e => e.PropertyName.StartsWith(nameof(WorkflowCreateDto.EntryCrons)));
        Assert.Contains(update.Errors, e => e.PropertyName.StartsWith(nameof(WorkflowUpdateDto.EntryCrons)));
    }

    [Fact]
    public void AnEntryCronOnAStepThatIsNotAnEntryIsRefused()
    {
        var other = Guid.NewGuid();
        var create = new WorkflowCreateDtoValidator().Validate(Create(new() { [other] = "*/10 * * * * *" }));
        var update = new WorkflowUpdateDtoValidator().Validate(Update(new() { [other] = "*/10 * * * * *" }));

        var expected = $"EntryCrons names step {other:D}, which is not an entry step.";
        Assert.Contains(create.Errors, e => e.PropertyName.StartsWith(nameof(WorkflowCreateDto.EntryCrons)) && e.ErrorMessage == expected);
        Assert.Contains(update.Errors, e => e.PropertyName.StartsWith(nameof(WorkflowUpdateDto.EntryCrons)) && e.ErrorMessage == expected);
    }

    [Fact]
    public void AnEntryCronLongerThanTheColumnIsRefusedNamingTheStep()
    {
        // a valid six-field cron (a list of every second) of more than 120 characters
        var longCron = string.Join(",", Enumerable.Range(0, 60)) + " * * * * *";
        Assert.True(longCron.Length > 120);

        var expected = $"EntryCrons for step {B:D} must be at most 120 characters.";
        var create = new WorkflowCreateDtoValidator().Validate(Create(new() { [B] = longCron }));
        var update = new WorkflowUpdateDtoValidator().Validate(Update(new() { [B] = longCron }));

        Assert.Contains(create.Errors, e => e.PropertyName.StartsWith(nameof(WorkflowCreateDto.EntryCrons)) && e.ErrorMessage == expected);
        Assert.Contains(update.Errors, e => e.PropertyName.StartsWith(nameof(WorkflowUpdateDto.EntryCrons)) && e.ErrorMessage == expected);
    }

    [Fact]
    public void SixFieldAndFiveFieldEntryCronsAreAccepted()
    {
        var crons = new Dictionary<Guid, string> { [A] = "*/10 * * * * *", [B] = "*/5 * * * *" };

        Assert.True(new WorkflowCreateDtoValidator().Validate(Create(crons)).IsValid);
        Assert.True(new WorkflowUpdateDtoValidator().Validate(Update(crons)).IsValid);
        Assert.True(new WorkflowCreateDtoValidator().Validate(Create(null)).IsValid);
    }
}

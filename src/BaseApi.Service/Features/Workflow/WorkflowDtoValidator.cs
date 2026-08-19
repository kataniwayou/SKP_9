using BaseApi.Core.Validation;
using Cronos;
using FluentValidation;
using Messaging.Contracts.Projections;

namespace BaseApi.Service.Features.Workflow;

/// <summary>
/// Create-side validator. Including the shared base validator absorbs the name, version and
/// description rules. The workflow-specific rules are: the entry-step collection must be present,
/// non-empty, unique and free of empty ids; the assignment collection, when present, must be unique
/// and free of empty ids; and the cron expression, when present, must parse.
/// <para>
/// A well-formed but non-existent step id is not caught here — it surfaces as a foreign-key violation
/// from Postgres and becomes a 422.
/// </para>
/// </summary>
public sealed class WorkflowCreateDtoValidator : AbstractValidator<WorkflowCreateDto>
{
    public WorkflowCreateDtoValidator()
    {
        Include(new BaseDtoValidator<WorkflowCreateDto>());

        // Cascade.Stop is load-bearing, not tidiness. FluentValidation continues the chain by default,
        // so without it the three predicates below still run after NotNull has already failed — and
        // each dereferences the null, throwing out of the validator instead of reporting the failure
        // it exists to report. Over HTTP model binding rejects the null first; an in-process caller
        // has no such gate.
        RuleFor(x => x.EntryStepIds)
            .Cascade(CascadeMode.Stop)
            .NotNull()
            .Must(ids => ids.Count > 0)
            .WithMessage("EntryStepIds must contain at least one Step Id.")
            .Must(ids => ids.Distinct().Count() == ids.Count)
            .WithMessage("EntryStepIds must be unique.")
            .Must(ids => ids.All(id => id != Guid.Empty))
            .WithMessage("EntryStepIds must not contain Guid.Empty.");

        RuleFor(x => x.AssignmentIds)
            .Must(ids => ids is null || ids.Distinct().Count() == ids.Count)
            .WithMessage("AssignmentIds must be unique when present.")
            .Must(ids => ids is null || ids.All(id => id != Guid.Empty))
            .WithMessage("AssignmentIds must not contain Guid.Empty.");

        RuleFor(x => x.CronExpression)
            .Must(BeValidStandardCron)
            .When(x => !string.IsNullOrWhiteSpace(x.CronExpression))
            .WithMessage("CronExpression must be a valid 5- or 6-field cron expression (e.g., '0 0 * * *' or '*/30 * * * * *').");
    }

    /// <summary>
    /// Null or blank is valid, meaning the workflow is not scheduled. Otherwise the shared field-count
    /// detector rejects anything that is not five or six fields up front, without throwing, and then
    /// resolves the format for a single guarded parse. A genuinely malformed expression with the right
    /// field count is still rejected by that parse.
    /// </summary>
    private static bool BeValidStandardCron(string? expr)
    {
        if (string.IsNullOrWhiteSpace(expr)) return true;
        if (!CronFieldForm.IsValidFieldCount(expr)) return false;  // rejected without an exception
        var format = CronFieldForm.IsSecondsForm(expr) ? CronFormat.IncludeSeconds : CronFormat.Standard;
        try { CronExpression.Parse(expr, format); return true; }
        catch (CronFormatException) { return false; }
    }
}

/// <summary>
/// Update-side validator, mirroring the create-side rules.
/// </summary>
public sealed class WorkflowUpdateDtoValidator : AbstractValidator<WorkflowUpdateDto>
{
    public WorkflowUpdateDtoValidator()
    {
        Include(new BaseDtoValidator<WorkflowUpdateDto>());

        // Cascade.Stop is load-bearing, not tidiness. FluentValidation continues the chain by default,
        // so without it the three predicates below still run after NotNull has already failed — and
        // each dereferences the null, throwing out of the validator instead of reporting the failure
        // it exists to report. Over HTTP model binding rejects the null first; an in-process caller
        // has no such gate.
        RuleFor(x => x.EntryStepIds)
            .Cascade(CascadeMode.Stop)
            .NotNull()
            .Must(ids => ids.Count > 0)
            .WithMessage("EntryStepIds must contain at least one Step Id.")
            .Must(ids => ids.Distinct().Count() == ids.Count)
            .WithMessage("EntryStepIds must be unique.")
            .Must(ids => ids.All(id => id != Guid.Empty))
            .WithMessage("EntryStepIds must not contain Guid.Empty.");

        RuleFor(x => x.AssignmentIds)
            .Must(ids => ids is null || ids.Distinct().Count() == ids.Count)
            .WithMessage("AssignmentIds must be unique when present.")
            .Must(ids => ids is null || ids.All(id => id != Guid.Empty))
            .WithMessage("AssignmentIds must not contain Guid.Empty.");

        RuleFor(x => x.CronExpression)
            .Must(BeValidStandardCron)
            .When(x => !string.IsNullOrWhiteSpace(x.CronExpression))
            .WithMessage("CronExpression must be a valid 5- or 6-field cron expression (e.g., '0 0 * * *' or '*/30 * * * * *').");
    }

    /// <summary>
    /// Behaviourally identical to the create-side predicate: null or blank is valid, anything that is
    /// not five or six fields is rejected up front without throwing, and the remainder gets one
    /// guarded parse with the resolved format.
    /// </summary>
    private static bool BeValidStandardCron(string? expr)
    {
        if (string.IsNullOrWhiteSpace(expr)) return true;
        if (!CronFieldForm.IsValidFieldCount(expr)) return false;
        var format = CronFieldForm.IsSecondsForm(expr) ? CronFormat.IncludeSeconds : CronFormat.Standard;
        try { CronExpression.Parse(expr, format); return true; }
        catch (CronFormatException) { return false; }
    }
}

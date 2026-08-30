using BaseApi.Core.Validation;
using FluentValidation;

namespace BaseApi.Service.Features.Step;

/// <summary>
/// Create-side validator. Including the shared base validator absorbs the name, version and
/// description rules. The step-specific rules are: the processor id must not be empty; the next-step
/// collection must contain unique, non-empty ids; and the entry condition must be a defined enum
/// value.
/// <para>
/// A well-formed but non-existent processor id is not caught here — it surfaces as a foreign-key
/// violation from Postgres and becomes a 422.
/// </para>
/// </summary>
public sealed class StepCreateDtoValidator : AbstractValidator<StepCreateDto>
{
    public StepCreateDtoValidator()
    {
        Include(new BaseDtoValidator<StepCreateDto>());

        RuleFor(x => x.ProcessorId)
            .NotEqual(Guid.Empty)
            .WithMessage("ProcessorId must not be Guid.Empty.");

        RuleFor(x => x.NextStepIds)
            .Must(ids => ids is null || ids.Distinct().Count() == ids.Count)
            .WithMessage("NextStepIds must be unique.")
            .Must(ids => ids is null || ids.All(id => id != Guid.Empty))
            .WithMessage("NextStepIds must not contain Guid.Empty.");

        RuleFor(x => x.EntryCondition)
            .IsInEnum()
            .NotEqual(StepEntryCondition.PreviousProcessing)
            .WithMessage(
                "EntryCondition must not be PreviousProcessing: no step ever reports that result, " +
                "so a successor gated on it can never be entered. Send an explicit value — omitting " +
                "the field binds it to this one.");
    }
}

/// <summary>
/// Update-side validator, mirroring the create-side rules.
/// <para>
/// One rule cannot be enforced here: that no next-step id equals the step's own id. The validator has
/// no access to the route id, so the service layer is the place to add it if that rule is ever
/// tightened. Uniqueness and the non-empty check are enforced as above.
/// </para>
/// </summary>
public sealed class StepUpdateDtoValidator : AbstractValidator<StepUpdateDto>
{
    public StepUpdateDtoValidator()
    {
        Include(new BaseDtoValidator<StepUpdateDto>());

        RuleFor(x => x.ProcessorId)
            .NotEqual(Guid.Empty)
            .WithMessage("ProcessorId must not be Guid.Empty.");

        RuleFor(x => x.NextStepIds)
            .Must(ids => ids is null || ids.Distinct().Count() == ids.Count)
            .WithMessage("NextStepIds must be unique.")
            .Must(ids => ids is null || ids.All(id => id != Guid.Empty))
            .WithMessage("NextStepIds must not contain Guid.Empty.");

        RuleFor(x => x.EntryCondition)
            .IsInEnum()
            .NotEqual(StepEntryCondition.PreviousProcessing)
            .WithMessage(
                "EntryCondition must not be PreviousProcessing: no step ever reports that result, " +
                "so a successor gated on it can never be entered. Send an explicit value — omitting " +
                "the field binds it to this one.");
    }
}

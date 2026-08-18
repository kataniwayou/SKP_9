using System.Text.Json;
using BaseApi.Core.Validation;
using FluentValidation;

namespace BaseApi.Service.Features.Assignment;

/// <summary>
/// Create-side validator. Including the shared base validator absorbs the name, version and
/// description rules. The assignment-specific rules are: the step id must not be empty; and the
/// payload must be non-empty, within the size cap, and syntactically valid JSON.
/// <para>
/// A well-formed but non-existent step id is not caught here — it surfaces as a foreign-key violation
/// from Postgres and becomes a 422.
/// </para>
/// <para>
/// The payload is checked for syntax only. Validating it against a schema is not possible at this
/// layer, because the assignment carries no schema reference.
/// </para>
/// </summary>
public sealed class AssignmentCreateDtoValidator : AbstractValidator<AssignmentCreateDto>
{
    private const int MaxPayloadBytes = 1_048_576; // roughly 1 MB

    public AssignmentCreateDtoValidator()
    {
        Include(new BaseDtoValidator<AssignmentCreateDto>());

        RuleFor(x => x.StepId)
            .NotEqual(Guid.Empty)
            .WithMessage("StepId must not be Guid.Empty.");

        // The cascade stop is load-bearing, not cosmetic: FluentValidation continues through a rule
        // chain by default, so without it the parse below would still run on an oversized payload —
        // which is exactly the case the length cap exists to refuse.
        RuleFor(x => x.Payload)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .MaximumLength(MaxPayloadBytes)
            .WithMessage($"Payload must be at most {MaxPayloadBytes} characters.")
            .Custom((payload, ctx) =>
            {
                if (string.IsNullOrEmpty(payload)) return;
                try
                {
                    using var doc = JsonDocument.Parse(payload);
                }
                catch (JsonException ex)
                {
                    ctx.AddFailure(nameof(AssignmentCreateDto.Payload),
                        $"Payload is not valid JSON: {ex.Message}");
                }
            });
    }
}

/// <summary>
/// Update-side validator, mirroring the create-side rules.
/// </summary>
public sealed class AssignmentUpdateDtoValidator : AbstractValidator<AssignmentUpdateDto>
{
    private const int MaxPayloadBytes = 1_048_576; // roughly 1 MB

    public AssignmentUpdateDtoValidator()
    {
        Include(new BaseDtoValidator<AssignmentUpdateDto>());

        RuleFor(x => x.StepId)
            .NotEqual(Guid.Empty)
            .WithMessage("StepId must not be Guid.Empty.");

        // The cascade stop keeps the parse from running on an oversized payload — see the create-side
        // validator for the full reasoning.
        RuleFor(x => x.Payload)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .MaximumLength(MaxPayloadBytes)
            .WithMessage($"Payload must be at most {MaxPayloadBytes} characters.")
            .Custom((payload, ctx) =>
            {
                if (string.IsNullOrEmpty(payload)) return;
                try
                {
                    using var doc = JsonDocument.Parse(payload);
                }
                catch (JsonException ex)
                {
                    ctx.AddFailure(nameof(AssignmentUpdateDto.Payload),
                        $"Payload is not valid JSON: {ex.Message}");
                }
            });
    }
}

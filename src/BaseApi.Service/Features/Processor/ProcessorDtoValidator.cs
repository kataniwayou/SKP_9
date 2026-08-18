using BaseApi.Core.Validation;
using FluentValidation;

namespace BaseApi.Service.Features.Processor;

/// <summary>
/// Create-side validator. Including the shared base validator absorbs the name, version and
/// description rules. The processor-specific rules are: the source hash must be a lowercase SHA-256
/// hex string; and each of the three schema ids, which are nullable to support source, sink and
/// unconfigured processors, must not be empty when present.
/// <para>
/// Two things are deliberately left to the database. A duplicate source hash is caught by the unique
/// index and becomes a 409. A well-formed but non-existent schema id is caught by the foreign key and
/// becomes a 422, with the exception mapper recovering the offending column name from the constraint.
/// </para>
/// </summary>
public sealed class ProcessorCreateDtoValidator : AbstractValidator<ProcessorCreateDto>
{
    public ProcessorCreateDtoValidator()
    {
        Include(new BaseDtoValidator<ProcessorCreateDto>());

        RuleFor(x => x.SourceHash)
            .NotEmpty()
            .Matches(@"^[a-f0-9]{64}$")
            .WithMessage("SourceHash must be a lowercase SHA-256 hex string (64 chars, [a-f0-9]).");

        When(x => x.InputSchemaId.HasValue, () =>
        {
            RuleFor(x => x.InputSchemaId!.Value)
                .NotEqual(Guid.Empty)
                .WithMessage("InputSchemaId must not be Guid.Empty when provided.");
        });

        When(x => x.OutputSchemaId.HasValue, () =>
        {
            RuleFor(x => x.OutputSchemaId!.Value)
                .NotEqual(Guid.Empty)
                .WithMessage("OutputSchemaId must not be Guid.Empty when provided.");
        });

        When(x => x.ConfigSchemaId.HasValue, () =>
        {
            RuleFor(x => x.ConfigSchemaId!.Value)
                .NotEqual(Guid.Empty)
                .WithMessage("ConfigSchemaId must not be Guid.Empty when provided.");
        });
    }
}

/// <summary>
/// Update-side validator, mirroring the create-side rules. The source hash may change on update; the
/// unique index still applies.
/// </summary>
public sealed class ProcessorUpdateDtoValidator : AbstractValidator<ProcessorUpdateDto>
{
    public ProcessorUpdateDtoValidator()
    {
        Include(new BaseDtoValidator<ProcessorUpdateDto>());

        RuleFor(x => x.SourceHash)
            .NotEmpty()
            .Matches(@"^[a-f0-9]{64}$")
            .WithMessage("SourceHash must be a lowercase SHA-256 hex string (64 chars, [a-f0-9]).");

        When(x => x.InputSchemaId.HasValue, () =>
        {
            RuleFor(x => x.InputSchemaId!.Value)
                .NotEqual(Guid.Empty)
                .WithMessage("InputSchemaId must not be Guid.Empty when provided.");
        });

        When(x => x.OutputSchemaId.HasValue, () =>
        {
            RuleFor(x => x.OutputSchemaId!.Value)
                .NotEqual(Guid.Empty)
                .WithMessage("OutputSchemaId must not be Guid.Empty when provided.");
        });

        When(x => x.ConfigSchemaId.HasValue, () =>
        {
            RuleFor(x => x.ConfigSchemaId!.Value)
                .NotEqual(Guid.Empty)
                .WithMessage("ConfigSchemaId must not be Guid.Empty when provided.");
        });
    }
}

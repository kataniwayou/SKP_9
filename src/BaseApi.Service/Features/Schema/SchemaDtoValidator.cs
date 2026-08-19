using System.Text.Json;
using BaseApi.Core.Validation;
using FluentValidation;
using Json.Schema;

namespace BaseApi.Service.Features.Schema;

/// <summary>
/// Create-side validator. Including the shared base validator absorbs the name, version and
/// description rules. The definition is validated in two steps: parse it as JSON, then evaluate it
/// against the draft 2020-12 meta-schema to confirm the supplied document is itself a valid schema.
/// <para>
/// <b>The reference to <see cref="JsonSchemaConfig.DefaultOptions"/> below is load-bearing.</b> It is
/// what fires that type's static constructor, which pins the dialect and installs the no-op fetcher,
/// before any evaluation runs — so an external <c>$ref</c> cannot trigger an outbound request.
/// </para>
/// </summary>
public sealed class SchemaCreateDtoValidator : AbstractValidator<SchemaCreateDto>
{
    public SchemaCreateDtoValidator()
    {
        Include(new BaseDtoValidator<SchemaCreateDto>());

        // Cascade.Stop for the same reason as the workflow's entry-step rule: by default the Custom
        // step below runs even once NotEmpty has failed, and JsonDocument.Parse(null) raises
        // ArgumentNullException — not the JsonException the catch is written for — so a null escapes
        // as an unhandled throw rather than a validation failure.
        RuleFor(x => x.Definition)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .Custom((definition, ctx) =>
            {
                JsonDocument? doc = null;
                try
                {
                    doc = JsonDocument.Parse(definition);
                }
                catch (JsonException ex)
                {
                    ctx.AddFailure(nameof(SchemaCreateDto.Definition),
                        $"Definition is not valid JSON: {ex.Message}");
                    return;
                }
                try
                {
                    var results = MetaSchemas.Draft202012.Evaluate(
                        doc.RootElement,
                        JsonSchemaConfig.DefaultOptions);
                    if (!results.IsValid)
                    {
                        // A $ref pointing outside the registry lands here too: the no-op fetcher
                        // returns null, so the evaluation fails rather than making a request.
                        ctx.AddFailure(nameof(SchemaCreateDto.Definition),
                            "Definition is not a valid JSON Schema (draft 2020-12).");
                    }
                }
                finally
                {
                    doc?.Dispose();
                }
            });
    }
}

/// <summary>
/// Update-side validator, mirroring the create-side rules. The dialect pin and no-op fetcher are
/// applied by <see cref="JsonSchemaConfig"/>'s static constructor on first reference, so whichever
/// validator runs first, the lockdown is in place.
/// </summary>
public sealed class SchemaUpdateDtoValidator : AbstractValidator<SchemaUpdateDto>
{
    public SchemaUpdateDtoValidator()
    {
        Include(new BaseDtoValidator<SchemaUpdateDto>());

        // Cascade.Stop for the same reason as the workflow's entry-step rule: by default the Custom
        // step below runs even once NotEmpty has failed, and JsonDocument.Parse(null) raises
        // ArgumentNullException — not the JsonException the catch is written for — so a null escapes
        // as an unhandled throw rather than a validation failure.
        RuleFor(x => x.Definition)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .Custom((definition, ctx) =>
            {
                JsonDocument? doc = null;
                try
                {
                    doc = JsonDocument.Parse(definition);
                }
                catch (JsonException ex)
                {
                    ctx.AddFailure(nameof(SchemaUpdateDto.Definition),
                        $"Definition is not valid JSON: {ex.Message}");
                    return;
                }
                try
                {
                    var results = MetaSchemas.Draft202012.Evaluate(
                        doc.RootElement,
                        JsonSchemaConfig.DefaultOptions);
                    if (!results.IsValid)
                    {
                        ctx.AddFailure(nameof(SchemaUpdateDto.Definition),
                            "Definition is not a valid JSON Schema (draft 2020-12).");
                    }
                }
                finally
                {
                    doc?.Dispose();
                }
            });
    }
}

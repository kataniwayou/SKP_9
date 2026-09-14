using System.Text.Json;
using BaseApi.Core.Validation;
using FluentValidation;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// The shape rules both cache validators apply.
/// <para>
/// They are shared rather than duplicated — which is the local convention — because they are long
/// enough that a copy would drift, and create and update disagreeing about what a valid dictionary
/// is would mean a row that can be written but not edited.
/// </para>
/// </summary>
internal static class CacheRules
{
    // FluentValidation's MaximumLength counts characters, not bytes -- the name says what this
    // actually measures. The limit itself is unchanged: roughly 1 MB of characters, matching
    // AssignmentEntity.Payload.
    public const int MaxItemsChars = 1_048_576;

    public const int MaxRootLength = 200;

    /// <summary>
    /// Refuses a blank root, and one carrying a colon. See <c>CacheEntity</c> for why the colon
    /// matters: the address is a concatenation, so a colon on either side of it forges another
    /// dictionary's address.
    /// </summary>
    public static void CheckRoot<T>(string root, ValidationContext<T> ctx, string property)
    {
        if (string.IsNullOrWhiteSpace(root))
        {
            ctx.AddFailure(property, "Root must not be empty.");
            return;
        }

        if (root.Contains(':'))
        {
            ctx.AddFailure(property, "Root must not contain ':'.");
        }
    }

    /// <summary>
    /// Confirms the document parses, is an object, and holds only non-empty colon-free keys mapping
    /// to string values. It reports the first offending pair rather than all of them: the author is
    /// fixing a document by hand, and one precise name is more use than a list.
    /// </summary>
    public static void CheckItems<T>(string items, ValidationContext<T> ctx, string property)
    {
        if (string.IsNullOrEmpty(items))
        {
            return; // NotEmpty has already reported this; a second failure would just be noise.
        }

        JsonDocument document;

        try
        {
            document = JsonDocument.Parse(items);
        }
        catch (JsonException ex)
        {
            ctx.AddFailure(property, $"Items is not valid JSON: {ex.Message}");
            return;
        }

        using (document)
        {
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                ctx.AddFailure(property, "Items must be a JSON object.");
                return;
            }

            foreach (var pair in document.RootElement.EnumerateObject())
            {
                if (pair.Name.Length == 0)
                {
                    ctx.AddFailure(property, "Items must not contain an empty key.");
                    return;
                }

                if (pair.Name.Contains(':'))
                {
                    ctx.AddFailure(property, $"Items key '{pair.Name}' must not contain ':'.");
                    return;
                }

                if (pair.Value.ValueKind != JsonValueKind.String)
                {
                    ctx.AddFailure(property, $"Items value for key '{pair.Name}' must be a string.");
                    return;
                }
            }
        }
    }
}

/// <summary>Create-side rules. The cascade stops match <c>AssignmentDtoValidator</c>.</summary>
public sealed class CacheCreateDtoValidator : AbstractValidator<CacheCreateDto>
{
    public CacheCreateDtoValidator()
    {
        Include(new BaseDtoValidator<CacheCreateDto>());

        RuleFor(x => x.Root)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .MaximumLength(CacheRules.MaxRootLength)
            .WithMessage($"Root must be at most {CacheRules.MaxRootLength} characters.")
            .Custom((root, ctx) => CacheRules.CheckRoot(root, ctx, nameof(CacheCreateDto.Root)));

        // The cascade stop is load-bearing, not cosmetic: FluentValidation continues through a rule
        // chain by default, so without it the parse below would still run on an oversized document —
        // which is exactly the case the length cap exists to refuse.
        RuleFor(x => x.Items)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .MaximumLength(CacheRules.MaxItemsChars)
            .WithMessage($"Items must be at most {CacheRules.MaxItemsChars} characters.")
            .Custom((items, ctx) => CacheRules.CheckItems(items, ctx, nameof(CacheCreateDto.Items)));
    }
}

/// <summary>Update-side rules — identical, and sharing <see cref="CacheRules"/> so they stay so.</summary>
public sealed class CacheUpdateDtoValidator : AbstractValidator<CacheUpdateDto>
{
    public CacheUpdateDtoValidator()
    {
        Include(new BaseDtoValidator<CacheUpdateDto>());

        RuleFor(x => x.Root)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .MaximumLength(CacheRules.MaxRootLength)
            .WithMessage($"Root must be at most {CacheRules.MaxRootLength} characters.")
            .Custom((root, ctx) => CacheRules.CheckRoot(root, ctx, nameof(CacheUpdateDto.Root)));

        RuleFor(x => x.Items)
            .Cascade(CascadeMode.Stop)
            .NotEmpty()
            .MaximumLength(CacheRules.MaxItemsChars)
            .WithMessage($"Items must be at most {CacheRules.MaxItemsChars} characters.")
            .Custom((items, ctx) => CacheRules.CheckItems(items, ctx, nameof(CacheUpdateDto.Items)));
    }
}

using BaseApi.Core.Validation;
using FluentValidation;

namespace BaseApi.Service.Features.Cache;

/// <summary>
/// The shape rules every cache validator applies.
/// <para>
/// They are shared rather than duplicated — which is the local convention — because they are long
/// enough that a copy would drift, and create and update disagreeing about what a valid dictionary
/// is would mean a row that can be written but not edited.
/// </para>
/// </summary>
internal static class CacheRules
{
    /// <summary>A key's bound: it is the <c>cache_items</c> key column's length and part of an L2 address.</summary>
    public const int MaxKeyLength = 256;

    /// <summary>
    /// A value's bound, in characters. Since items became rows (2026-11-24) there is no bound on the
    /// dictionary as a whole; this is the 1 MB the whole document used to be allowed, now per value.
    /// </summary>
    public const int MaxValueChars = 1_048_576;

    public const int MaxRootLength = 200;

    /// <summary>The most keys an append or remove report names; past it the report says it is truncated.</summary>
    public const int ReportKeyCap = 1000;

    /// <summary>A page's size when the caller names none.</summary>
    public const int PageDefault = 500;

    /// <summary>The most items one page may carry.</summary>
    public const int PageMax = 5000;

    /// <summary>
    /// The most key + value characters one page carries: rows are added in key order until the next one
    /// would pass it, so a page of large values (up to 1,048,576 characters each) is cut short of
    /// <c>limit</c> and BaseApi never holds <c>limit</c> × 1 MiB at once. A first row that alone passes it is
    /// still returned, by itself.
    /// </summary>
    public const long PageCharBudget = 8_000_000;

    /// <summary>How many rows a refresh reads and writes per chunk.</summary>
    public const int RefreshChunk = 10_000;

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
    /// Confirms the items are a list of pairs with non-empty, colon-free, bounded keys, each once, and
    /// bounded string values. It reports the first offending pair rather than all of them: the author is
    /// fixing a dictionary by hand, and one precise name is more use than a list.
    /// </summary>
    public static void CheckItems<T>(
        IReadOnlyList<CacheItemDto>? items, ValidationContext<T> ctx, string property, bool refuseRepeats)
    {
        if (items is null)
        {
            ctx.AddFailure(property, "Items must be a list.");
            return;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var item in items)
        {
            if (item is null)
            {
                ctx.AddFailure(property, "Items must not contain a null item.");
                return;
            }

            var key = item.Key;

            if (string.IsNullOrEmpty(key))
            {
                ctx.AddFailure(property, "Items must not contain an empty key.");
                return;
            }

            if (key.Contains(':'))
            {
                ctx.AddFailure(property, $"Items key '{key}' must not contain ':'.");
                return;
            }

            if (key.Length > MaxKeyLength)
            {
                ctx.AddFailure(property, $"Items key '{key}' must be at most {MaxKeyLength} characters.");
                return;
            }

            if (item.Value is null)
            {
                ctx.AddFailure(property, $"Items value for key '{key}' must be a string.");
                return;
            }

            if (item.Value.Length > MaxValueChars)
            {
                ctx.AddFailure(property, $"Items value for key '{key}' must be at most {MaxValueChars} characters.");
                return;
            }

            if (!seen.Add(key) && refuseRepeats)
            {
                ctx.AddFailure(property, $"Items key '{key}' appears more than once.");
                return;
            }
        }
    }

    /// <summary>Confirms every key is non-empty, colon-free and at most <see cref="MaxKeyLength"/> characters. Repeats are allowed.</summary>
    public static void CheckKeys<T>(IReadOnlyList<string>? keys, ValidationContext<T> ctx, string property)
    {
        if (keys is null)
        {
            ctx.AddFailure(property, "Keys must be a list.");
            return;
        }

        foreach (var key in keys)
        {
            if (string.IsNullOrEmpty(key))
            {
                ctx.AddFailure(property, "Keys must not contain an empty key.");
                return;
            }

            if (key.Contains(':'))
            {
                ctx.AddFailure(property, $"Key '{key}' must not contain ':'.");
                return;
            }

            if (key.Length > MaxKeyLength)
            {
                ctx.AddFailure(property, $"Key '{key}' must be at most {MaxKeyLength} characters.");
                return;
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
    }
}

/// <summary>The items edit's own rules: exactly a stored row's items rules.</summary>
public sealed class CacheItemsUpdateDtoValidator : AbstractValidator<CacheItemsUpdateDto>
{
    public CacheItemsUpdateDtoValidator()
    {
        RuleFor(x => x.Items)
            .Custom((items, ctx) => CacheRules.CheckItems(items, ctx, nameof(CacheItemsUpdateDto.Items), refuseRepeats: true));
    }
}

/// <summary>An append's rules: the stored-row rules, but a key twice in the batch is allowed (the last wins) and the batch is non-empty.</summary>
public sealed class CacheItemsAppendDtoValidator : AbstractValidator<CacheItemsAppendDto>
{
    public CacheItemsAppendDtoValidator()
    {
        RuleFor(x => x.Items)
            .NotEmpty().WithMessage("Items must not be empty.")
            .Custom((items, ctx) => CacheRules.CheckItems(items, ctx, nameof(CacheItemsAppendDto.Items), refuseRepeats: false));
    }
}

/// <summary>A remove's rules: a non-empty list of well-formed keys.</summary>
public sealed class CacheItemsRemoveDtoValidator : AbstractValidator<CacheItemsRemoveDto>
{
    public CacheItemsRemoveDtoValidator()
    {
        RuleFor(x => x.Keys)
            .NotEmpty().WithMessage("Keys must not be empty.")
            .Custom((keys, ctx) => CacheRules.CheckKeys(keys, ctx, nameof(CacheItemsRemoveDto.Keys)));
    }
}

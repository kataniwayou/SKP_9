using FluentValidation;

namespace BaseApi.Core.Validation;

/// <summary>
/// Reusable validator providing the <see cref="IBaseDto"/> shared field rules: a non-empty
/// <c>Name</c> up to 200 characters, a non-empty strict-SemVer <c>Version</c>, and a
/// <c>Description</c> up to 2000 characters.
///
/// <para>
/// Concrete validators absorb these rules by calling
/// <c>Include(new BaseDtoValidator&lt;MyDto&gt;())</c> in their constructor, so this type is public
/// and deliberately not sealed.
/// </para>
///
/// <para>
/// The SemVer pattern is a strict numeric triple: no leading zeros and no pre-release tag. The
/// verbatim string literal is mandatory — <c>\d</c> in a regular literal raises CS1009 for an
/// unrecognized escape sequence, which this repo treats as an error.
/// </para>
/// </summary>
public class BaseDtoValidator<T> : AbstractValidator<T>
    where T : IBaseDto
{
    public BaseDtoValidator()
    {
        RuleFor(x => x.Name)
            .NotEmpty()
            .MaximumLength(200);

        RuleFor(x => x.Version)
            .NotEmpty()
            .Matches(@"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$");

        RuleFor(x => x.Description)
            .MaximumLength(2000);
    }
}

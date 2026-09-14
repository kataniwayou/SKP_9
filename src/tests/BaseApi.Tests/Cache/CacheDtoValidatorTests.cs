using BaseApi.Service.Features.Cache;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The cache's two fields carry rules that nothing downstream re-checks. The colon rule is the one
/// worth stating twice: the L2 address is built by concatenating root, ':' and key, so a colon
/// inside either half forges a different address — root "a" with key "b:c" and root "a:b" with key
/// "c" produce one string, and one dictionary then answers for the other.
/// </summary>
public sealed class CacheDtoValidatorTests
{
    private static CacheCreateDto Dto(string root, string items) =>
        new("cache-name", "1.0.0", null, root, items);

    private static bool IsValid(string root, string items) =>
        new CacheCreateDtoValidator().Validate(Dto(root, items)).IsValid;

    private static string FirstError(string root, string items) =>
        new CacheCreateDtoValidator().Validate(Dto(root, items)).Errors[0].ErrorMessage;

    [Fact]
    public void AFlatObjectOfStringsIsAccepted()
    {
        Assert.True(IsValid("sk-whitelist", """{"acme":"1","alphabeta":"1"}"""));
    }

    [Fact]
    public void AnEmptyObjectIsAccepted()
    {
        // "Allow nothing" is a legitimate configuration, and refusing it would refuse a valid intent.
        Assert.True(IsValid("sk-whitelist", "{}"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ABlankRootIsRejected(string root)
    {
        Assert.False(IsValid(root, "{}"));
    }

    [Fact]
    public void ARootCarryingAColonIsRejected()
    {
        Assert.Contains("':'", FirstError("sk:whitelist", "{}"));
    }

    [Fact]
    public void AKeyCarryingAColonIsRejected()
    {
        Assert.Contains("':'", FirstError("sk-whitelist", """{"a:b":"1"}"""));
    }

    [Fact]
    public void AnEmptyKeyIsRejected()
    {
        Assert.Contains("empty key", FirstError("sk-whitelist", """{"":"1"}"""));
    }

    [Fact]
    public void ANonStringValueIsRejected()
    {
        Assert.Contains("must be a string", FirstError("sk-whitelist", """{"acme":1}"""));
    }

    [Fact]
    public void AnArrayIsRejected()
    {
        Assert.Contains("must be a JSON object", FirstError("sk-whitelist", """["acme"]"""));
    }

    [Fact]
    public void ItemsThatAreNotJsonAreRejected()
    {
        Assert.Contains("not valid JSON", FirstError("sk-whitelist", "not json"));
    }

    [Fact]
    public void EmptyItemsAreRejected()
    {
        // Distinct from "{}": the column is required, so an absent document is not the same as an
        // empty dictionary.
        Assert.False(IsValid("sk-whitelist", ""));
    }

    [Fact]
    public void TheUpdateValidatorAppliesTheSameRules()
    {
        // Create and update must agree about what a valid dictionary is; they share CacheRules so
        // that they cannot drift.
        var result = new CacheUpdateDtoValidator()
            .Validate(new CacheUpdateDto("cache-name", "1.0.0", null, "sk:whitelist", "{}"));

        Assert.False(result.IsValid);
    }

    [Fact]
    public void TheEntityTrimsItsRootOnAssignment()
    {
        // The invariant lives on the data, following ProcessorEntity.InstanceId, so no write path
        // can route around it — a root arriving with a stray space from a manifest still compares
        // equal to one registered through the API.
        var entity = new CacheEntity { Root = "  sk-whitelist  " };

        Assert.Equal("sk-whitelist", entity.Root);
    }
}

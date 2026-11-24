using BaseApi.Service.Features.Cache;
using Xunit;

namespace BaseApi.Tests.Cache;

/// <summary>
/// The cache's two fields carry rules that nothing downstream re-checks. The colon rule is the one
/// worth stating twice: the L2 address is built by concatenating root, ':' and key, so a colon
/// inside either half forges a different address — root "a" with key "b:c" and root "a:b" with key
/// "c" produce one string, and one dictionary then answers for the other.
/// <para>
/// Items are a list of key/value pairs. A list can say a key twice where an object silently kept the
/// last one, so the duplicate is now refused by name. There is no cap on the dictionary as a whole —
/// each key and each value is bounded instead.
/// </para>
/// </summary>
public sealed class CacheDtoValidatorTests
{
    private static CacheItemDto I(string key, string value) => new(key, value);

    private static CacheCreateDto Dto(string root, List<CacheItemDto> items) =>
        new("cache-name", "1.0.0", null, root, items);

    private static bool IsValid(string root, List<CacheItemDto> items) =>
        new CacheCreateDtoValidator().Validate(Dto(root, items)).IsValid;

    private static string FirstError(string root, List<CacheItemDto> items) =>
        new CacheCreateDtoValidator().Validate(Dto(root, items)).Errors[0].ErrorMessage;

    [Fact]
    public void AListOfPairsIsAccepted()
    {
        Assert.True(IsValid("sk-whitelist", [I("acme", "1"), I("alphabeta", "1")]));
    }

    [Fact]
    public void AnEmptyListIsAccepted()
    {
        // "Allow nothing" is a legitimate configuration, and refusing it would refuse a valid intent.
        Assert.True(IsValid("sk-whitelist", []));
    }

    [Fact]
    public void NoListAtAllIsRejected()
    {
        // Distinct from []: an absent field is a malformed body, not an empty dictionary.
        Assert.Contains("Items must be a list", FirstError("sk-whitelist", null!));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ABlankRootIsRejected(string root)
    {
        Assert.False(IsValid(root, []));
    }

    [Fact]
    public void ARootCarryingAColonIsRejected()
    {
        Assert.Contains("':'", FirstError("sk:whitelist", []));
    }

    [Fact]
    public void AKeyCarryingAColonIsRejected()
    {
        Assert.Contains("':'", FirstError("sk-whitelist", [I("a:b", "1")]));
    }

    [Fact]
    public void AnEmptyKeyIsRejected()
    {
        Assert.Contains("empty key", FirstError("sk-whitelist", [I("", "1")]));
    }

    [Fact]
    public void ANullKeyIsRejectedAsEmpty()
    {
        Assert.Contains("empty key", FirstError("sk-whitelist", [I(null!, "1")]));
    }

    [Fact]
    public void ANullItemIsRejected()
    {
        Assert.Contains("must not contain a null item", FirstError("sk-whitelist", [null!]));
    }

    [Fact]
    public void ANullValueIsRejected()
    {
        Assert.Contains("value for key 'acme' must be a string", FirstError("sk-whitelist", [I("acme", null!)]));
    }

    [Fact]
    public void AnEmptyValueIsAccepted()
    {
        // An empty string is a string; whether "" means anything is the reader's business.
        Assert.True(IsValid("sk-whitelist", [I("acme", "")]));
    }

    [Fact]
    public void AKeyTwiceIsRejectedByName()
    {
        Assert.Contains("key 'acme' appears more than once", FirstError("sk-whitelist", [I("acme", "1"), I("beta", "2"), I("acme", "3")]));
    }

    [Fact]
    public void KeysDifferingOnlyInCaseAreDistinct()
    {
        // Ordinal, as the Redis address and the Postgres primary key compare them.
        Assert.True(IsValid("sk-whitelist", [I("Acme", "1"), I("acme", "2")]));
    }

    [Fact]
    public void AKeyAtTheLimitIsAcceptedAndOneOverIsRejected()
    {
        Assert.True(IsValid("sk-whitelist", [I(new string('k', CacheRules.MaxKeyLength), "1")]));
        Assert.Contains($"at most {CacheRules.MaxKeyLength} characters",
            FirstError("sk-whitelist", [I(new string('k', CacheRules.MaxKeyLength + 1), "1")]));
    }

    [Fact]
    public void AValueAtTheLimitIsAcceptedAndOneOverIsRejected()
    {
        Assert.True(IsValid("sk-whitelist", [I("acme", new string('v', CacheRules.MaxValueChars))]));
        Assert.Contains($"at most {CacheRules.MaxValueChars} characters",
            FirstError("sk-whitelist", [I("acme", new string('v', CacheRules.MaxValueChars + 1))]));
    }

    [Fact]
    public void ADictionaryLargerThanTheOldWholeDocumentCapIsAccepted()
    {
        // The reason for the child table: 2,000 entries of 1,000 characters is ~2M characters, twice
        // the 1,048,576 the single jsonb column used to allow.
        var items = Enumerable.Range(0, 2_000).Select(i => I($"k{i}", new string('v', 1_000))).ToList();

        Assert.True(IsValid("sk-whitelist", items));
    }

    [Fact]
    public void TheUpdateValidatorAppliesTheSameRules()
    {
        // Create and update must agree about what a valid dictionary is; they share CacheRules so
        // that they cannot drift.
        var validator = new CacheUpdateDtoValidator();

        Assert.False(validator.Validate(new CacheUpdateDto("cache-name", "1.0.0", null, "sk:whitelist", [])).IsValid);
        Assert.False(validator.Validate(new CacheUpdateDto("cache-name", "1.0.0", null, "sk", [I("a", "1"), I("a", "2")])).IsValid);
    }

    [Fact]
    public void TheItemsEditAppliesTheSameRules()
    {
        var validator = new CacheItemsUpdateDtoValidator();

        Assert.True(validator.Validate(new CacheItemsUpdateDto([I("acme", "1")])).IsValid);
        Assert.False(validator.Validate(new CacheItemsUpdateDto([I("a:b", "1")])).IsValid);
        Assert.False(validator.Validate(new CacheItemsUpdateDto([I("a", "1"), I("a", "2")])).IsValid);
        Assert.False(validator.Validate(new CacheItemsUpdateDto(null!)).IsValid);
    }

    [Fact]
    public void TheErrorIsReportedOnTheItemsField()
    {
        var error = new CacheCreateDtoValidator().Validate(Dto("sk-whitelist", [I("a:b", "1")])).Errors[0];

        Assert.Equal(nameof(CacheCreateDto.Items), error.PropertyName);
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

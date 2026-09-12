namespace Processor.SKNormalizer;

/// <summary>Admits everything. Replaced when the whitelist's backing store is designed.</summary>
public sealed class PassThroughFieldWhitelist : IFieldWhitelist
{
    public bool Allows(string field) => true;
}

namespace BaseProcessor.Core.Identity;

/// <summary>
/// IDENT-03 / D-13: the stubbable seam that supplies the processor's identity SourceHash. The
/// default implementation (<see cref="AssemblyMetadataSourceHashProvider"/>) reads it off the
/// assembly metadata embedded by the Phase 28 MSBuild target; tests register an NSubstitute stub
/// returning a known 64-hex hash so they need no real <c>[assembly: AssemblyMetadata]</c>.
/// </summary>
public interface ISourceHashProvider
{
    /// <summary>Returns the lowercase 64-hex SourceHash identifying this processor's implementation.</summary>
    string Get();
}

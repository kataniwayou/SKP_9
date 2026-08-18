using System.Reflection;

namespace BaseProcessor.Core.Identity;

/// <summary>
/// Default <see cref="ISourceHashProvider"/> (IDENT-03): reads the
/// <c>[assembly: AssemblyMetadata("SourceHash", "&lt;64-hex&gt;")]</c> attribute (emitted by the
/// Phase 28 MSBuild embed target onto the entry assembly) via reflection.
///
/// <para>
/// Fail-fast (RESEARCH Open Q2 / T-26-02 DoS mitigation): when the attribute is ABSENT it throws
/// <see cref="InvalidOperationException"/> rather than returning null/empty. A processor with no
/// SourceHash can never resolve its identity, so a null/empty hash would otherwise drive an
/// unbounded silent not-found retry on an empty hash. The message names the KEY only, never any
/// value (V7 / information-disclosure mitigation).
/// </para>
/// </summary>
public sealed class AssemblyMetadataSourceHashProvider : ISourceHashProvider
{
    /// <inheritdoc/>
    public string Get()
    {
        // The hash describes the IMPLEMENTATION assembly (the concrete + BaseProcessor.Core). The
        // embed target (Phase 28) emits it onto the entry assembly; fall back to the executing
        // assembly so the provider remains testable outside a hosted entry-point context.
        var asm = Assembly.GetEntryAssembly() ?? Assembly.GetExecutingAssembly();
        var value = asm.GetCustomAttributes<AssemblyMetadataAttribute>()
                       .FirstOrDefault(a => a.Key == "SourceHash")?.Value;

        return value ?? throw new InvalidOperationException(
            "Assembly metadata 'SourceHash' is missing. The MSBuild embed target (IDENT-01/02, Phase 28) " +
            "must emit [assembly: AssemblyMetadata(\"SourceHash\", \"<64-hex>\")].");
    }
}

namespace BaseProcessor.Core.Identity;

/// <summary>
/// The immutable snapshot of everything the two startup loops resolve, published as one unit through
/// <see cref="IProcessorContext.Identity"/>.
/// <para>
/// <c>Id</c>, <c>Name</c> and <c>Version</c> are non-nullable by construction: they all arrive
/// together in the identity response, so a reader holding a snapshot can use them without guarding
/// each one. That is the property the previous nine-auto-property shape could not offer — there,
/// a visible <c>Id</c> did not imply a visible <c>Name</c>, and every call site had to know it.
/// </para>
/// <para>
/// The three definitions stay nullable: a null schema id means that role does not apply (a source
/// processor has no input schema), and a non-null id whose definition is still null means Loop B has
/// not resolved it yet. The pair distinguishes "not applicable" from "not yet".
/// </para>
/// </summary>
public sealed record ProcessorIdentity(
    Guid Id,
    Guid? InputSchemaId,
    Guid? OutputSchemaId,
    Guid? ConfigSchemaId,
    string Name,
    string Version,
    string? InputDefinition,
    string? OutputDefinition,
    string? ConfigDefinition);

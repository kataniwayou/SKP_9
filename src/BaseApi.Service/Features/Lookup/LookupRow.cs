namespace BaseApi.Service.Features.Lookup;

/// <summary>One entity in the id → name table: the identity, and the decoration.</summary>
public sealed record LookupRow(Guid Id, string Name, string Version, string Kind);

using BaseApi.Service.Features.Orchestration.Projection;

namespace BaseApi.Tests.Support;

/// <summary>
/// A step-row lookup over a set the test controls, recording every id it was asked about.
/// <para>
/// <see cref="Everything"/> answers "every step still exists" — the database as it is for any test
/// that is not about a deleted step, so a writer built with it never deletes a step key.
/// </para>
/// </summary>
internal sealed class FakeStepRows : IStepRowLookup
{
    private readonly HashSet<Guid>? _existing;

    private FakeStepRows(HashSet<Guid>? existing) => _existing = existing;

    /// <summary>Every step asked about exists.</summary>
    public static FakeStepRows Everything() => new(null);

    /// <summary>Only <paramref name="ids"/> exist; every other step has been deleted.</summary>
    public static FakeStepRows Only(params Guid[] ids) => new([.. ids]);

    /// <summary>Every id asked about, across all calls, in order.</summary>
    public List<Guid> Asked { get; } = [];

    public Task<IReadOnlySet<Guid>> ExistingAsync(IReadOnlyCollection<Guid> stepIds, CancellationToken ct)
    {
        Asked.AddRange(stepIds);
        IReadOnlySet<Guid> found = stepIds.Where(id => _existing is null || _existing.Contains(id)).ToHashSet();
        return Task.FromResult(found);
    }
}

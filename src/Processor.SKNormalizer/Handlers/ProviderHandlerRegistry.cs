namespace Processor.SKNormalizer;

/// <summary>
/// Name to handler, built once at startup from every <see cref="IProviderHandler"/> the container
/// carries.
/// <para>
/// <b>Case-insensitive</b>, because the name arrives on a hand-written step payload and a case
/// mismatch is not a distinction worth failing a workflow over.
/// </para>
/// <para>
/// <b>The set of names here must equal the <c>enum</c> in
/// <c>src/tests/BaseApi.Tests/Schemas/sknormalizer-config.json</c></b>, which is what refuses a
/// workflow naming an absent handler at PUBLISH time. Nothing checks that at runtime —
/// <c>ConfigSchemaConformance</c> does not read enum values and the framework exposes no hook — so
/// <c>SKNormalizerConfigSchemaTests</c> is what keeps them in step.
/// </para>
/// </summary>
internal sealed class ProviderHandlerRegistry
{
    private readonly Dictionary<string, IProviderHandler> _handlers;

    public ProviderHandlerRegistry(IEnumerable<IProviderHandler> handlers)
    {
        ArgumentNullException.ThrowIfNull(handlers);

        _handlers = new Dictionary<string, IProviderHandler>(StringComparer.OrdinalIgnoreCase);

        foreach (var handler in handlers)
        {
            // THROWS RATHER THAN LAST-ONE-WINS. Two handlers claiming one name is a build-time
            // mistake, and resolving it by registration order would serve one of two providers at
            // random for as long as nobody noticed. The container builds this at startup, so the pod
            // fails to start instead.
            if (!_handlers.TryAdd(handler.Name, handler))
            {
                throw new InvalidOperationException(
                    $"two provider handlers claim the name '{handler.Name}'");
            }
        }

        Names = _handlers.Values.Select(h => h.Name).Order(StringComparer.Ordinal).ToList();
    }

    /// <summary>Ordered, so the unknown-handler rejection message is stable between failures.</summary>
    public IReadOnlyList<string> Names { get; }

    /// <summary>
    /// Null for an unknown name rather than throwing: turning that into a rejected payload with a
    /// message naming what IS carried belongs to the processor, not here.
    /// </summary>
    public IProviderHandler? Find(string name)
        => _handlers.TryGetValue(name, out var handler) ? handler : null;
}

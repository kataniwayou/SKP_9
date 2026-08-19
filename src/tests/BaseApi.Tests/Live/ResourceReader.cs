using System.Reflection;
using OpenTelemetry.Resources;

namespace BaseApi.Tests.Live;

/// <summary>
/// Reads the <see cref="Resource"/> a provider froze at build time.
/// <para>
/// Reflection because the SDK exposes no public accessor, and asserting on the frozen resource is the
/// only way to prove the two-stage boot did what it exists to do. Asserting on what was *passed* to
/// the wiring would pass just as happily if the SDK ignored it.
/// </para>
/// <para>
/// The property is declared on a base type, so the walk is up the hierarchy with
/// <c>DeclaredOnly</c> rather than a single lookup — verified against OpenTelemetry 1.15.3.
/// </para>
/// </summary>
public static class ResourceReader
{
    public static IReadOnlyDictionary<string, object> Read(object provider)
    {
        ArgumentNullException.ThrowIfNull(provider);

        for (var t = provider.GetType(); t is not null; t = t.BaseType)
        {
            var property = t.GetProperty("Resource",
                BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public |
                BindingFlags.DeclaredOnly);

            if (property?.GetValue(provider) is Resource resource)
            {
                return resource.Attributes.ToDictionary(a => a.Key, a => a.Value);
            }
        }

        throw new InvalidOperationException(
            $"no Resource property found on {provider.GetType().FullName} or its base types");
    }
}

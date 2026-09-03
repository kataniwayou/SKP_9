using System.Collections;
using System.Globalization;
using System.Text.RegularExpressions;

namespace BaseConsole.Core.Startup;

/// <summary>
/// Renders the environment variables this process was configured with, as the block a preflight
/// prints before it checks anything — so "what did the operator actually set" is answerable from the
/// log alone, without exec-ing into a pod that may no longer exist.
/// <para>
/// <b>Shared in shape — not in code — with the other core's copy.</b> Both must render identically;
/// the test that feeds the same environment to each and compares the output is what keeps them from
/// drifting. Duplicated rather than shared because the only projects both cores reference are
/// <c>Messaging.Contracts</c> and <c>Messaging.Transport</c>, and neither is a home for startup
/// diagnostics. <c>HealthProbeLog</c> and the two endpoint redactors are already duplicated on the
/// same reasoning.
/// </para>
/// <para>
/// <b>Values are shown, not hidden, and that is the point.</b> An operator reading this needs to see
/// that <c>Service__Name</c> really is what they think it is, that a typo'd key is present under the
/// wrong spelling, that the database name is the one they meant. A block of masked values would
/// answer none of that. Only credentials are withheld.
/// </para>
/// </summary>
public static class EnvironmentSnapshot
{
    /// <summary>
    /// Keys whose value is replaced with <see cref="Mask"/> regardless of anything else.
    /// <para>
    /// <b>Deliberately not the bare word "key".</b> It would mask <c>Logging__LogLevel__...</c>-shaped
    /// settings and anything else that merely contains it, turning a diagnostic block into a wall of
    /// asterisks. The listed words are the ones that name a credential and nothing else.
    /// </para>
    /// <para>
    /// This is what makes a variable added in future safe by default: a new <c>Foo__ApiKey</c> or
    /// <c>Stripe__Secret</c> masks itself without anyone remembering to come back here.
    /// </para>
    /// </summary>
    private static readonly Regex SecretKey = new(
        "password|passwd|pwd|secret|token|credential|apikey",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// The credential field INSIDE a connection string, which Kubernetes expands in place — so the
    /// password appears twice in a pod's environment, once under its own key and once inline here.
    /// Masking only the first is the easy mistake, and it leaks the same secret.
    /// <para>
    /// Terminated on both <c>;</c> and <c>,</c> so one pattern covers the Npgsql form
    /// (<c>Host=...;Password=...</c>) and the StackExchange.Redis form (<c>host:port,password=...</c>).
    /// </para>
    /// </summary>
    private static readonly Regex InlineSecret = new(
        @"\b(password|pwd)\s*=\s*[^;,]*",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    internal const string Mask = "***";

    /// <summary>Runtime and shell variables nobody deploying this service chose.</summary>
    private static readonly HashSet<string> NoiseKeys = new(StringComparer.Ordinal)
    {
        "PATH", "HOSTNAME", "HOME", "PWD", "OLDPWD", "SHLVL", "TERM", "USER", "LANG", "LC_ALL",
        "TZ", "container", "DEBIAN_FRONTEND", "ASPNET_VERSION", "DOTNET_VERSION",
    };

    /// <summary>
    /// Everything a container gets for free rather than because an operator asked for it.
    /// <para>
    /// <b>A denylist, deliberately, and this was got wrong first.</b> The obvious rule is to select
    /// keys containing <c>__</c> — .NET's configuration separator — but a manifest is full of settings
    /// that carry no separator and matter enormously: <c>POSTGRES_DB</c>, <c>POSTGRES_USER</c> and
    /// <c>POSTGRES_PASSWORD</c> are all read by this system and all invisible to that rule. An
    /// allowlist answers "what did the author remember", when the question this block exists for is
    /// "what did the operator actually set", and those differ precisely where a deployment has gone
    /// wrong.
    /// </para>
    /// <para>
    /// So the default is to SHOW, and only what Kubernetes and the base image inject is withheld:
    /// the service-link variables it generates per service in the namespace (seventy-odd lines on a
    /// namespace this size), the runtime's own version stamps, and the shell's. Anything unrecognised
    /// is shown — noisy at worst, where the opposite bias loses the one line that mattered.
    /// </para>
    /// </summary>
    private static bool IsContainerNoise(string key)
        => NoiseKeys.Contains(key)
        || key.StartsWith("KUBERNETES_", StringComparison.Ordinal)
        || key.StartsWith("DOTNET_", StringComparison.Ordinal)
        || key.StartsWith("NUGET_", StringComparison.Ordinal)
        // Kubernetes service links: FOO_SERVICE_HOST, FOO_SERVICE_PORT, FOO_PORT,
        // FOO_PORT_5432_TCP_ADDR and friends, injected for every service in the namespace.
        || key.Contains("_SERVICE_HOST", StringComparison.Ordinal)
        || key.Contains("_SERVICE_PORT", StringComparison.Ordinal)
        || key.Contains("_PORT_", StringComparison.Ordinal)
        || key.EndsWith("_PORT", StringComparison.Ordinal);

    /// <summary>The value as it is safe to log: masked wholesale, masked inline, or as-is.</summary>
    internal static string Redact(string key, string value)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(value);

        if (SecretKey.IsMatch(key))
        {
            return Mask;
        }

        // Applied to every surviving value rather than only to keys named ConnectionStrings__*: a
        // credential embedded in a URL or a DSN under some other key is the same leak, and a rule
        // that only trusted the key name would miss it.
        return InlineSecret.Replace(value, m => m.Groups[1].Value + "=" + Mask);
    }

    /// <summary>
    /// The block, one line per variable, name-sorted and column-aligned. Sorted because the process
    /// environment has no meaningful order and an unsorted block would render differently on two pods
    /// running the same manifest, which makes two logs impossible to diff.
    /// </summary>
    internal static IReadOnlyList<string> Lines(IDictionary environment)
    {
        ArgumentNullException.ThrowIfNull(environment);

        var settings = new List<KeyValuePair<string, string>>();

        foreach (DictionaryEntry entry in environment)
        {
            var key = Convert.ToString(entry.Key, CultureInfo.InvariantCulture);

            if (string.IsNullOrEmpty(key) || IsContainerNoise(key))
            {
                continue;
            }

            var value = Convert.ToString(entry.Value, CultureInfo.InvariantCulture) ?? string.Empty;
            settings.Add(new KeyValuePair<string, string>(key, Redact(key, value)));
        }

        settings.Sort(static (a, b) => string.CompareOrdinal(a.Key, b.Key));

        // Width from the widest NAME in this block, so the values line up in a column. Computed
        // rather than fixed: the widest key differs per service, and a fixed width would either
        // truncate or leave a ragged gap.
        var width = settings.Count == 0 ? 0 : settings.Max(s => s.Key.Length);

        return settings.Select(s => "  " + s.Key.PadRight(width) + " = " + s.Value).ToList();
    }

    /// <summary>This process's environment, rendered.</summary>
    /// <summary>
    /// The live environment, masked and ordered, ready to log.
    /// <para>
    /// <b>Public, and the only public member here, because the processor's stage 1 is in another
    /// assembly.</b> That host resolves its identity before it has a host to run
    /// <see cref="StartupPreflightService"/> in, so it logs this block itself -- and the alternative,
    /// a second copy of the masking above living in BaseProcessor.Core, is how a password reaches a
    /// log the day the two copies drift. One implementation, two callers.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> Lines()
        => Lines(Environment.GetEnvironmentVariables());
}

using Microsoft.Extensions.Configuration;

namespace BaseApi.Core.Configuration;

/// <summary>
/// Boundary-level configuration accessors that fail fast with an actionable message when a required
/// key is missing. They replace the null-forgiving <c>cfg["X"]!</c> and the bare
/// <c>cfg.GetConnectionString(...)</c>, both of which surface a missing setting as a
/// NullReferenceException whose stack trace points at the consuming SDK rather than at the
/// misconfiguration.
///
/// <para>
/// The Swagger document title keeps its own <c>?? "sk-api"</c> fallback on purpose — it is
/// operationally non-critical — and is deliberately not migrated to this helper.
/// </para>
/// </summary>
internal static class RequiredConfig
{
    public static string Require(this IConfiguration cfg, string key)
        => cfg[key] ?? throw new InvalidOperationException(
            $"Required configuration key '{key}' is missing. Set it via appsettings.json, " +
            $"environment variables, or user secrets. See README.md.");

    public static string RequireConnectionString(this IConfiguration cfg, string name)
        => cfg.GetConnectionString(name) ?? throw new InvalidOperationException(
            $"Required connection string 'ConnectionStrings:{name}' is missing. " +
            $"Set it via appsettings.json, environment variables, or user secrets. See README.md.");
}

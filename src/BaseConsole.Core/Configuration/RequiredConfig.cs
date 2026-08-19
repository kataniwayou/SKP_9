using Microsoft.Extensions.Configuration;

namespace BaseConsole.Core.Configuration;

/// <summary>
/// Boundary-level configuration accessors that fail fast with an actionable message when a required
/// key is missing. They replace the null-forgiving <c>cfg["X"]!</c> and the bare
/// <c>cfg.GetConnectionString(...)</c>, both of which surface a missing setting as a
/// NullReferenceException whose stack trace points at the consuming SDK rather than at the
/// misconfiguration.
/// <para>
/// Duplicated from the API base library rather than shared: that assembly is an ASP.NET and
/// EF-coupled dependency a worker has no business taking, and this is twenty lines.
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

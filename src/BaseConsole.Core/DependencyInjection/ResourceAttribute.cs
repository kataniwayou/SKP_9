namespace BaseConsole.Core.DependencyInjection;

/// <summary>
/// One resource attribute, carried under both signals' key conventions at once.
/// <para>
/// A single key would not do. Logs use PascalCase and metrics camelCase throughout this codebase, so
/// a caller passing one key would silently break whichever convention it did not match — and the
/// break would only surface in a query nobody runs until an incident.
/// </para>
/// </summary>
/// <param name="LogKey">The PascalCase key stamped on the logs resource.</param>
/// <param name="MetricKey">The camelCase key stamped on the metrics resource.</param>
/// <param name="Value">The value, identical under both keys.</param>
public sealed record ResourceAttribute(string LogKey, string MetricKey, object Value);

namespace Messaging.Contracts;

/// <summary>
/// The one place the entity-name rule exists. A name is <c>{name}_{version}-{suffix}</c>, where the
/// suffix is the id's last two groups: 64 bits, so a name is unique on its own and no
/// (name, version) constraint is needed. An unresolved entity logs the suffix alone. It carries no
/// <c>_</c> and no version, so it is easy to filter, and <c>*{suffix}</c> matches both forms of the
/// same entity. The fallback is derived from the same method as the full name, so the two cannot drift.
/// </summary>
public static class EntityNames
{
    public const string WorkflowName  = "WorkflowName";
    public const string StepName      = "StepName";
    public const string ProcessorName = "ProcessorName";

    /// <summary>The reap line's attribute: one record names several workflows.</summary>
    public const string WorkflowNames = "WorkflowNames";

    public static string Format(string name, string version, Guid id) => $"{name}_{version}-{Suffix(id)}";

    public static string Fallback(Guid id) => Suffix(id);

    // "D" is 8-4-4-4-12; index 19 starts the fourth group.
    private static string Suffix(Guid id) => id.ToString("D")[19..];
}

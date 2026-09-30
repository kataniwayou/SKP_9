namespace Messaging.Contracts.Projections;

/// <summary>
/// Which entity an L2 key names. The key layout carries a type segment (<c>wf:</c>, <c>step:</c>,
/// <c>proc:</c>) so a reader that knows only an id and its kind can address the one key that holds it.
/// </summary>
public enum L2EntityKind
{
    Workflow,
    Step,
    Processor,
}

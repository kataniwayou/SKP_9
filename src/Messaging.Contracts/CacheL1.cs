namespace Messaging.Contracts;

/// <summary>
/// One dictionary a workflow projects into L2 for the duration of a run, flattened for the wire.
/// <para>
/// The junction that binds it to the workflow is resolved before this record is built, so the
/// consumer never learns the junction exists — the same treatment the assignment payload gets.
/// </para>
/// </summary>
public sealed record CacheL1(string Root, Dictionary<string, string> Items);

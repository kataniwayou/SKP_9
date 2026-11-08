namespace Processor.Napole;

/// <summary>
/// What Elasticsearch shows of one execution across a tick's trail span (spec §4.3): counts only,
/// because the verdict needs nothing more and the report carries nothing more.
/// </summary>
/// <param name="Imports">kafka-importer <c>imported record …</c> lines. Exactly 1 is one run; 2 or more is two runs of one id mixed.</param>
/// <param name="OpenBranches">handed-off entry ids with no <c>the step returned</c> record for that entry.</param>
/// <param name="Terminals">records with <c>StepRole == terminal</c>.</param>
/// <param name="Failed">orchestrator outcomes with <c>Result == Failed</c>.</param>
/// <param name="Cancelled">orchestrator outcomes with <c>Result == Cancelled</c>.</param>
public sealed record ExecutionTrail(
    Guid ExecutionId, long Imports, long OpenBranches, long Terminals, long Failed, long Cancelled);

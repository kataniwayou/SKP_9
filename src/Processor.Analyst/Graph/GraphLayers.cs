using Messaging.Contracts;

namespace Processor.Analyst.Graph;

internal sealed record Handler(Guid StepId, StepResult Takes, IReadOnlyList<Guid> FanIn);

internal sealed record UnhandledResult(Guid StepId, StepResult Result);

/// <summary>
/// The graph read by entry condition (spec 4.2, D5): steps entered on Failed or Cancelled are
/// handlers, results no successor takes are unhandled, and every handler yields a conservation
/// equation the agent must check. Computed once, in code -- never left to the model.
/// </summary>
internal sealed record GraphLayers(
    IReadOnlyList<Handler> Handlers, IReadOnlyList<UnhandledResult> Unhandled, IReadOnlyList<string> Conservation)
{
    private static readonly StepResult[] Results = [StepResult.Completed, StepResult.Failed, StepResult.Cancelled];

    internal static GraphLayers Of(RunningGraph graph, Func<Guid, string> name)
    {
        var steps = graph.Steps.ToDictionary(s => s.StepId);

        var handlers = graph.Steps
            .Where(s => s.EntryCondition is (int)StepResult.Failed or (int)StepResult.Cancelled)
            .Select(s => new Handler(
                s.StepId,
                (StepResult)s.EntryCondition,
                [.. graph.Steps.Where(p => (p.NextStepIds ?? []).Contains(s.StepId)).Select(p => p.StepId)]))
            .ToList();

        var unhandled = graph.Steps
            .SelectMany(s => Results
                .Where(r => !(s.NextStepIds ?? []).Any(n => steps.TryGetValue(n, out var next) && GraphRenderer.Accepts(next.EntryCondition, r)))
                .Select(r => new UnhandledResult(s.StepId, r)))
            .ToList();

        var conservation = handlers
            .Where(h => h.Takes == StepResult.Failed && h.FanIn.Count > 0)
            .Select(h =>
            {
                var path = new List<Guid> { h.StepId };
                // Follow the handler's Completed route while it is a single successor.
                var cursor = steps[h.StepId];
                while ((cursor.NextStepIds ?? []).Where(n => steps.TryGetValue(n, out var x) && GraphRenderer.Accepts(x.EntryCondition, StepResult.Completed)).ToList() is [var only]
                       && !path.Contains(only))
                {
                    path.Add(only);
                    cursor = steps[only];
                }

                return $"Failed outcomes of the {h.FanIn.Count} steps routing Failed to {name(h.StepId)} "
                     + string.Concat(path.Select(p => $"= outcomes of {name(p)} "))
                     + "(a shortfall means the failure handling itself is losing failures)";
            })
            .ToList();

        return new GraphLayers(handlers, unhandled, conservation);
    }
}

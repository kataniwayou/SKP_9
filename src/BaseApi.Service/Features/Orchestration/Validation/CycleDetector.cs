using BaseApi.Service.Features.Orchestration;

namespace BaseApi.Service.Features.Orchestration.Validation;

/// <summary>
/// Cycle and missing-step validation gate — it owns both checks.
/// <para>
/// <b>Two-set iterative depth-first search:</b> traversal uses an explicit stack of frames plus two
/// bookkeeping sets — the nodes currently on the active path, and the nodes whose entire subtree has
/// been completed. A back-edge to a node on the active path is a cycle; an edge to a completed node
/// is a legal shared or fan-in subgraph. That second set is the discriminator: with a single visited
/// set, a diamond (A to B, A to C, B to D, C to D) would be falsely reported as a cycle.
/// </para>
/// <para>
/// <b>No recursion anywhere.</b> A crafted deep or cyclic graph would otherwise exhaust the call
/// stack, and a stack overflow cannot be caught by an exception handler — it terminates the process.
/// The explicit-stack form bounds traversal to the managed heap instead.
/// </para>
/// <para>
/// On a true cycle it reconstructs the offending chain from the active path and throws with it. On a
/// dangling next-step id it throws naming the parent and the missing child. A step with no next steps
/// is terminal and passes.
/// </para>
/// </summary>
internal sealed class CycleDetector
{
    /// <summary>
    /// Runs the two-set depth-first search over the snapshot's step graph, seeded from every
    /// workflow's entry steps. Throws on the first cycle or missing step encountered.
    /// <para>
    /// <b>Scope:</b> the search is seeded only from entry steps, so an orphan subgraph unreachable
    /// from any entry is intentionally not visited — an unreachable step can never execute and so
    /// cannot contribute a runtime cycle. The schema-edge and payload gates walk the full sets by
    /// contrast; that divergence is by design and documented on
    /// <see cref="WorkflowGraphSnapshot"/>. To extend this gate to orphan subgraphs, sweep the step
    /// keys not yet completed after the entry-seeded loop below.
    /// </para>
    /// </summary>
    public void Validate(WorkflowGraphSnapshot snapshot)
    {
        // Completed subtrees, shared across all entry seeds so a cleared subtree is never re-walked.
        var fullyVisited = new HashSet<Guid>();

        foreach (var workflow in snapshot.Workflows.Values)
        {
            foreach (var entryId in workflow.EntryStepIds ?? Enumerable.Empty<Guid>())
            {
                if (fullyVisited.Contains(entryId))
                {
                    continue;
                }

                // An entry step id that does not resolve is itself a missing step. There is no parent
                // here, so an empty GUID stands in as the parent for an entry-seed miss.
                if (!snapshot.Steps.ContainsKey(entryId))
                {
                    throw OrchestrationValidationException.MissingStep(Guid.Empty, entryId);
                }

                RunDfs(snapshot, entryId, fullyVisited);
            }
        }
    }

    /// <summary>
    /// Explicit-stack search from <paramref name="entryId"/>. The on-stack set tracks the active path
    /// for cycle detection, the path list tracks the same nodes in order so the offending chain can be
    /// reconstructed, and <paramref name="fullyVisited"/> records completed subtrees across seeds.
    /// </summary>
    private static void RunDfs(WorkflowGraphSnapshot snapshot, Guid entryId, HashSet<Guid> fullyVisited)
    {
        var stack = new Stack<(Guid Step, IEnumerator<Guid> Children)>();
        var onStack = new HashSet<Guid>();
        var path = new List<Guid>();

        Push(snapshot, entryId, stack, onStack, path);

        while (stack.Count > 0)
        {
            var (currentStep, children) = stack.Peek();

            if (children.MoveNext())
            {
                var child = children.Current;

                if (!snapshot.Steps.ContainsKey(child))
                {
                    // Referenced as a next step but absent from the graph.
                    throw OrchestrationValidationException.MissingStep(currentStep, child);
                }

                if (onStack.Contains(child))
                {
                    // Back-edge, so a cycle. Reconstruct it as the path slice from the first
                    // occurrence of the child to the end, then close the loop by appending it again.
                    var startIndex = path.IndexOf(child);
                    var cycleChain = new List<Guid>(path.GetRange(startIndex, path.Count - startIndex)) { child };
                    throw OrchestrationValidationException.Cycle(cycleChain);
                }

                if (!fullyVisited.Contains(child))
                {
                    // Unvisited node — descend.
                    Push(snapshot, child, stack, onStack, path);
                }

                // Otherwise the child is already complete, which is a legal shared or fan-in
                // subgraph. Skipping it here is what prevents the diamond false positive.
            }
            else
            {
                // Subtree exhausted — pop the frame and mark the step complete.
                stack.Pop();
                onStack.Remove(currentStep);
                path.RemoveAt(path.Count - 1);
                fullyVisited.Add(currentStep);
            }
        }
    }

    /// <summary>Pushes a new frame for <paramref name="step"/> and records it on the active path.</summary>
    private static void Push(
        WorkflowGraphSnapshot snapshot,
        Guid step,
        Stack<(Guid Step, IEnumerator<Guid> Children)> stack,
        HashSet<Guid> onStack,
        List<Guid> path)
    {
        var children = (snapshot.Steps[step].NextStepIds ?? new List<Guid>()).GetEnumerator();
        stack.Push((step, children));
        onStack.Add(step);
        path.Add(step);
    }
}

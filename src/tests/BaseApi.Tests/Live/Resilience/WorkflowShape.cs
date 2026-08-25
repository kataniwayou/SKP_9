namespace BaseApi.Tests.Live.Resilience;

/// <summary>
/// How many dispatches and terminals one fire of a workflow must produce.
/// <para>
/// A parameter rather than two constants inside the ledger: the ledger is a statement about any
/// workflow's round trip, and baking one graph's numbers into it would make every future workflow
/// need a second oracle.
/// </para>
/// </summary>
/// <param name="Dispatches">Step executions per fire -- one entry dispatch plus every handoff.</param>
/// <param name="Branches">
/// Sends per fire. NOT equal to <paramref name="Dispatches"/>: a step that fans out executes once and
/// sends more than once, and the framework writes one "branch completed" per SEND. Separating the two
/// is what lets a fan-out anywhere in the graph be described without the per-branch relations reading
/// a surplus as a lost step.
/// </param>
/// <param name="EntryBranches">
/// Sends from the entry step's single execution. The orchestrator reports one entry outcome per
/// BRANCH, not per dispatch, so this is what the entry-outcome relation is measured against -- and it
/// is 1 only for a graph whose entry step does not fan out.
/// </param>
/// <param name="Terminals">Branches that end without a successor.</param>
internal sealed record WorkflowShape(int Dispatches, int Branches, int EntryBranches, int Terminals)
{
    /// <summary>
    /// The seeded workflow: A - B - C - {D1,D2} - {E1,E2} - {F1,F2} - G, where G is reached from
    /// both F1 and F2 and so runs twice per lineage.
    /// <para>
    /// The entry step opens TWO lineages, seeded 100 and 200, so every step below A runs once per
    /// lineage: 1 entry execution + 8 steps x 2 + G x 4 = 21 executions from 20 handoffs. A sends two
    /// branches from its one execution, so branches are 22 rather than 21, and the four G branches are
    /// the terminals. The two lineages exist to prove L2 keys do not collide -- they arrive at Step_G
    /// carrying 107 and 207.
    /// </para>
    /// </summary>
    public static readonly WorkflowShape V8FanoutProof =
        new(Dispatches: 21, Branches: 22, EntryBranches: 2, Terminals: 4);

    /// <summary>
    /// The shape the <c>complete-run.json</c> fixture was captured under, back when the sample's entry
    /// step opened a single lineage: 11 executions, 11 branches, 1 entry branch, 2 terminals.
    /// <para>
    /// Named rather than folded into <see cref="V8FanoutProof"/> because a capture is a historical
    /// record and does not change when the live graph does. The hermetic oracle tests replay that
    /// capture, so they must be told the shape it actually had; pointing them at the live shape would
    /// make them fail for a reason that has nothing to do with the oracle they exist to test. The
    /// synthetic run in <c>RunClassifierTests</c> is built to these same numbers.
    /// </para>
    /// </summary>
    public static readonly WorkflowShape SingleLineageCapture =
        new(Dispatches: 11, Branches: 11, EntryBranches: 1, Terminals: 2);
}

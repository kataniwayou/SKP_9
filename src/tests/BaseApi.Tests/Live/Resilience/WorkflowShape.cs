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
/// <param name="Terminals">Branches that end without a successor.</param>
internal sealed record WorkflowShape(int Dispatches, int Terminals)
{
    /// <summary>
    /// The seeded workflow: A - B - C - {D1,D2} - {E1,E2} - {F1,F2} - G, where G is reached from
    /// both F1 and F2 and so runs twice. Eleven executions from ten assignments, two terminals.
    /// </summary>
    public static readonly WorkflowShape V8FanoutProof = new(Dispatches: 11, Terminals: 2);
}

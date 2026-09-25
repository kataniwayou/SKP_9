namespace Processor.Analyst.Loop;

/// <summary>
/// The three ceilings, enforced here rather than by the backend.
/// <para>
/// <b>Deliberately not backend-side task budgets.</b> Backend-side pacing is never load-bearing — a
/// backend that offered one could withdraw or ignore it without this ceiling ever noticing. A task
/// budget may still be set on the adapter as a pacing nicety — so the model wraps up rather than
/// being truncated mid-thought — but nothing depends on it.
/// </para>
/// </summary>
internal sealed class BudgetLedger(int maxIterations, int maxTokens, TimeSpan wallClock, TimeProvider clock)
{
    private readonly DateTimeOffset _deadline = clock.GetUtcNow() + wallClock;
    private int _iterations;
    private int _tokens;

    internal string? Why { get; private set; }

    internal bool Exhausted => Why is not null;

    /// <summary>Called before each model turn. Returns false when a ceiling is already reached.</summary>
    internal bool BeginTurn()
    {
        if (clock.GetUtcNow() >= _deadline)
        {
            Why = $"wall clock exhausted after {wallClock.TotalSeconds:F0}s";
            return false;
        }

        if (_iterations >= maxIterations)
        {
            Why = $"iteration cap of {maxIterations} reached";
            return false;
        }

        _iterations++;
        return true;
    }

    /// <summary>Called after each model turn with what it cost.</summary>
    internal void RecordUsage(int input, int output)
    {
        _tokens += input + output;

        if (_tokens > maxTokens && Why is null)
        {
            Why = $"token ceiling of {maxTokens} exceeded ({_tokens} used)";
        }
    }
}

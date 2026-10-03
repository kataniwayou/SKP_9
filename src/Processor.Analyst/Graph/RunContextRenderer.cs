using System.Globalization;
using Processor.Analyst.Panels;

namespace Processor.Analyst.Graph;

/// <summary>The run-context block of the first message: the window, the history limit and the deploys.</summary>
internal static class RunContextRenderer
{
    internal static string Render(RunContext ctx, TimeRange window, AnalystExpectations? expectations = null)
    {
        static string Z(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

        var lines = new List<string>
        {
            "<run-context>",
            $"Window under judgement: {Z(window.From)} to {Z(window.To)}.",
        };

        if (ctx.HistoryLimit is not { } limit)
        {
            lines.Add($"History is NOT available: {ctx.Unavailable}. Judge the window alone.");
        }
        else
        {
            lines.Add($"History available back to {Z(limit)} (the workflow's current start{(ctx.Start < limit ? ", capped at 30 days" : "")}). "
                + "Nothing before it was produced by this projection; history reads are clamped to it.");
            lines.Add(ctx.Deploys.Count == 0
                ? "No deploys inside that range."
                : "Deploys inside that range (orchestrator restarts; code and counter meanings may change at each): "
                  + string.Join(", ", ctx.Deploys.Select(d => d.Minute.UtcDateTime.ToString("HH:mm'Z' (yyyy-MM-dd)", CultureInfo.InvariantCulture)))
                  + ".");
        }

        lines.Add(expectations is null
            ? "No declared expectations: report every deterministic problem."
            : "Declared expectations (data-domain outcomes only; system problems are never covered): "
              + string.Join(", ", new[]
                {
                    expectations.MaxFailedShare is { } f ? $"failed share up to {f.ToString("0.##", CultureInfo.InvariantCulture)}" : null,
                    expectations.MaxCancelledShare is { } c ? $"cancelled share up to {c.ToString("0.##", CultureInfo.InvariantCulture)}" : null,
                }.Where(s => s is not null))
              + $" -- {expectations.Reason}.");

        lines.Add("</run-context>");
        return string.Join("\n", lines);
    }
}

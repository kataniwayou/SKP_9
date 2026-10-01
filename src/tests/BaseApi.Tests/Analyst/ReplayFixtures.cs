using System.Text.Json;
using Processor.Analyst.Panels;

namespace BaseApi.Tests.Analyst;

/// <summary>A captured window's identity and the truth about it, established apart from the panels.</summary>
internal sealed record ReplayWindow(Guid WorkflowId, DateTimeOffset From, DateTimeOffset To, string AnswerKey);

/// <summary>
/// Where captured replay windows live and how they are read back. Captures are real readings taken by
/// <c>AnalystReplayCapture</c>; scenarios start from one and plant a fault on top of it, so everything
/// but the planted panel is exactly what production returned.
/// </summary>
internal static class ReplayFixtures
{
    internal static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    /// <summary>The committed copy, for the capture to write into.</summary>
    internal static string SourceRoot()
        => Path.Combine(RepoRoot(), "src", "tests", "BaseApi.Tests", "Analyst", "Fixtures", "replay");

    internal static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);

        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "SK_P.sln")))
        {
            dir = dir.Parent;
        }

        if (dir is null)
        {
            throw new InvalidOperationException("SK_P.sln not found above the test output directory");
        }

        return dir.FullName;
    }

    /// <summary>The copy beside the test assembly, for a replay to read.</summary>
    private static string OutputRoot() => Path.Combine(AppContext.BaseDirectory, "Analyst", "Fixtures", "replay");

    internal static ReplayWindow Window(string name)
        => JsonSerializer.Deserialize<ReplayWindow>(File.ReadAllText(Path.Combine(OutputRoot(), name, "window.json")))!;

    /// <summary>
    /// A reader serving every captured panel exactly as it was read, described with the production
    /// registry's own text rather than a placeholder.
    /// </summary>
    internal static FixturePanelReader Reader(string name)
    {
        var reader = new FixturePanelReader();

        foreach (var file in Directory.EnumerateFiles(Path.Combine(OutputRoot(), name), "*.json"))
        {
            // Only files named for a registry panel: window.json and graph.json sit beside them.
            var panelId = Path.GetFileNameWithoutExtension(file);
            if (PanelRegistry.All.All(p => p.PanelId != panelId))
            {
                continue;
            }

            reader.Captured(JsonSerializer.Deserialize<PanelReading>(File.ReadAllText(file))!);
        }

        return reader;
    }
}

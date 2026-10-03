using System.Text.Json;
using Messaging.Contracts;
using Processor.Analyst.Bit;
using Processor.Analyst.Graph;
using Processor.Analyst.Panels;
using Microsoft.Extensions.Options;
using Xunit;

namespace BaseApi.Tests.Analyst;

/// <summary>
/// The rehearsal's invented evidence must be evidence a correct v12 investigation can reason about:
/// every count explained by the fixture graph's routing, and every reading in the shape the live panel
/// sources produce. A fixture that breaks either rule fails sound prompts -- the routing arithmetic a
/// v12 prompt is required to do would find a fault the scenario never planted.
/// </summary>
public sealed class RehearsalFixtureTests
{
    private static readonly DateTimeOffset To = new(2026, 10, 2, 18, 15, 0, TimeSpan.Zero);
    private static readonly TimeRange Window = new(To.AddMinutes(-15), To);

    public static TheoryData<string> Scenarios => new() { "quiet", "fault" };

    private static RehearsalPanels Scenario(string name)
        => name == "quiet" ? RehearsalPanels.Quiet() : RehearsalPanels.HoldingDiscardedWork();

    private static JsonElement Read(RehearsalPanels panels, string panelId) => Value(panels, panelId);

    private static JsonElement Value(IPanelReader reader, string panelId)
    {
        var reading = reader.ReadAsync(panelId, RehearsalGraph.Graph.WorkflowId, Window, history: false, CancellationToken.None)
            .GetAwaiter().GetResult();
        return JsonDocument.Parse(reading.ValueJson).RootElement;
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void EveryStepEntersExactlyTheItemsTheRoutingSendsIt(string scenario)
    {
        var panels = Scenario(scenario);
        var graph = RehearsalGraph.Graph;
        var ledger = panels.Ledger.ToDictionary(s => s.StepId);

        foreach (var step in graph.Steps)
        {
            var entered = ledger[step.StepId].Entered;

            if (graph.EntryStepIds.Contains(step.StepId))
            {
                // The importer writes one outcome per item imported and one per empty poll.
                Assert.Equal(RehearsalPanels.RecordsImported, ledger[step.StepId].Completed);
                Assert.Equal(RehearsalPanels.DrainedPolls, ledger[step.StepId].Cancelled);
                continue;
            }

            var routed = graph.Steps
                .Where(p => p.NextStepIds.Contains(step.StepId))
                .Sum(p => Routed(ledger[p.StepId], step.EntryCondition));

            Assert.Equal(routed, entered);
        }
    }

    private static int Routed(RehearsalStep from, int entryCondition)
        => (GraphRenderer.Accepts(entryCondition, StepResult.Completed) ? from.Completed : 0)
         + (GraphRenderer.Accepts(entryCondition, StepResult.Failed) ? from.Failed : 0)
         + (GraphRenderer.Accepts(entryCondition, StepResult.Cancelled) ? from.Cancelled : 0);

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void StepOutcomesAreTheLedgersTotals(string scenario)
    {
        var panels = Scenario(scenario);
        var value = Read(panels, "step-outcomes");

        Assert.Equal(panels.Ledger.Sum(s => s.Completed), value.GetProperty("completed").GetInt32());
        Assert.Equal(panels.Ledger.Sum(s => s.Failed), value.GetProperty("failed").GetInt32());
        Assert.Equal(panels.Ledger.Sum(s => s.Cancelled), value.GetProperty("cancelled").GetInt32());
        Assert.Equal(panels.Ledger.Sum(s => s.Outcomes), value.GetProperty("totalOutcomeRecords").GetInt32());
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void RunBoundariesCarriesOnlyTheTwoEdges(string scenario)
    {
        var panels = Scenario(scenario);
        var graph = RehearsalGraph.Graph;
        var value = Read(panels, "run-boundaries");
        var rows = value.GetProperty("byStep").EnumerateArray()
            .Select(r => (Role: r.GetProperty("role").GetString(), Step: r.GetProperty("step").GetString(),
                Records: r.GetProperty("records").GetInt32()))
            .ToList();

        // The orchestrator's rule, spelled out per step: persist-file's Completed outcomes advance
        // nowhere (its only successor takes Failed), and record-outcome has no successors at all.
        var good = scenario == "quiet" ? 34 : 17;
        var expected = new List<(string? Role, string? Step, int Records)>
            {
                (StepRoles.Entry, graph.Names[RehearsalGraph.ImportStep], RehearsalPanels.Fires),
                (StepRoles.Terminal, graph.Names[RehearsalGraph.PersistStep], good),
                (StepRoles.Terminal, graph.Names[RehearsalGraph.RecordStep], 6),
            }
            .OrderBy(r => r.Role).ThenBy(r => r.Step)
            .ToList();

        Assert.Equal(expected, rows.OrderBy(r => r.Role).ThenBy(r => r.Step).ToList());
        Assert.Equal(RehearsalPanels.Fires, value.GetProperty("fires").GetInt32());
        Assert.Equal(RehearsalPanels.Fires, value.GetProperty("importerPolls").GetInt32());
        Assert.Equal(RehearsalPanels.DrainedPolls, value.GetProperty("drainedPolls").GetInt32());
        Assert.Equal(RehearsalPanels.Fires - RehearsalPanels.DrainedPolls, value.GetProperty("pollsThatImported").GetInt32());
        Assert.Equal(RehearsalPanels.RecordsImported, value.GetProperty("recordsImported").GetInt32());
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void StepFailuresSampleOnlyStepsThatFailedAndBlameTheItem(string scenario)
    {
        var panels = Scenario(scenario);
        var value = Read(panels, "step-failures");
        var failing = panels.Ledger.Where(s => s.Failed > 0).Select(s => (string?)s.StepId.ToString("D")).ToHashSet();

        Assert.Equal(panels.Ledger.Sum(s => s.Failed), value.GetProperty("failedCount").GetInt32());

        var samples = value.GetProperty("samples").EnumerateArray().ToList();
        Assert.InRange(samples.Count, 1, 5);
        Assert.All(samples, s =>
        {
            Assert.Contains(s.GetProperty("attributes").GetProperty("StepId").GetString(), failing);
            Assert.Equal("Failed", s.GetProperty("attributes").GetProperty("Result").GetString());
        });
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void RefusalsAndDeadLetterGrowthAgreeWithWhatWasParked(string scenario)
    {
        var panels = Scenario(scenario);
        var parked = panels.Ledger.Sum(s => s.Parked);

        var refused = Read(panels, "refused-messages");
        Assert.Equal(parked, refused.GetProperty("parked").GetInt32());
        Assert.Equal(parked, refused.GetProperty("refusedCount").GetInt32());
        Assert.Equal(0, refused.GetProperty("notParked").GetInt32());

        var growth = Read(panels, "dead-letter-depth").GetProperty("series").EnumerateArray()
            .Sum(s =>
            {
                var points = s.GetProperty("points").EnumerateArray().ToList();
                return points[^1].GetProperty("value").GetInt32() - points[0].GetProperty("value").GetInt32();
            });
        Assert.Equal(parked, growth);
    }

    [Fact]
    public void TheQuietWindowParksNothingAndTheFaultWindowParksSeventeen()
    {
        Assert.Equal(0, RehearsalPanels.Quiet().Ledger.Sum(s => s.Parked));
        Assert.Equal(17, RehearsalPanels.HoldingDiscardedWork().Ledger.Sum(s => s.Parked));
    }

    [Fact]
    public void TheQuietWindowHoldsTheTrapsAPromptMustNotMistakeForFaults()
    {
        var panels = RehearsalPanels.Quiet();
        var terminalSteps = Read(panels, "run-boundaries").GetProperty("byStep").EnumerateArray()
            .Where(r => r.GetProperty("role").GetString() == StepRoles.Terminal)
            .Select(r => r.GetProperty("step").GetString())
            .ToList();

        // Item-caused failures, and empty-poll cancellations that end their branch with no terminal
        // record: the importer has successors, so a Cancelled outcome there is not an exit edge.
        Assert.True(panels.Ledger.Sum(s => s.Failed) > 0);
        Assert.True(RehearsalPanels.DrainedPolls > 0);
        Assert.DoesNotContain(RehearsalGraph.Graph.Names[RehearsalGraph.ImportStep], terminalSteps);
    }

    /// <summary>
    /// The rehearsal must look like the live sources, or a prompt is rehearsed against panels it will
    /// never read. The reference is the captured endless-feed-edges window, read from ES and Prometheus
    /// by the deployed panel sources.
    /// </summary>
    [Theory]
    [MemberData(nameof(Scenarios))]
    public void EveryReadingHasTheShapeTheLiveSourceProduces(string scenario)
    {
        var panels = Scenario(scenario);
        var captured = ReplayFixtures.Reader("endless-feed-edges");

        Assert.Equal(
            new[] { "dead-letter-depth", "failure-causes", "processor-liveness", "queue-wait", "refused-messages",
                    "run-boundaries", "step-failures", "step-outcomes" },
            panels.PanelIds.Order().ToArray());

        foreach (var panelId in panels.PanelIds)
        {
            var ours = Read(panels, panelId);

            if (panelId == "failure-causes")
            {
                // The captured window predates the panel, so the reference is the reading the live
                // source builds from the captured ES|QL tables.
                AssertFailureCausesShape(ours);
                continue;
            }

            var live = Value(captured, panelId);

            Assert.True(Keys(live).SetEquals(Keys(ours)), $"{panelId}: top-level keys differ");

            if (live.TryGetProperty("series", out var liveSeries))
            {
                var l = liveSeries[0];
                var o = ours.GetProperty("series")[0];
                Assert.True(Keys(l.GetProperty("labels")).SetEquals(Keys(o.GetProperty("labels"))), $"{panelId}: label keys differ");
                Assert.True(Keys(l.GetProperty("points")[0]).SetEquals(Keys(o.GetProperty("points")[0])), $"{panelId}: point keys differ");
            }

            if (panelId == "step-failures")
            {
                var l = live.GetProperty("samples")[0];
                var o = ours.GetProperty("samples")[0];
                Assert.True(Keys(l).SetEquals(Keys(o)), "step-failures: sample keys differ");
                Assert.True(Keys(l.GetProperty("attributes")).SetEquals(Keys(o.GetProperty("attributes"))),
                    "step-failures: sample attribute keys differ");
            }
        }
    }

    private static void AssertFailureCausesShape(JsonElement ours)
    {
        var live = LiveFailureCauses();
        Assert.True(Keys(live).SetEquals(Keys(ours)), "failure-causes: top-level keys differ");
        Assert.True(Keys(live.GetProperty("causes")[0]).SetEquals(Keys(ours.GetProperty("causes")[0])), "failure-causes: cause keys differ");
        Assert.True(Keys(live.GetProperty("buckets")[0]).SetEquals(Keys(ours.GetProperty("buckets")[0])), "failure-causes: bucket keys differ");
    }

    private static JsonElement LiveFailureCauses()
    {
        string Fixture(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Analyst", "Fixtures", name));

        var source = new ElasticPanelSource(
            new HttpClient(new CannedHandler(Fixture("esql-causes.json"), Fixture("esql-cause-buckets.json"))),
            Options.Create(new PanelSourceOptions { ElasticBaseUrl = "http://elasticsearch:9200" }));
        var definition = PanelRegistry.All.Single(p => p.PanelId == "failure-causes");
        var range = new TimeRange(new DateTimeOffset(2026, 10, 3, 7, 10, 0, TimeSpan.Zero), new DateTimeOffset(2026, 10, 3, 7, 25, 0, TimeSpan.Zero));

        var reading = source.ReadEsqlAsync(definition, RehearsalGraph.WorkflowId, range, CancellationToken.None).GetAwaiter().GetResult();
        return JsonDocument.Parse(reading.ValueJson).RootElement;
    }

    /// <summary>Answers successive requests with the given bodies.</summary>
    private sealed class CannedHandler(params string[] bodies) : HttpMessageHandler
    {
        private int _next;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent(bodies[_next++], System.Text.Encoding.UTF8, "application/json"),
            });
    }

    private static HashSet<string> Keys(JsonElement e) => e.EnumerateObject().Select(p => p.Name).ToHashSet();

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void TheSeriesPanelsCoverTheWindowTheyAreAskedAbout(string scenario)
    {
        var panels = Scenario(scenario);

        foreach (var panelId in new[] { "dead-letter-depth", "queue-wait", "processor-liveness" })
        {
            foreach (var series in Read(panels, panelId).GetProperty("series").EnumerateArray())
            {
                var points = series.GetProperty("points").EnumerateArray().ToList();
                Assert.Equal(Window.From, points[0].GetProperty("timestamp").GetDateTimeOffset());
                Assert.Equal(Window.To, points[^1].GetProperty("timestamp").GetDateTimeOffset());
            }
        }
    }

    [Fact]
    public void TheFixtureGraphRoutesCompletedItemsToNoTerminal()
    {
        var briefing = GraphRenderer.Render(GraphBriefing.Of(RehearsalGraph.Graph));

        // Labels are breadth-first: S3 is record-outcome, S4 persist-file. persist-file has only a
        // Failed successor, so a completed item's branch ends there with no terminal record -- the
        // edges model's central trap -- and record-outcome, with no successors, ends every branch.
        Assert.Contains("S3 record-outcome_1.0.0", briefing, StringComparison.Ordinal);
        Assert.Contains("S4 persist-file_1.0.0", briefing, StringComparison.Ordinal);
        Assert.Contains("S4: Completed -> branch ends | Failed -> S3 | Cancelled -> branch ends", briefing, StringComparison.Ordinal);
        Assert.Contains("S3: Completed -> branch ends | Failed -> branch ends | Cancelled -> branch ends", briefing, StringComparison.Ordinal);
        Assert.DoesNotContain("can never run", briefing, StringComparison.Ordinal);
    }

    [Fact]
    public void FailureCausesNamesTheItemAndPersistsSinceTheStart()
    {
        var panels = RehearsalPanels.RejectingBadInput();
        var value = Read(panels, "failure-causes");

        var cause = Assert.Single(value.GetProperty("causes").EnumerateArray());
        Assert.Equal("author-reported", cause.GetProperty("logged").GetString());
        Assert.Contains("extension", cause.GetProperty("cause").GetString(), StringComparison.Ordinal);
        Assert.Equal(6, cause.GetProperty("count").GetInt64());
    }

    [Fact]
    public async Task AHistoryReadShowsTheSameShareInEveryBucket()
    {
        var panels = RehearsalPanels.RejectingBadInput();
        var history = new TimeRange(RehearsalGraph.RunFor(To).HistoryLimit!.Value, To);
        var reading = await panels.ReadAsync("failure-causes", RehearsalGraph.WorkflowId, history, true, CancellationToken.None);

        var shares = JsonDocument.Parse(reading.ValueJson).RootElement.GetProperty("buckets").EnumerateArray()
            .Where(b => b.GetProperty("imported").GetInt64() > 0)
            .Select(b => b.GetProperty("failedShare").GetDouble()).Distinct().ToList();
        Assert.Equal([0.15], shares);
    }

    [Fact]
    public void OnlyTheQuietScenarioCarriesExpectations()
    {
        Assert.NotNull(RehearsalPanels.Quiet().Expectations);
        Assert.Null(RehearsalPanels.RejectingBadInput().Expectations);
        Assert.Null(RehearsalPanels.HoldingDiscardedWork().Expectations);
    }
}

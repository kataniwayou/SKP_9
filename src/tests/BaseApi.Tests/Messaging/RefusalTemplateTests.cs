using System.Text.Json;
using BaseApi.Tests.Live.Resilience;
using Messaging.Contracts;
using Xunit;

namespace BaseApi.Tests.Messaging;

/// <summary>
/// The refusal templates are a SELECTOR, not prose, and this pins every reader of them to the one
/// definition.
/// <para>
/// <b>Why a test and not a convention.</b> These two strings identify a refused message everywhere it
/// is visible: the Kibana refusals panel filters on them, the live suite's run classifier counts a
/// short ledger as legitimately parked by matching them, and the Analyst's refused-messages panel
/// selects on them. None of those readers shares a compiler with the emitter, so a one-byte edit to
/// the emitted template does not break a build -- it makes every one of those readers return zero
/// rows, silently, which reads exactly like a deployment that is refusing nothing.
/// </para>
/// <para>
/// They lived as four independent literals until the hoist:
/// <c>BaseApi.Core.Messaging.GatedQueueConsumer</c>, its <c>BaseConsole.Core</c> twin,
/// <c>Live/Resilience/Templates.cs</c> and <c>kibana/kibana-export.ndjson</c>. The first three now
/// read <see cref="RefusalTemplates"/>; the fourth is a JSON file no compiler can reach, so this
/// test is the only thing holding it to the others.
/// </para>
/// </summary>
public sealed class RefusalTemplateTests
{
    /// <summary>
    /// The dashboard export, found from the test binary rather than the working directory: the test
    /// host's cwd is the output folder, and the repo root is five levels up from it.
    /// </summary>
    private static string KibanaExportPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "kibana", "kibana-export.ndjson")))
        {
            dir = dir.Parent;
        }

        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "kibana", "kibana-export.ndjson");
    }

    [Fact]
    public void TheLiveSuiteCountsTheSameTemplatesTheConsumerEmits()
    {
        // Live/Resilience/Templates.cs is the run classifier's ledger. If it drifts from the emitter
        // the classifier reports a parked run as an unexplained short ledger -- a real fault and a
        // stale constant produce the identical verdict.
        Assert.Equal(RefusalTemplates.Parked, Templates.RefusingAndParking);
        Assert.Equal(RefusalTemplates.NotParked, Templates.RefusingNotParked);
    }

    [Fact]
    public void TheKibanaExportSelectsOnTheSameTemplatesTheConsumerEmits()
    {
        // The export stores the templates JSON-escaped (the em dash as \u2014, inside a
        // string-encoded filter blob), so the comparison has to be made in the export's own
        // encoding rather than by searching for the raw C# value.
        var export = File.ReadAllText(KibanaExportPath());

        foreach (var template in new[] { RefusalTemplates.Parked, RefusalTemplates.NotParked })
        {
            // JsonSerializer writes the em dash as an escape, matching how Kibana stored it; the
            // surrounding quotes are stripped, and the inner quoting doubles once more because the
            // filter blob is itself a JSON string inside the saved object.
            var encoded = JsonSerializer.Serialize(template).Trim('"');

            Assert.True(
                export.Contains(encoded, StringComparison.Ordinal)
                    || export.Contains(encoded.Replace("\\", "\\\\", StringComparison.Ordinal), StringComparison.Ordinal),
                $"kibana-export.ndjson no longer selects on '{template}' -- the refusals panel is " +
                "now filtering for a template nothing emits, which renders as an empty panel rather " +
                "than as an error.");
        }
    }

    [Fact]
    public void TheTwoTemplatesAreDistinguishableByMoreThanTheirPrefix()
    {
        // The Kibana session found this the expensive way: terming on attributes.{OriginalFormat}
        // truncated BOTH variants to "refusing message of type {Type} o", destroying the only
        // distinction the Outcome column exists to make. Any reader that splits these two apart has
        // to key on something past that prefix, so the shared prefix must stay short enough that the
        // difference is not purely in a tail a field-length limit can eat.
        Assert.StartsWith("refusing message of type {Type} on {Queue} \u2014 ", RefusalTemplates.Parked, StringComparison.Ordinal);
        Assert.StartsWith("refusing message of type {Type} on {Queue} \u2014 ", RefusalTemplates.NotParked, StringComparison.Ordinal);
        Assert.NotEqual(RefusalTemplates.Parked, RefusalTemplates.NotParked);

        // "parked" is a prefix of nothing else, but "NOT parked" CONTAINS "parked" -- so a reader
        // matching the parked template as a substring matches both. Pinned because that is the
        // subtle way a refusals panel over-counts parks.
        Assert.Contains("parked", RefusalTemplates.NotParked, StringComparison.Ordinal);
        Assert.False(
            RefusalTemplates.NotParked.Contains(RefusalTemplates.Parked, StringComparison.Ordinal),
            "the NOT-parked template contains the parked template verbatim, so any substring match " +
            "for a park now matches a non-park too");
    }
}

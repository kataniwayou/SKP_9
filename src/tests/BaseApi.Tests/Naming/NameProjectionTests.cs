using BaseApi.Service.Features.Orchestration;
using BaseApi.Service.Features.Orchestration.Projection;
using BaseApi.Service.Features.Processor;
using BaseApi.Service.Features.Step;
using BaseApi.Service.Features.Workflow;
using BaseApi.Tests.Support;
using Messaging.Contracts;
using Messaging.Contracts.Projections;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace BaseApi.Tests.Naming;

public sealed class NameProjectionTests
{
    private static readonly Guid W  = Guid.Parse("11111111-1111-1111-aaaa-111111111111");
    private static readonly Guid S1 = Guid.Parse("22222222-2222-2222-bbbb-222222222222");
    private static readonly Guid S2 = Guid.Parse("33333333-3333-3333-cccc-333333333333");
    private static readonly Guid P  = Guid.Parse("44444444-4444-4444-dddd-444444444444");

    private static WorkflowGraphSnapshot Snapshot()
    {
        var snapshot = new WorkflowGraphSnapshot(NullLogger<WorkflowGraphSnapshot>.Instance);
        var now = DateTime.UtcNow;

        snapshot.Workflows[W] = new WorkflowReadDto(
            W, "chain", "1.0.0", null, [S1], [], [], null, now, now, null, null);
        snapshot.Steps[S1] = new StepReadDto(S1, "step-a", "1.0.0", null, P, [S2], default, now, now, null, null);
        snapshot.Steps[S2] = new StepReadDto(S2, "step-b", "2.0.0", null, P, [], default, now, now, null, null);
        snapshot.Processors[P] = new ProcessorReadDto(
            P, "shared-proc", "1.2.0", null, "hash", null, null, null, null, now, now, null, null);

        return snapshot;
    }

    [Fact]
    public void TheDefinitionNamesEveryEntityOnce()
    {
        using var snapshot = Snapshot();

        var names = OrchestrationService.ToDefinitionForTests(snapshot, W).Names!;

        Assert.Equal(4, names.Count);   // one workflow, two steps, and ONE processor although two steps use it
        Assert.Equal(EntityNames.Format("chain", "1.0.0", W), names[W]);
        Assert.Equal(EntityNames.Format("step-b", "2.0.0", S2), names[S2]);
        Assert.Equal(EntityNames.Format("shared-proc", "1.2.0", P), names[P]);
    }

    [Fact]
    public async Task TheWriterPutsEveryNameUnderItsOwnKeyAndLeavesTheRootAlone()
    {
        using var snapshot = Snapshot();
        var definition = OrchestrationService.ToDefinitionForTests(snapshot, W);
        var l2 = new InMemoryL2();

        await new L2ProjectionWriter(l2.Multiplexer, new FakeTimeProvider()).WriteAsync(definition, CancellationToken.None);

        Assert.Equal(definition.Names![P], l2.Value(L2ProjectionKeys.Name(P)));
        Assert.Equal(definition.Names![S1], l2.Value(L2ProjectionKeys.Name(S1)));
        Assert.Equal(4, l2.Keys().Count(k => k.StartsWith("skp:name:", StringComparison.Ordinal)));
        Assert.DoesNotContain("chain_1.0.0", l2.Value(L2ProjectionKeys.Root(W)));
    }

    [Fact]
    public async Task ADefinitionWithoutNamesWritesNoNameKeys()
    {
        var l2 = new InMemoryL2();

        await new L2ProjectionWriter(l2.Multiplexer, new FakeTimeProvider())
            .WriteAsync(new WorkflowL1(W, [], null, [], []), CancellationToken.None);

        Assert.DoesNotContain(l2.Keys(), k => k.StartsWith("skp:name:", StringComparison.Ordinal));
        Assert.True(l2.Has(L2ProjectionKeys.Root(W)));
    }

    [Fact]
    public void NoProductionSourceScansTheKeySpace()
    {
        // Component 3's safety claim: the only KEYS/SCAN in production code is the orphan sweeper's
        // skp:proc:* pattern, which cannot match skp:name:*.
        //
        // ADAPTED from the brief: a bare "KeysAsync(" substring also matches
        // ListIndexKeysAsync's interface declaration, implementation and call site -- three false
        // positives that are not a scan call at all, just a method name that happens to end in those
        // characters. A negative lookbehind for a preceding letter excludes them while still catching
        // a genuine standalone KeysAsync(...) call, of which this codebase currently has none.
        var src = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var keysAsyncCall = new System.Text.RegularExpressions.Regex(@"(?<![A-Za-z])KeysAsync\(");
        var hits = Directory.EnumerateFiles(src, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}")
                        && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                        && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .SelectMany(f => File.ReadLines(f).Select(l => (f, l)))
            .Where(t => t.l.Contains(".Keys(pattern", StringComparison.Ordinal) || keysAsyncCall.IsMatch(t.l))
            .ToList();

        var only = Assert.Single(hits);

        // ADAPTED from the brief: the pattern is built as $"{L2ProjectionKeys.Prefix}proc:*", not the
        // literal string "skp:proc:*" -- Prefix is "skp:" (see L2ProjectionKeys), so this resolves to
        // exactly that pattern at runtime. Checked against the interpolation's own source text rather
        // than its resolved value, which a source scan cannot evaluate.
        Assert.Contains("Prefix}proc:*", only.l, StringComparison.Ordinal);
    }
}
